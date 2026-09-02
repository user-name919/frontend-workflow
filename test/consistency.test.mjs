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
  const changeDir = path.join(aiDir, 'changes/20260902-demo')
  await mkdir(changeDir, { recursive: true })
  await cp(path.join(repositoryRoot, 'template/.ai-dev/artifact-graph.json'), path.join(aiDir, 'artifact-graph.json'))
  await writeFile(path.join(changeDir, 'status.json'), `${JSON.stringify({
    id: '20260902-demo',
    title: 'Demo',
    state: 'IMPLEMENTING',
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

  const status = await markArtifactChanged(fixture.changeDir, 'frontend-spec.md', {
    now: () => new Date('2026-09-02T10:00:00.000Z')
  })

  assert.equal(status.state, 'IMPLEMENTING')
  assert.equal(status.consistency.revision, 1)
  assert.deepEqual(status.consistency.staleArtifacts, [
    'acceptance.md',
    'code-change.md',
    'implementation-plan.md',
    'tasks.md',
    'traceability.md',
    'verification.md'
  ])
  assert.deepEqual(status.consistency.lastChange, {
    artifact: 'frontend-spec.md',
    changedAt: '2026-09-02T10:00:00.000Z'
  })
  assert.equal(status.approvals.scope.approvedBy, 'scope-owner')
  assert.equal(status.approvals.spec, null)
  assert.equal(status.approvals.plan, null)
  assert.equal(status.approvals.final, null)
})

test('resolves only artifacts that the agent refreshed', async () => {
  const fixture = await makeChange()
  await markArtifactChanged(fixture.changeDir, 'implementation-plan.md')

  const status = await resolveArtifacts(fixture.changeDir, ['tasks.md', 'traceability.md'])

  assert.deepEqual(status.consistency.staleArtifacts, ['code-change.md', 'verification.md'])
  assert.equal(status.state, 'IMPLEMENTING')
})

test('validation rejects a review gate while downstream artifacts are stale', async () => {
  const fixture = await makeChange()
  await cp(path.join(repositoryRoot, 'template/.ai-dev/templates'), fixture.changeDir, { recursive: true })
  const statusPath = path.join(fixture.changeDir, 'status.json')
  const status = JSON.parse(await readFile(statusPath, 'utf8'))
  status.state = 'PLAN_REVIEW'
  status.approvals.scope = approval('scope-owner')
  status.approvals.spec = approval('spec-owner')
  status.consistency = {
    revision: 1,
    staleArtifacts: ['tasks.md'],
    lastChange: {
      artifact: 'implementation-plan.md',
      changedAt: '2026-09-02T10:00:00.000Z'
    }
  }
  await writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`)

  await assert.rejects(
    execFile('node', [
      path.join(repositoryRoot, 'template/.ai-dev/scripts/validate-change.mjs'),
      fixture.changeDir
    ]),
    error => error.code === 1 && /stale artifacts: tasks\.md/.test(error.stderr)
  )
})
