import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { cp, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import {
  markArtifactChanged,
  resolveArtifacts
} from '../template/.ai-dev/scripts/update-consistency.mjs'

const execFile = promisify(execFileCallback)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function approval(name) {
  return { approvedBy: name, approvedAt: '2026-09-02T08:00:00.000Z' }
}

async function makeChange() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'frontend-work-flow-state-'))
  const aiDir = path.join(root, '.ai-dev')
  const changeDir = path.join(aiDir, 'features/REQ-DEMO')
  await cp(path.join(repositoryRoot, 'template/.ai-dev/templates'), changeDir, { recursive: true })
  await mkdir(path.join(changeDir, 'revisions'), { recursive: true })
  await mkdir(path.join(changeDir, 'artifacts/coding-changes/coding'), { recursive: true })
  await cp(path.join(repositoryRoot, 'template/.ai-dev/artifact-graph.json'), path.join(aiDir, 'artifact-graph.json'))
  await writeFile(path.join(changeDir, 'status.json'), `${JSON.stringify({
    id: 'REQ-DEMO',
    title: 'Demo',
    idSource: 'user',
    externalIds: [],
    state: 'IMPLEMENTING',
    project: {
      root,
      branch: 'main',
      baseCommit: '0123456789abcdef',
      initialChanges: []
    },
    approvals: {
      scope: approval('scope-owner'),
      spec: approval('spec-owner'),
      plan: approval('plan-owner'),
      final: approval('final-owner')
    },
    consistency: {
      revision: 0,
      staleArtifacts: [],
      lastChange: null
    }
  }, null, 2)}\n`)
  return { root, changeDir }
}

test('marks transitive downstream artifacts stale without changing the workflow state', async () => {
  const fixture = await makeChange()

  const status = await markArtifactChanged(fixture.changeDir, 'artifacts/design/frontend-spec.md', {
    now: () => new Date('2026-09-02T10:00:00.000Z')
  })

  assert.equal(status.state, 'IMPLEMENTING')
  assert.equal(status.consistency.revision, 1)
  assert.deepEqual(status.consistency.staleArtifacts, [
    'artifacts/coding-changes/changed-files.json',
    'artifacts/coding-changes/changes.patch',
    'artifacts/design/acceptance.md',
    'artifacts/design/implementation-plan.md',
    'artifacts/design/tasks.md',
    'artifacts/design/traceability.md',
    'artifacts/verification/verification.md'
  ])
  assert.deepEqual(status.consistency.lastChange, {
    artifact: 'artifacts/design/frontend-spec.md',
    changedAt: '2026-09-02T10:00:00.000Z',
    revisionFile: 'revisions/revision-0001.json'
  })
  assert.equal(status.approvals.scope.approvedBy, 'scope-owner')
  assert.equal(status.approvals.spec, null)
  assert.equal(status.approvals.plan, null)
  assert.equal(status.approvals.final, null)

  const revision = JSON.parse(await readFile(path.join(fixture.changeDir, 'revisions/revision-0001.json'), 'utf8'))
  assert.equal(revision.revision, 1)
  assert.equal(revision.state, 'IMPLEMENTING')
  assert.equal(revision.changedArtifact, 'artifacts/design/frontend-spec.md')
  assert.deepEqual(revision.invalidatedApprovals, ['spec', 'plan', 'final'])
  assert.deepEqual(revision.resolvedArtifacts, [])
  assert.deepEqual(revision.remainingStaleArtifacts, status.consistency.staleArtifacts)
})

test('resolves only artifacts that the agent refreshed', async () => {
  const fixture = await makeChange()
  await markArtifactChanged(fixture.changeDir, 'artifacts/design/implementation-plan.md')

  const status = await resolveArtifacts(fixture.changeDir, [
    'artifacts/design/tasks.md',
    'artifacts/design/traceability.md'
  ], { now: () => new Date('2026-09-02T11:00:00.000Z') })

  assert.deepEqual(status.consistency.staleArtifacts, [
    'artifacts/coding-changes/changed-files.json',
    'artifacts/coding-changes/changes.patch',
    'artifacts/verification/verification.md'
  ])
  assert.equal(status.state, 'IMPLEMENTING')
  const revision = JSON.parse(await readFile(path.join(fixture.changeDir, 'revisions/revision-0001.json'), 'utf8'))
  assert.deepEqual(revision.resolvedArtifacts, [
    'artifacts/design/tasks.md',
    'artifacts/design/traceability.md'
  ])
  assert.equal(revision.resolvedAt, '2026-09-02T11:00:00.000Z')
  assert.deepEqual(revision.remainingStaleArtifacts, status.consistency.staleArtifacts)
})

test('validation rejects a review gate while downstream artifacts are stale', async () => {
  const fixture = await makeChange()
  const statusPath = path.join(fixture.changeDir, 'status.json')
  const status = JSON.parse(await readFile(statusPath, 'utf8'))
  status.state = 'PLAN_REVIEW'
  status.approvals.scope = approval('scope-owner')
  status.approvals.spec = approval('spec-owner')
  status.consistency = {
    revision: 1,
    staleArtifacts: ['artifacts/design/tasks.md'],
    lastChange: {
      artifact: 'artifacts/design/implementation-plan.md',
      changedAt: '2026-09-02T10:00:00.000Z',
      revisionFile: 'revisions/revision-0001.json'
    }
  }
  await writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`)

  await assert.rejects(
    execFile('node', [
      path.join(repositoryRoot, 'template/.ai-dev/scripts/validate-change.mjs'),
      fixture.changeDir
    ]),
    error => error.code === 1 && /stale artifacts: artifacts\/design\/tasks\.md/.test(error.stderr)
  )
})
