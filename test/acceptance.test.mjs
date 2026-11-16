import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { acceptanceFixture, playwrightReport, observedEvidence, manualReason } from './helpers/acceptance.mjs'
import { validateDelivery } from '../template/.ai-dev/scripts/lib/delivery.mjs'
import { draftDeliveryUpgrade } from '../template/.ai-dev/scripts/lib/acceptance-plan.mjs'
import { acceptanceReadiness, recordCaseEvidence, captureVerificationSnapshot, writeJsonAtomic } from '../template/.ai-dev/scripts/lib/acceptance.mjs'
import { runVerification, recoverVerification } from '../template/.ai-dev/scripts/lib/verification.mjs'
import { readFeature, mutateFeature } from '../template/.ai-dev/scripts/lib/workspace-store.mjs'
import { prepareTask } from '../template/.ai-dev/scripts/prepare-task.mjs'
import { startTask, acceptTaskResult } from '../template/.ai-dev/scripts/lib/task-runs.mjs'
import { renderFeatureArtifacts } from '../template/.ai-dev/scripts/render-artifacts.mjs'

const save = (f) => writeJsonAtomic(path.join(f.featureDir, 'artifacts/design/delivery.json'), f.delivery)
const run = (f, checkId = 'browser', extra = {}) => runVerification(f.featureDir, { scope: 'feature', checkId, ...extra })

test('spec renders source-backed ACs before plan cases or test implementations exist', async () => {
  const f = await acceptanceFixture()
  f.delivery.tasks = []
  f.delivery.links = []
  f.delivery.testCases = []
  f.delivery.verification = { inputs: [], environments: [], checks: [], finalCheckIds: [] }
  await save(f)
  const files = await renderFeatureArtifacts(f.featureDir, { phase: 'spec' })
  assert.ok(files.includes('artifacts/design/acceptance.md'))
  assert.ok(!files.includes('artifacts/design/tasks.md'))
  await assert.rejects(() => renderFeatureArtifacts(f.featureDir, { phase: 'plan' }), { code: 'INVALID_DELIVERY' })
})

test('v2 rejects lost ACs, invented methods, unscheduled cases and engineering-as-acceptance', async () => {
  const f = await acceptanceFixture()
  assert.equal(validateDelivery(f.intake, f.delivery).ok, true)
  for (const mutate of [
    (d) => { d.testCases = [] },
    (d) => { d.testCases[0].method = 'unit' },
    (d) => { d.verification.finalCheckIds = ['lint'] },
    (d) => { d.verification.checks[0].kind = 'engineering' },
    (d) => { d.testCases[0].environmentId = 'unknown' },
    (d) => { d.testCases.push({ ...d.testCases[0], id: 'TC-duplicate' }) },
  ]) {
    const delivery = structuredClone(f.delivery)
    mutate(delivery)
    assert.equal(validateDelivery(f.intake, delivery).ok, false)
  }
  const draft = draftDeliveryUpgrade({ schemaVersion: 1, acceptance: f.delivery.acceptance, tasks: [{ ...f.delivery.tasks[0], verify: [{ command: 'node', args: ['--version'] }] }], links: f.delivery.links })
  assert.equal(draft.schemaVersion, 2)
  assert.deepEqual(draft.testCases, [])
  assert.equal(validateDelivery(f.intake, draft).ok, false)
})

test('partial pass, new failure, stale inputs and edited raw output cannot admit a feature', async () => {
  const f = await acceptanceFixture()
  const first = await run(f)
  assert.equal(first.status, 'passed', first.summary)
  assert.equal((await acceptanceReadiness(f.featureDir)).ok, false, 'lint is still missing')
  await run(f, 'lint')
  assert.equal((await acceptanceReadiness(f.featureDir)).ok, true)
  await writeFile(path.join(f.root, 'app.js'), 'export const result = false\n')
  assert.equal((await acceptanceReadiness(f.featureDir)).ok, false, 'source changed after pass')
  await writeFile(path.join(f.root, 'app.js'), 'export const result = true\n')
  assert.equal((await acceptanceReadiness(f.featureDir)).ok, true)
  await writeFile(path.join(f.featureDir, first.rawReportPath), '{}')
  assert.equal((await acceptanceReadiness(f.featureDir)).ok, false, 'raw report edited under excluded workflow directory')
  await run(f)
  const next = await run(f, 'browser', { timeoutMs: 1 })
  assert.notEqual(next.status, 'passed')
  assert.equal((await acceptanceReadiness(f.featureDir)).ok, false, 'older pass cannot mask newer failure')
})

test('zero-exit without fresh report or with only skipped tests never proves acceptance', async () => {
  const f = await acceptanceFixture()
  f.delivery.verification.checks[0].args = ['-e', 'process.exit(0)']
  await save(f)
  assert.equal((await run(f)).status, 'unverified')
  const skipped = playwrightReport(f.root, ['TC-1'], { status: 'skipped', attachments: [] })
  f.delivery.verification.checks[0].args = ['-e', `require('fs').writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, ${JSON.stringify(JSON.stringify(skipped))})`]
  await save(f)
  assert.notEqual((await run(f)).status, 'passed')
})

