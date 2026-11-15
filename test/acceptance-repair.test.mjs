import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { nextAction } from '../template/.ai-dev/scripts/lib/orchestrator.mjs'
import { acceptanceFixture } from './helpers/acceptance.mjs'
import { readFeature } from '../template/.ai-dev/scripts/lib/workspace-store.mjs'
import { captureSnapshot } from '../template/.ai-dev/scripts/lib/snapshots.mjs'
import { acceptReview } from '../template/.ai-dev/scripts/lib/reviews.mjs'
import { prepareTask } from '../template/.ai-dev/scripts/prepare-task.mjs'
import { startTask, acceptTaskResult, recoverReservation } from '../template/.ai-dev/scripts/lib/task-runs.mjs'
import { runVerification } from '../template/.ai-dev/scripts/lib/verification.mjs'
import { writeJsonAtomic } from '../template/.ai-dev/scripts/lib/acceptance.mjs'

function failureReport(request) {
  return { schemaVersion: 1, requestId: request.requestId, snapshotId: request.snapshotId, gate: request.gate, taskId: request.taskId, reviewer: { runId: 'fixture-reviewer', host: 'test', model: 'protocol-simulation', independence: 'independent' }, verdict: 'revise', specVerdict: 'fail', qualityVerdict: 'not_run', checks: [{ ruleId: 'BEHAVIOR', result: 'fail', evidence: ['protocol fixture'] }], findings: [{ id: 'F1', ruleId: 'BEHAVIOR', severity: 'major', location: 'app.js', message: 'Confirmed behavior still missing', requestedChange: 'Restore required behavior', requiresHuman: false }] }
}
async function failReview(f, gate, index) {
  const snapshot = await captureSnapshot(f.featureDir, { gate, taskId: gate === 'task' ? 'T1' : null })
  const request = { requestId: `R-${gate}-${index}`, snapshotId: snapshot.id, gate, taskId: gate === 'task' ? 'T1' : null, requiredRuleIds: ['BEHAVIOR'], implementerRunId: 'fixture-author', fixRound: 0 }
  return acceptReview(f.featureDir, failureReport(request), { request, expectedVersion: (await readFeature(f.featureDir)).control.version })
}

test('task repair/review takes precedence in both verification and final review', () => {
  for (const state of ['VERIFYING', 'FINAL_REVIEW']) {
    for (const [taskState, expected] of [['repairing', 'repair'], ['running', 'dispatch_implementer'], ['review_pending', 'dispatch_reviewer']]) {
      const status = { state, runtime: { taskResults: { T1: { status: taskState, reviewStatus: 'passed' } } }, control: { version: 1 } }
      const result = nextAction({ status, delivery: { schemaVersion: 2, tasks: [{ id: 'T1', dependsOn: [] }] }, acceptance: { ok: true } })
      assert.equal(result.type, expected, `${state}/${taskState}`)
      assert.equal(result.taskId, 'T1')
    }
  }
})

test('task fix rounds survive starting and accepting the next attempt', async () => {
  const f = await acceptanceFixture()
  await failReview(f, 'task', 1)
  assert.equal((await readFeature(f.featureDir)).runtime.taskResults.T1.fixRound, 1)
  await prepareTask(f.featureDir, 'T1', { attemptId: 'A2' })
  await startTask(f.featureDir, { taskId: 'T1', attemptId: 'A2', hostRunId: 'fixture-author', expectedVersion: (await readFeature(f.featureDir)).control.version })
  const runs = []
  for (const checkId of ['browser', 'lint']) runs.push(await runVerification(f.featureDir, { scope: 'task', taskId: 'T1', attemptId: 'A2', checkId }))
  await acceptTaskResult(f.featureDir, { taskId: 'T1', attemptId: 'A2', hostRunId: 'fixture-author', status: 'DONE', summary: 'fixture repair', changedFiles: ['app.js'], verificationIds: runs.map((run) => run.id), concerns: [] }, { expectedVersion: (await readFeature(f.featureDir)).control.version })
  assert.equal((await readFeature(f.featureDir)).runtime.taskResults.T1.fixRound, 1)
  await failReview(f, 'task', 2)
  assert.equal((await readFeature(f.featureDir)).runtime.taskResults.T1.fixRound, 2)
  await prepareTask(f.featureDir, 'T1', { attemptId: 'A3' })
  await startTask(f.featureDir, { taskId: 'T1', attemptId: 'A3', hostRunId: 'fixture-author', expectedVersion: (await readFeature(f.featureDir)).control.version })
  const running = (await readFeature(f.featureDir)).runtime.taskResults.T1
  assert.equal(running.resultRef, undefined, 'a repair must not inherit the previous result')
  assert.equal(running.verificationIds, undefined)
  await recoverReservation(f.featureDir, { confirmWorkerStopped: true, actor: 'fixture', expectedVersion: (await readFeature(f.featureDir)).control.version })
  assert.equal((await readFeature(f.featureDir)).runtime.taskResults.T1.status, 'pending')
  assert.equal((await readFeature(f.featureDir)).runtime.taskResults.T1.fixRound, 2)
})

test('durable task result after a ledger interruption is accepted without replaying checks', async () => {
  const f = await acceptanceFixture()
  await prepareTask(f.featureDir, 'T1', { attemptId: 'A2' })
  await startTask(f.featureDir, { taskId: 'T1', attemptId: 'A2', hostRunId: 'fixture-author', expectedVersion: (await readFeature(f.featureDir)).control.version })
  const runs = []
  for (const checkId of ['browser', 'lint']) runs.push(await runVerification(f.featureDir, { scope: 'task', taskId: 'T1', attemptId: 'A2', checkId }))
  const report = { taskId: 'T1', attemptId: 'A2', hostRunId: 'fixture-author', status: 'DONE', summary: 'durable result', changedFiles: ['app.js'], verificationIds: runs.map((run) => run.id), concerns: [] }
  await writeJsonAtomic(path.join(f.featureDir, 'revisions/tasks/T1/A2/result.json'), report)
  const accepted = await acceptTaskResult(f.featureDir, report, { expectedVersion: (await readFeature(f.featureDir)).control.version })
  assert.equal(accepted.runStatus, 'review_pending')
  assert.equal(accepted.idempotent, false)
  assert.equal(Object.keys(accepted.status.runtime.verifications).length, 2)
})

test('final repair accounting cannot be reset by a fresh request with fixRound=0', async () => {
  const f = await acceptanceFixture()
  for (let index = 1; index <= 4; index++) await failReview(f, 'final', index)
  const review = (await readFeature(f.featureDir)).reviews.final
  assert.equal(review.reviewDecision, 'ask_human')
  assert.equal(review.fixRound, 3)
})

test('test failures persist a repair budget without an intervening review', async () => {
  const f = await acceptanceFixture()
  for (let attempt = 0; attempt < 4; attempt++) await runVerification(f.featureDir, { scope: 'feature', checkId: 'lint', timeoutMs: 1 })
  let status = await readFeature(f.featureDir)
  assert.equal(status.runtime.verificationRepairs['feature:feature:lint'].fixRound, 3)
  assert.equal(nextAction({ status, delivery: f.delivery }).type, 'await_human')
  // An explicit diagnostic rerun may establish a clean result; automatic next had stopped.
  await runVerification(f.featureDir, { scope: 'feature', checkId: 'lint' })
  status = await readFeature(f.featureDir)
  assert.equal(status.runtime.verificationRepairs['feature:feature:lint'].consecutiveFailures, 0)
  assert.equal(nextAction({ status, delivery: f.delivery }).type, 'verify')
})
