import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'

import { blockingStale, reconcileArtifacts, readGraph } from '../template/.ai-dev/scripts/lib/consistency.mjs'
import { createFeatureWorkspace } from '../template/.ai-dev/scripts/init-change.mjs'
import { recordHumanApproval } from '../template/.ai-dev/scripts/lib/workflow-state.mjs'
import { evaluateGate } from '../template/.ai-dev/scripts/lib/gates.mjs'
import { captureSnapshot, verifySnapshot } from '../template/.ai-dev/scripts/lib/snapshots.mjs'

const execFile = promisify(execFileCallback)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function git(cwd, ...args) {
  return execFile('git', args, { cwd })
}

test('blockingStale only returns gate-required artifacts', async () => {
  const graph = JSON.parse(
    await readFile(path.join(repositoryRoot, 'template/.ai-dev/artifact-graph.json'), 'utf8'),
  )
  const stale = ['artifacts/verification/verification.md']
  assert.deepEqual(
    blockingStale({ consistency: { staleArtifacts: stale } }, ['artifacts/analysis/scope.md'], graph),
    [],
  )
  assert.deepEqual(
    blockingStale({ consistency: { staleArtifacts: stale } }, ['artifacts/verification/verification.md'], graph),
    stale,
  )
})

async function makeFeature() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'frontend-work-flow-recon-'))
  await cp(path.join(repositoryRoot, 'template/.ai-dev'), path.join(projectRoot, '.ai-dev'), { recursive: true })
  await mkdir(path.join(projectRoot, 'src'), { recursive: true })
  await writeFile(path.join(projectRoot, 'src/app.js'), 'export {}\n')
  await git(projectRoot, 'init', '-b', 'main')
  await git(projectRoot, 'config', 'user.name', 'Test')
  await git(projectRoot, 'config', 'user.email', 't@example.com')
  await git(projectRoot, 'add', '.')
  await git(projectRoot, 'commit', '-m', 'init')
  const featureDir = await createFeatureWorkspace(projectRoot, {
    id: 'REQ-RECON',
    idSource: 'user',
    title: 'Reconcile',
  })
  return { featureDir, projectRoot }
}

function validIntake() {
  return {
    schemaVersion: 1,
    sources: [{ id: 'SRC-1', kind: 'prd', locator: 'p.md', version: '1', contentHash: null, availability: 'available' }],
    evidence: [{ id: 'EV-1', claim: 'c', label: 'CONFIRMED', sourceId: 'SRC-1', location: '1' }],
    requirements: [{
      id: 'FR-1',
      statement: 's',
      evidenceIds: ['EV-1'],
      ownership: 'FRONTEND_BEHAVIOR',
      disposition: 'included',
    }],
    questions: [],
  }
}

test('reconcile detects bypassed mark on spec and invalidates spec/plan/final not scope', async () => {
  const { featureDir } = await makeFeature()
  await writeFile(path.join(featureDir, 'artifacts/analysis/intake.json'), `${JSON.stringify(validIntake(), null, 2)}\n`)
  await writeFile(path.join(featureDir, 'artifacts/analysis/scope.md'), '# Scope\n\nFrontend owns it.\n')
  await writeFile(path.join(featureDir, 'artifacts/design/frontend-spec.md'), '# Spec\n\nBehavior A.\n')

  // Seed digests
  let status = await reconcileArtifacts(featureDir, { expectedVersion: 0 })
  // Move to SCOPE_REVIEW for approval
  const statusPath = path.join(featureDir, 'status.json')
  const prep = JSON.parse(await readFile(statusPath, 'utf8'))
  prep.state = 'SCOPE_REVIEW'
  await writeFile(statusPath, `${JSON.stringify(prep, null, 2)}\n`)

  status = await recordHumanApproval(featureDir, {
    gate: 'scope',
    actor: 'owner',
    decisionRef: 'd1',
    expectedVersion: prep.control.version,
  })
  assert.ok(status.approvals.scope.snapshotId)
  // Fake plan/spec approvals for invalidation check
  status = await reconcileArtifacts(featureDir, { expectedVersion: status.control.version })
  const disk = JSON.parse(await readFile(statusPath, 'utf8'))
  disk.approvals.spec = {
    approvedBy: 'a',
    approvedAt: '2026-09-12T00:00:00.000Z',
    decisionRef: 'x',
    snapshotId: status.approvals.scope.snapshotId,
  }
  disk.approvals.plan = {
    approvedBy: 'a',
    approvedAt: '2026-09-12T00:00:00.000Z',
    decisionRef: 'x',
    snapshotId: status.approvals.scope.snapshotId,
  }
  disk.approvals.final = {
    approvedBy: 'a',
    approvedAt: '2026-09-12T00:00:00.000Z',
    decisionRef: 'x',
    snapshotId: status.approvals.scope.snapshotId,
  }
  await writeFile(statusPath, `${JSON.stringify(disk, null, 2)}\n`)

  await writeFile(path.join(featureDir, 'artifacts/design/frontend-spec.md'), '# Spec\n\nBehavior B changed.\n')
  const after = await reconcileArtifacts(featureDir, { expectedVersion: disk.control.version })
  assert.equal(after.approvals.scope?.approvedBy, 'owner')
  assert.equal(after.approvals.spec, null)
  assert.equal(after.approvals.plan, null)
  assert.equal(after.approvals.final, null)
  assert.ok(after.consistency.staleArtifacts.length >= 1)

  const again = await reconcileArtifacts(featureDir, { expectedVersion: after.control.version })
  assert.equal(again.control.version, after.control.version)
})