test('manual evidence is separate, candidate-bound, and never an approval', async () => {
  const f = await acceptanceFixture()
  f.delivery.acceptance.push({ id: 'AC-M', requirementIds: ['FR-1'], given: 'profile', when: 'human reads', then: 'copy confirmed', verification: 'manual' })
  f.delivery.tasks[0].acceptanceIds.push('AC-M')
  f.delivery.links.push({ requirementId: 'FR-1', acceptanceId: 'AC-M', taskId: 'T1' })
  f.delivery.testCases.push({ id: 'TC-M', acceptanceIds: ['AC-M'], method: 'manual', manualReason, environmentId: 'mock', requiredAt: ['feature'], preconditions: ['current profile'], steps: ['read copy'], expectations: [{ id: 'M1', observable: 'ui', expected: 'copy approved' }] })
  await save(f)
  const automatic = await run(f)
  await run(f, 'lint')
  assert.equal((await acceptanceReadiness(f.featureDir, { includeManual: false })).ok, true)
  assert.equal((await acceptanceReadiness(f.featureDir)).ok, false)
  const request = { ...observedEvidence(f.delivery.testCases.find(tc => tc.id === 'TC-M')), caseId: 'TC-M', actor: 'test-human', observation: 'Protocol simulation only', result: 'passed', confirmationRef: 'test-message-1', expectedSnapshotId: automatic.inputSnapshotId, expectedVersion: (await readFeature(f.featureDir)).control.version }
  await assert.rejects(() => recordCaseEvidence(f.featureDir, { ...request, confirmationRef: null }), { code: 'MISSING_CONFIRMATION' })
  await recordCaseEvidence(f.featureDir, request)
  assert.equal((await acceptanceReadiness(f.featureDir)).ok, true)
  assert.equal((await readFeature(f.featureDir)).approvals.final, null)
  await writeFile(path.join(f.root, 'fixture.json'), '{"name":"Grace"}')
  assert.equal((await acceptanceReadiness(f.featureDir)).ok, false)
})

test('DONE waits for every task check and rejects stale/idempotent replay evidence', async () => {
  const f = await acceptanceFixture()
  await prepareTask(f.featureDir, 'T1', { attemptId: 'A2' })
  await startTask(f.featureDir, { taskId: 'T1', attemptId: 'A2', hostRunId: 'test-worker', expectedVersion: (await readFeature(f.featureDir)).control.version })
  const browser = await run(f, 'browser', { scope: 'task', taskId: 'T1', attemptId: 'A2' })
  const report = { taskId: 'T1', attemptId: 'A2', hostRunId: 'test-worker', status: 'DONE', summary: 'fixture', changedFiles: ['app.js'], verificationIds: [browser.id], concerns: [] }
  const accept = () => readFeature(f.featureDir).then((status) => acceptTaskResult(f.featureDir, report, { expectedVersion: status.control.version }))
  await assert.rejects(accept, { code: 'ACCEPTANCE_NOT_READY' })
  assert.equal((await readFeature(f.featureDir)).runtime.taskResults.T1.status, 'running')
  const lint = await run(f, 'lint', { scope: 'task', taskId: 'T1', attemptId: 'A2' })
  report.verificationIds.push(lint.id)
  assert.equal((await accept()).runStatus, 'review_pending')
  assert.equal((await accept()).idempotent, true)
  assert.equal((await acceptanceReadiness(f.featureDir)).ok, false, 'task evidence cannot substitute final scope')
  await writeFile(path.join(f.root, 'app.js'), 'changed')
  await assert.rejects(accept, { code: 'ACCEPTANCE_NOT_READY' })
})

test('a completed run survives ledger CAS conflict without replaying the process', async () => {
  const f = await acceptanceFixture()
  f.delivery.verification.checks[1].args = ['-e', 'setTimeout(() => process.exit(0), 700)']
  await save(f)
  const executing = run(f, 'lint')
  // Wait for the durable running reference; this is the intentionally raced writer.
  let status
  for (let n = 0; n < 100; n++) {
    status = await readFeature(f.featureDir)
    if (Object.values(status.runtime.verifications || {}).some((ref) => ref.status === 'running')) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  await mutateFeature(f.featureDir, { expectedVersion: status.control.version, event: { type: 'test.concurrent', actor: 'test' } }, (draft) => { draft.testConcurrent = true })
  await assert.rejects(() => executing, { code: 'VERSION_CONFLICT' })
  status = await readFeature(f.featureDir)
  const ref = Object.values(status.runtime.verifications)[0]
  assert.equal(ref.status, 'running')
  assert.equal((await acceptanceReadiness(f.featureDir)).ok, false)
  const recovered = await recoverVerification(f.featureDir, { runId: ref.id, actor: 'test', expectedVersion: status.control.version, confirmWorkerStopped: true })
  assert.equal(recovered.record.status, 'passed')
  assert.equal(Object.keys(recovered.status.runtime.verifications).length, 1)
})
