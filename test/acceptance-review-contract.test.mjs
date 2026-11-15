import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { realpath } from 'node:fs/promises'
import { acceptanceFixture } from './helpers/acceptance.mjs'
import { runVerification } from '../template/.ai-dev/scripts/lib/verification.mjs'
import { sealPacket, verifyPacket, validateReport } from '../.agents/skills/prepare-review/scripts/review-contract.mjs'

test('v2 review binds a case to actual record and output materials, with no method substitution', async () => {
  const f = await acceptanceFixture()
  const run = await runVerification(f.featureDir, { scope: 'feature', checkId: 'browser' })
  assert.equal(run.status, 'passed')
  const featureRelative = path.relative(await realpath(f.root), f.featureDir)
  const packetDraft = { schemaVersion: 2, reviewId: 'R2', stage: 'final', implementerId: 'author', deliveryMaterialId: 'D', materials: [
    { id: 'P', role: 'requirement', path: 'prd.md' },
    { id: 'D', role: 'implementation', path: path.join(featureRelative, 'artifacts/design/delivery.json') },
    { id: 'R', role: 'verification', path: path.join(featureRelative, `revisions/verifications/${run.id}/record.json`) },
    { id: 'O', role: 'verification', path: path.join(featureRelative, run.rawReportPath) },
  ], requirements: [{ id: 'FR-1', text: 'Show profile', status: 'confirmed', basis: ['P'] }], checks: [{ id: 'C', kind: 'acceptance', requirementIds: ['FR-1'], basis: ['P'], caseId: 'TC-1', method: 'test', scenario: 'Load profile', expected: 'Profile visible' }], questions: [] }
  const packet = await sealPacket(packetDraft, f.root)
  assert.deepEqual(await verifyPacket(packet, f.root), [])
  const report = { schemaVersion: 2, reviewId: 'R2', reviewerId: 'reviewer', snapshotDigest: packet.snapshot.digest, independence: 'independent', verdict: 'pass', summary: 'Protocol fixture', checks: [{ checkId: 'C', result: 'pass', evidence: [{ materialId: 'O', location: 'TC-1', observation: 'Recorded case passed' }], execution: { command: run.command, exitCode: 0, outputMaterialId: 'O' }, verificationRef: { caseId: 'TC-1', runId: run.id, recordMaterialId: 'R', outputMaterialId: 'O' } }], findings: [] }
  assert.deepEqual(await validateReport(packet, report, f.root), [])
  const wrong = structuredClone(report)
  wrong.checks[0].verificationRef.runId = 'other-run'
  assert.ok((await validateReport(packet, wrong, f.root)).some((error) => error.code === 'WRONG_CASE_EVIDENCE'))
  delete wrong.checks[0].verificationRef
  assert.ok((await validateReport(packet, wrong, f.root)).some((error) => error.code === 'MISSING_VERIFICATION_REF'))
  const substitution = structuredClone(packetDraft)
  substitution.checks[0].method = 'inspection'
  assert.ok((await verifyPacket(await sealPacket(substitution, f.root), f.root)).some((error) => error.code === 'CASE_METHOD_CHANGED'))
  substitution.checks[0].caseId = 'other-case'
  const missing = await verifyPacket(await sealPacket(substitution, f.root), f.root)
  assert.ok(missing.some((error) => error.code === 'UNCOVERED_CASE'))
})
