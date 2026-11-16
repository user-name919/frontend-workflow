/** Controller integration with simulated human/reviewer identities, not real approvals. */
import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { acceptanceFixture, observedEvidence, manualReason } from './helpers/acceptance.mjs'
import { writeReviewScheme } from './helpers/review-scheme.mjs'
import { renderFeatureArtifacts } from '../template/.ai-dev/scripts/render-artifacts.mjs'
import { runVerification } from '../template/.ai-dev/scripts/lib/verification.mjs'
import { recordCaseEvidence, writeJsonAtomic } from '../template/.ai-dev/scripts/lib/acceptance.mjs'
import { captureSnapshot } from '../template/.ai-dev/scripts/lib/snapshots.mjs'
import { readFeature, mutateFeature } from '../template/.ai-dev/scripts/lib/workspace-store.mjs'
import { transitionFeature, recordHumanApproval } from '../template/.ai-dev/scripts/lib/workflow-state.mjs'
import { acceptReview } from '../template/.ai-dev/scripts/lib/reviews.mjs'
import { evaluateGate } from '../template/.ai-dev/scripts/lib/gates.mjs'
import { reconcileArtifacts } from '../template/.ai-dev/scripts/lib/consistency.mjs'
import { resolveArtifacts } from '../template/.ai-dev/scripts/update-consistency.mjs'

async function syncResults(featureDir) {
  await reconcileArtifacts(featureDir)
  const status = await readFeature(featureDir)
  const stale = status.consistency.staleArtifacts
  assert.ok(stale.every((item) => item.startsWith('artifacts/verification/')), `Unexpected stale artifacts: ${stale}`)
  if (stale.length) await resolveArtifacts(featureDir, stale, { actor: 'fixture', expectedVersion: status.control.version })
}

