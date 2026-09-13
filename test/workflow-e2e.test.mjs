/**
 * Protocol simulation with a fake worker. This is not a live multi-agent host run.
 */
import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'

import { createFeatureWorkspace } from '../template/.ai-dev/scripts/init-change.mjs'
import { nextAction } from '../template/.ai-dev/scripts/lib/orchestrator.mjs'
import { prepareTask } from '../template/.ai-dev/scripts/prepare-task.mjs'
import { acceptTaskResult, startTask } from '../template/.ai-dev/scripts/lib/task-runs.mjs'
import { acceptReview } from '../template/.ai-dev/scripts/lib/reviews.mjs'
import { runVerification } from '../template/.ai-dev/scripts/lib/verification.mjs'
import { captureSnapshot } from '../template/.ai-dev/scripts/lib/snapshots.mjs'
import { blockFeature, resumeFeature } from '../template/.ai-dev/scripts/lib/workflow-state.mjs'
import { mutateFeature, readFeature } from '../template/.ai-dev/scripts/lib/workspace-store.mjs'

const execFile = promisify(execFileCallback)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function git(cwd, ...args) {
  return execFile('git', args, { cwd })
}

function intake() {
  return {
    schemaVersion: 1,
    sources: [{ id: 'SRC-1', kind: 'prd', locator: 'p.md', version: '1', contentHash: null, availability: 'available' }],
    evidence: [{ id: 'EV-1', claim: 'retry then form', label: 'CONFIRMED', sourceId: 'SRC-1', location: '§1' }],
    requirements: [
      { id: 'FR-1', statement: 'retry', evidenceIds: ['EV-1'], ownership: 'FRONTEND_BEHAVIOR', disposition: 'included' },
      { id: 'FR-2', statement: 'form error', evidenceIds: ['EV-1'], ownership: 'FRONTEND_BEHAVIOR', disposition: 'included' },
    ],
    questions: [],
  }
}

function delivery() {
  return {
    schemaVersion: 1,
    acceptance: [
      { id: 'AC-1', requirementIds: ['FR-1'], given: 'fail', when: 'retry', then: 'request again', verification: 'test' },
      { id: 'AC-2', requirementIds: ['FR-2'], given: 'invalid', when: 'submit', then: 'show error', verification: 'test' },
    ],
    tasks: [
      {
        id: 'T1',
        title: 'retry',
        requirementIds: ['FR-1'],
        acceptanceIds: ['AC-1'],
        dependsOn: [],
        files: [{ path: 'src/retry.js', operation: 'modify' }],
        steps: ['retry'],
        verify: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }],
      },
      {
        id: 'T2',
        title: 'form',
        requirementIds: ['FR-2'],
        acceptanceIds: ['AC-2'],
        dependsOn: ['T1'],
        files: [{ path: 'src/form.js', operation: 'modify' }],
        steps: ['form'],
        verify: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }],
      },
    ],
    links: [
      { requirementId: 'FR-1', acceptanceId: 'AC-1', taskId: 'T1' },
      { requirementId: 'FR-2', acceptanceId: 'AC-2', taskId: 'T2' },
    ],
  }
}

async function makeFeature() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'frontend-work-flow-e2e-'))
  await cp(path.join(repositoryRoot, 'template/.ai-dev'), path.join(projectRoot, '.ai-dev'), { recursive: true })
  await mkdir(path.join(projectRoot, 'src'), { recursive: true })
  await writeFile(path.join(projectRoot, 'src/retry.js'), 'export function retry() {}\n')
  await writeFile(path.join(projectRoot, 'src/form.js'), 'export function form() {}\n')
  await git(projectRoot, 'init', '-b', 'main')
  await git(projectRoot, 'config', 'user.name', 'Test')
  await git(projectRoot, 'config', 'user.email', 't@example.com')
  await git(projectRoot, 'add', '.')
  await git(projectRoot, 'commit', '-m', 'init')
  const featureDir = await createFeatureWorkspace(projectRoot, {
    id: 'REQ-E2E',
    idSource: 'user',
    title: 'E2E protocol',
  })
  await writeFile(path.join(featureDir, 'artifacts/analysis/intake.json'), `${JSON.stringify(intake(), null, 2)}\n`)
  await writeFile(path.join(featureDir, 'artifacts/design/delivery.json'), `${JSON.stringify(delivery(), null, 2)}\n`)
  await writeFile(path.join(featureDir, 'artifacts/design/frontend-spec.md'), '# Spec\n\n## FR-1 retry\n\n## FR-2 form\n')
  await writeFile(path.join(featureDir, 'artifacts/design/implementation-plan.md'), '# Plan\n\n## T1 retry.js\n\n## T2 form.js\n')
  return { projectRoot, featureDir }
}