test('future stale verification does not block scope gate', async () => {
  const { featureDir } = await makeFeature()
  await writeFile(path.join(featureDir, 'artifacts/analysis/intake.json'), `${JSON.stringify(validIntake(), null, 2)}\n`)
  await writeFile(path.join(featureDir, 'artifacts/analysis/scope.md'), '# Scope\n\nFrontend owns it.\n')
  const statusPath = path.join(featureDir, 'status.json')
  const status = JSON.parse(await readFile(statusPath, 'utf8'))
  status.consistency.staleArtifacts = ['artifacts/verification/verification.md']
  await writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`)
  const gate = await evaluateGate(featureDir, 'scope')
  assert.equal(gate.ok, true)
})

test('approval snapshot freshness gates plan after live delivery change', async () => {
  const { featureDir } = await makeFeature()
  await writeFile(path.join(featureDir, 'artifacts/analysis/intake.json'), `${JSON.stringify(validIntake(), null, 2)}\n`)
  await writeFile(path.join(featureDir, 'artifacts/analysis/scope.md'), '# Scope\n\nFrontend owns it.\n')
  await writeFile(path.join(featureDir, 'artifacts/design/frontend-spec.md'), '# Spec\n\nOK.\n')
  await writeFile(path.join(featureDir, 'artifacts/design/implementation-plan.md'), '# Plan\n\nOK.\n')
  await writeFile(
    path.join(featureDir, 'artifacts/design/delivery.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      acceptance: [{ id: 'AC-1', requirementIds: ['FR-1'], given: 'g', when: 'w', then: 't', verification: 'test' }],
      tasks: [{
        id: 'T1',
        title: 't',
        requirementIds: ['FR-1'],
        acceptanceIds: ['AC-1'],
        dependsOn: [],
        files: [{ path: 'src/app.js', operation: 'modify' }],
        steps: ['s'],
        verify: [{ command: 'node', args: ['-v'], cwd: '.' }],
      }],
      links: [{ requirementId: 'FR-1', acceptanceId: 'AC-1', taskId: 'T1' }],
    }, null, 2)}\n`,
  )

  let status = await reconcileArtifacts(featureDir, { expectedVersion: 0 })
  const statusPath = path.join(featureDir, 'status.json')
  const prep = JSON.parse(await readFile(statusPath, 'utf8'))
  prep.state = 'SCOPE_REVIEW'
  await writeFile(statusPath, `${JSON.stringify(prep, null, 2)}\n`)
  status = await recordHumanApproval(featureDir, {
    gate: 'scope',
    actor: 'owner',
    decisionRef: 'd1',
    expectedVersion: prep.control.version,
  })
  const approvedSnapshot = JSON.parse(
    await readFile(path.join(featureDir, 'revisions/snapshots', `${status.approvals.scope.snapshotId}.json`), 'utf8'),
  )
  await writeFile(path.join(featureDir, 'artifacts/analysis/scope.md'), '# Scope\n\nChanged after approval.\n')
  const check = await verifySnapshot(featureDir, approvedSnapshot)
  assert.equal(check.fresh, false)

  // Plan gate should fail due to stale scope approval snapshot
  const plan = await evaluateGate(featureDir, 'plan')
  assert.equal(plan.ok, false)
  assert.ok(plan.errors.some((e) => e.code === 'STALE_APPROVAL_SNAPSHOT'))
})