test('CLI cannot skip acceptance; automatic readiness permits manual review and complete still requires confirmation/re-review', async () => {
  const f = await acceptanceFixture()
  f.delivery.acceptance.push({ id: 'AC-M', requirementIds: ['FR-1'], given: 'current candidate', when: 'human reads copy', then: 'copy confirmed', verification: 'manual' })
  f.delivery.tasks[0].acceptanceIds.push('AC-M')
  f.delivery.links.push({ requirementId: 'FR-1', acceptanceId: 'AC-M', taskId: 'T1' })
  f.delivery.testCases.push({ id: 'TC-M', acceptanceIds: ['AC-M'], method: 'manual', manualReason, environmentId: 'mock', requiredAt: ['feature'], preconditions: ['current candidate'], steps: ['read copy'], expectations: [{ id: 'E1', observable: 'ui', expected: 'copy confirmed' }] })
  await writeJsonAtomic(path.join(f.featureDir, 'artifacts/design/delivery.json'), f.delivery)
  await writeFile(path.join(f.featureDir, 'artifacts/design/frontend-spec.md'), '# Spec\nFR-1 AC-1 AC-M\n')
  await writeFile(path.join(f.featureDir, 'artifacts/design/implementation-plan.md'), '# Plan\nApply confirmed behavior.\n')
  await writeJsonAtomic(path.join(f.featureDir, 'artifacts/coding-changes/changed-files.json'), { files: [{ path: 'app.js' }] })
  await writeReviewScheme(f.featureDir)
  await renderFeatureArtifacts(f.featureDir)
  const approvals = {}
  for (const gate of ['scope', 'spec', 'plan']) {
    const snapshot = await captureSnapshot(f.featureDir, { gate })
    approvals[gate] = { approvedBy: 'simulated-human', approvedAt: new Date().toISOString(), decisionRef: 'test-fixture', snapshotId: snapshot.id }
  }
  await mutateFeature(f.featureDir, { expectedVersion: (await readFeature(f.featureDir)).control.version, event: { type: 'test.approvals', actor: 'fixture' } }, (draft) => { draft.approvals = { ...approvals, final: null } })
  const requestPath = path.join(f.featureDir, 'revisions/transition-request.json')
  await writeJsonAtomic(requestPath, { to: 'FINAL_REVIEW', actor: 'test', expectedVersion: (await readFeature(f.featureDir)).control.version })
  assert.throws(() => execFileSync(process.execPath, [path.resolve('template/.ai-dev/scripts/workflow-control.mjs'), f.featureDir, 'transition', '--request', requestPath], { stdio: 'pipe' }), (error) => error.status === 1 && /ACCEPTANCE_NOT_READY/.test(error.stderr.toString()))
  assert.equal((await readFeature(f.featureDir)).state, 'VERIFYING')
  const browser = await runVerification(f.featureDir, { scope: 'feature', checkId: 'browser' })
  await runVerification(f.featureDir, { scope: 'feature', checkId: 'lint' })
  await syncResults(f.featureDir)
  await mutateFeature(f.featureDir, { expectedVersion: (await readFeature(f.featureDir)).control.version, event: { type: 'test.repair', actor: 'fixture' } }, (draft) => { draft.runtime.taskResults.T1.status = 'running' })
  assert.ok((await evaluateGate(f.featureDir, 'final', { includeManual: false })).errors.some((item) => item.code === 'MISSING_EXECUTION_EVIDENCE'))
  await mutateFeature(f.featureDir, { expectedVersion: (await readFeature(f.featureDir)).control.version, event: { type: 'test.repair-complete', actor: 'fixture' } }, (draft) => { draft.runtime.taskResults.T1.status = 'passed' })
  await transitionFeature(f.featureDir, 'FINAL_REVIEW', { actor: 'test', expectedVersion: (await readFeature(f.featureDir)).control.version })
  assert.equal((await readFeature(f.featureDir)).state, 'FINAL_REVIEW')
  await assert.rejects(() => recordHumanApproval(f.featureDir, { gate: 'final', actor: 'simulated-human', decisionRef: 'test-message', expectedVersion: (0) }), { code: 'VERSION_CONFLICT' })
  await assert.rejects(async () => recordHumanApproval(f.featureDir, { gate: 'final', actor: 'simulated-human', decisionRef: 'test-message', expectedVersion: (await readFeature(f.featureDir)).control.version }), (error) => error.errors.some((item) => item.code === 'CASE_EVIDENCE_REQUIRED'))
  await recordCaseEvidence(f.featureDir, { ...observedEvidence(f.delivery.testCases.find(tc => tc.id === 'TC-M'), 'test-message-2'), caseId: 'TC-M', actor: 'simulated-human', observation: 'Protocol confirmation fixture', result: 'passed', confirmationRef: 'test-message-2', expectedSnapshotId: browser.inputSnapshotId, expectedVersion: (await readFeature(f.featureDir)).control.version })
  await syncResults(f.featureDir)
  await assert.rejects(async () => recordHumanApproval(f.featureDir, { gate: 'final', actor: 'simulated-human', decisionRef: 'test-final', expectedVersion: (await readFeature(f.featureDir)).control.version }), (error) => error.errors.some((item) => item.code === 'FINAL_REVIEW_REQUIRED'))
  const snapshot = await captureSnapshot(f.featureDir, { gate: 'final' })
  const request = { requestId: 'REVIEW-FINAL', gate: 'final', taskId: null, snapshotId: snapshot.id, implementerRunId: 'sim-implementer', requiredRuleIds: ['TEST-EVIDENCE'] }
  const report = { schemaVersion: 1, requestId: request.requestId, gate: 'final', taskId: null, snapshotId: snapshot.id, reviewer: { runId: 'sim-reviewer', host: 'fixture', model: 'protocol-simulation', independence: 'independent' }, verdict: 'pass', specVerdict: 'pass', qualityVerdict: 'pass', checks: [{ ruleId: 'TEST-EVIDENCE', result: 'pass', evidence: ['fixture'], verificationRefs: [{ caseId: 'TC-1', runId: browser.id, recordMaterialId: 'M-RUN', outputMaterialId: 'M-OUTPUT' }] }], findings: [] }
  await assert.rejects(async () => acceptReview(f.featureDir, { ...report, checks: [{ ...report.checks[0], verificationRefs: [] }] }, { request, expectedVersion: (await readFeature(f.featureDir)).control.version }), { code: 'MISSING_VERIFICATION_REF' })
  await acceptReview(f.featureDir, report, { request, expectedVersion: (await readFeature(f.featureDir)).control.version })
  await recordHumanApproval(f.featureDir, { gate: 'final', actor: 'simulated-human', decisionRef: 'test-final', expectedVersion: (await readFeature(f.featureDir)).control.version })
  await transitionFeature(f.featureDir, 'COMPLETE', { actor: 'test', expectedVersion: (await readFeature(f.featureDir)).control.version })
  assert.equal((await readFeature(f.featureDir)).state, 'COMPLETE')
})