async function seedImplementing(featureDir) {
  const snapshot = await captureSnapshot(featureDir, {
    gate: 'plan',
    inputs: [{ space: 'feature', path: 'artifacts/design/delivery.json' }],
  })
  return mutateFeature(
    featureDir,
    { expectedVersion: (await readFeature(featureDir)).control.version, event: { type: 'test.seed', actor: 'fake-worker' } },
    (draft) => {
      draft.state = 'IMPLEMENTING'
      draft.approvals = {
        scope: { approvedBy: 'human', approvedAt: '2026-09-12T00:00:00.000Z', decisionRef: 's', snapshotId: snapshot.id },
        spec: { approvedBy: 'human', approvedAt: '2026-09-12T00:00:00.000Z', decisionRef: 'p', snapshotId: snapshot.id },
        plan: { approvedBy: 'human', approvedAt: '2026-09-12T00:00:00.000Z', decisionRef: 'l', snapshotId: snapshot.id },
        final: null,
      }
    },
  )
}

function passReport(request, extra = {}) {
  return {
    schemaVersion: 1,
    requestId: request.requestId,
    snapshotId: request.snapshotId,
    reviewer: { runId: 'REV-1', host: 'fake', model: 'protocol-sim', independence: 'independent' },
    gate: request.gate,
    taskId: request.taskId,
    verdict: 'pass',
    specVerdict: 'pass',
    qualityVerdict: request.gate === 'task' || request.gate === 'final' ? 'pass' : 'not_run',
    checks: request.requiredRuleIds.map((ruleId) => ({ ruleId, result: 'pass', evidence: ['sim'] })),
    findings: [],
    ...extra,
  }
}

test('protocol simulation: two tasks, spec fail repair, stale report, BLOCKED resume, final human', async () => {
  const { featureDir, projectRoot } = await makeFeature()
  let status = await seedImplementing(featureDir)
  const deliveryJson = delivery()

  let action = nextAction({ status, delivery: deliveryJson, capabilities: { freshContextDispatch: false } })
  assert.equal(action.type, 'dispatch_implementer')
  assert.equal(action.taskId, 'T1')
  assert.equal(action.capability, 'assisted')

  await prepareTask(featureDir, 'T1', { attemptId: 'A1' })
  await startTask(featureDir, {
    taskId: 'T1',
    attemptId: 'A1',
    hostRunId: 'IMPL-1',
    expectedVersion: (await readFeature(featureDir)).control.version,
  })
  await writeFile(path.join(projectRoot, 'src/retry.js'), 'export function retry() { return true }\n')
  await acceptTaskResult(
    featureDir,
    {
      taskId: 'T1',
      attemptId: 'A1',
      hostRunId: 'IMPL-1',
      status: 'DONE',
      summary: 'retry helper',
      changedFiles: ['src/retry.js'],
      verificationIds: [],
      concerns: [],
      exportedInterfaces: [{ contract: 'retry(fn)' }],
    },
    { expectedVersion: (await readFeature(featureDir)).control.version },
  )

  status = await readFeature(featureDir)
  action = nextAction({ status, delivery: deliveryJson })
  assert.equal(action.type, 'dispatch_reviewer')
  assert.equal(action.taskId, 'T1')

  const snap1 = await captureSnapshot(featureDir, {
    gate: 'task',
    taskId: 'T1',
    inputs: [{ space: 'project', path: 'src/retry.js', freshness: 'live' }],
    includeProjectDigest: true,
  })
  const request1 = {
    requestId: 'RV-T1',
    gate: 'task',
    taskId: 'T1',
    packageId: 'pkg-t1',
    snapshotId: snap1.id,
    requiredRuleIds: ['SPEC-COVERAGE', 'CODE-QUALITY'],
    implementerRunId: 'IMPL-1',
  }
  const failReport = passReport(request1, {
    verdict: 'revise',
    specVerdict: 'fail',
    qualityVerdict: 'not_run',
    checks: [
      { ruleId: 'SPEC-COVERAGE', result: 'fail', evidence: ['missing retry entry'] },
      { ruleId: 'CODE-QUALITY', result: 'not_run', evidence: ['spec failed'] },
    ],
    findings: [
      {
        id: 'F-1',
        severity: 'major',
        ruleId: 'SPEC-COVERAGE',
        location: 'src/retry.js',
        message: 'no retry entry',
        requestedChange: 'add retry',
        requiresHuman: false,
      },
    ],
  })
  status = await acceptReview(featureDir, failReport, {
    request: request1,
    expectedVersion: (await readFeature(featureDir)).control.version,
    snapshot: snap1,
  })
  assert.equal(status.runtime.taskResults.T1.status, 'repairing')
  assert.equal(status.runtime.taskResults.T1.escalateTo, 'main')
  action = nextAction({ status, delivery: deliveryJson })
  assert.equal(action.type, 'repair')

  await prepareTask(featureDir, 'T1', { attemptId: 'A2' })
  await startTask(featureDir, {
    taskId: 'T1',
    attemptId: 'A2',
    hostRunId: 'IMPL-2',
    expectedVersion: (await readFeature(featureDir)).control.version,
  })
  await acceptTaskResult(
    featureDir,
    {
      taskId: 'T1',
      attemptId: 'A2',
      hostRunId: 'IMPL-2',
      status: 'DONE',
      summary: 'fixed retry',
      changedFiles: ['src/retry.js'],
      verificationIds: [],
      concerns: [],
      exportedInterfaces: [{ contract: 'retry(fn)' }],
    },
    { expectedVersion: (await readFeature(featureDir)).control.version },
  )
  const snap1b = await captureSnapshot(featureDir, {
    gate: 'task',
    taskId: 'T1',
    inputs: [{ space: 'project', path: 'src/retry.js', freshness: 'live' }],
    includeProjectDigest: true,
  })
  const request1b = { ...request1, requestId: 'RV-T1B', snapshotId: snap1b.id }
  status = await acceptReview(featureDir, passReport(request1b), {
    request: request1b,
    expectedVersion: (await readFeature(featureDir)).control.version,
    snapshot: snap1b,
  })
  assert.equal(status.runtime.taskResults.T1.status, 'passed')
  assert.equal(status.runtime.taskResults.T1.escalateTo, 'none')

  action = nextAction({ status, delivery: deliveryJson })
  assert.equal(action.type, 'dispatch_implementer')
  assert.equal(action.taskId, 'T2')

  await prepareTask(featureDir, 'T2', { attemptId: 'A1' })
  await startTask(featureDir, {
    taskId: 'T2',
    attemptId: 'A1',
    hostRunId: 'IMPL-3',
    expectedVersion: (await readFeature(featureDir)).control.version,
  })
  await writeFile(path.join(projectRoot, 'src/form.js'), 'export function form() { return retry }\n')
  await acceptTaskResult(
    featureDir,
    {
      taskId: 'T2',
      attemptId: 'A1',
      hostRunId: 'IMPL-3',
      status: 'DONE',
      summary: 'form',
      changedFiles: ['src/form.js'],
      verificationIds: [],
      concerns: [],
    },
    { expectedVersion: (await readFeature(featureDir)).control.version },
  )
  const snap2 = await captureSnapshot(featureDir, {
    gate: 'task',
    taskId: 'T2',
    inputs: [{ space: 'project', path: 'src/form.js', freshness: 'live' }],
    includeProjectDigest: true,
  })
  const request2 = {
    requestId: 'RV-T2',
    gate: 'task',
    taskId: 'T2',
    packageId: 'pkg-t2',
    snapshotId: snap2.id,
    requiredRuleIds: ['SPEC-COVERAGE', 'CODE-QUALITY'],
    implementerRunId: 'IMPL-3',
  }
  status = await acceptReview(featureDir, passReport(request2), {
    request: request2,
    expectedVersion: (await readFeature(featureDir)).control.version,
    snapshot: snap2,
  })
  assert.equal(status.runtime.taskResults.T2.status, 'passed')
  action = nextAction({ status, delivery: deliveryJson })
  assert.equal(action.type, 'verify')

  const ver1 = await runVerification(featureDir, { taskId: 'T1', commandIndex: 0 })
  const ver2 = await runVerification(featureDir, { taskId: 'T2', commandIndex: 0 })
  assert.equal(ver1.status, 'passed')
  assert.equal(ver2.status, 'passed')

  status = await mutateFeature(
    featureDir,
    { expectedVersion: (await readFeature(featureDir)).control.version, event: { type: 'test.final', actor: 'fake-worker' } },
    (draft) => {
      draft.state = 'FINAL_REVIEW'
    },
  )
  action = nextAction({ status, delivery: deliveryJson })
  assert.equal(action.type, 'dispatch_reviewer')
  assert.equal(action.gate, 'final')

  const staleSnap = await captureSnapshot(featureDir, {
    gate: 'final',
    inputs: [{ space: 'feature', path: 'artifacts/verification/verification.md' }],
    includeProjectDigest: true,
  })
  await writeFile(path.join(featureDir, 'artifacts/verification/verification.md'), '# Verification\n\nchanged after snapshot\n')
  const staleRequest = {
    requestId: 'RV-STALE',
    gate: 'final',
    taskId: null,
    packageId: 'pkg-final',
    snapshotId: staleSnap.id,
    requiredRuleIds: ['FINAL-INTEGRATION'],
    implementerRunId: 'IMPL-3',
  }
  const staleVersion = (await readFeature(featureDir)).control.version
  await assert.rejects(
    () =>
      acceptReview(featureDir, passReport(staleRequest, { qualityVerdict: 'pass' }), {
        request: staleRequest,
        expectedVersion: staleVersion,
        snapshot: staleSnap,
      }),
    (error) => error.code === 'STALE_REVIEW_SNAPSHOT',
  )

  status = await blockFeature(featureDir, {
    reasonCode: 'HUMAN_PAUSE',
    requiredInput: 'confirm copy',
    actor: 'human',
    expectedVersion: (await readFeature(featureDir)).control.version,
  })
  action = nextAction({ status, delivery: deliveryJson })
  assert.equal(action.type, 'blocked')
  status = await resumeFeature(featureDir, {
    actor: 'human',
    expectedVersion: status.control.version,
  })
  assert.equal(status.state, 'FINAL_REVIEW')

  const finalSnap = await captureSnapshot(featureDir, {
    gate: 'final',
    inputs: [{ space: 'feature', path: 'artifacts/verification/verification.md' }],
    includeProjectDigest: true,
  })
  const finalRequest = {
    requestId: 'RV-FINAL',
    gate: 'final',
    taskId: null,
    packageId: 'pkg-final-2',
    snapshotId: finalSnap.id,
    requiredRuleIds: ['FINAL-INTEGRATION', 'FINAL-TRACE', 'FINAL-QUALITY', 'FINAL-HUMAN-ITEMS'],
    implementerRunId: 'IMPL-3',
  }
  await acceptReview(featureDir, passReport(finalRequest), {
    request: finalRequest,
    expectedVersion: (await readFeature(featureDir)).control.version,
    snapshot: finalSnap,
  })
  status = await readFeature(featureDir)
  action = nextAction({ status, delivery: deliveryJson })
  assert.equal(action.type, 'await_human')
  assert.equal(action.gate, 'final')
})
