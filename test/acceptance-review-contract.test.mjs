import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { realpath, writeFile } from 'node:fs/promises'
import { acceptanceFixture } from './helpers/acceptance.mjs'
import { runVerification } from '../template/.ai-dev/scripts/lib/verification.mjs'
import { sealPacket, verifyPacket, validateReport } from '../.agents/skills/prepare-review/scripts/review-contract.mjs'
import { observedEvidence } from './helpers/acceptance.mjs'

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
    ...run.cases.flatMap(tc => tc.visualEvidence.screenshots).map((image, index) => ({ id: `IMG-${index}`, role: 'verification', path: path.join(featureRelative, 'revisions/verifications', run.id, image.path) })),
  ], requirements: [{ id: 'FR-1', text: 'Show profile', status: 'confirmed', basis: ['P'] }], checks: [{ id: 'C', kind: 'acceptance', requirementIds: ['FR-1'], basis: ['P'], caseId: 'TC-1', method: 'test', scenario: 'Load profile', expected: 'Profile visible' }], questions: [] }
  const packet = await sealPacket(packetDraft, f.root)
  assert.deepEqual(await verifyPacket(packet, f.root), [])
  const report = { schemaVersion: 2, reviewId: 'R2', reviewerId: 'reviewer', snapshotDigest: packet.snapshot.digest, independence: 'independent', verdict: 'pass', summary: 'Protocol fixture', checks: [{ checkId: 'C', result: 'pass', evidence: [{ materialId: 'O', location: 'TC-1', observation: 'Recorded case passed' }], execution: { command: run.command, exitCode: 0, outputMaterialId: 'O' }, verificationRef: { caseId: 'TC-1', runId: run.id, recordMaterialId: 'R', outputMaterialId: 'O' } }], findings: [] }
  assert.deepEqual(await validateReport(packet, report, f.root), [])
  const missingImages = structuredClone(packetDraft)
  missingImages.materials = missingImages.materials.filter(item => !item.id.startsWith('IMG-'))
  const noImages = await sealPacket(missingImages, f.root)
  assert.ok((await validateReport(noImages, { ...report, snapshotDigest: noImages.snapshot.digest }, f.root)).some(error => error.code === 'SCREENSHOT_MATERIAL_MISSING'))
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

test('independent review rejects partial manual observations and login-only confirmations', async () => {
  const f=await acceptanceFixture()
  const tc={id:'M',method:'manual',preconditions:['current candidate','reference design available'],expectations:[{id:'layout'},{id:'brand'}]}
  await writeFile(path.join(f.root,'manual-delivery.json'),JSON.stringify({schemaVersion:2,testCases:[tc]}))
  const record={caseId:'M',method:'manual',result:'passed',confirmationRef:'explicit-acceptance',...observedEvidence(tc,'explicit-acceptance')}
  const packet={schemaVersion:2,reviewId:'MANUAL',stage:'final',implementerId:'author',snapshot:{digest:'snapshot'},deliveryMaterialId:'D',materials:[{id:'P',path:'prd.md',role:'requirement'},{id:'D',path:'manual-delivery.json',role:'implementation'},{id:'E',path:'manual.json',role:'verification'}],requirements:[{id:'FR-1',text:'Visual review',status:'confirmed',basis:['P']}],checks:[{id:'C',kind:'acceptance',caseId:'M',method:'manual',requirementIds:['FR-1'],basis:['P'],scenario:'Review candidate',expected:'Human confirms layout and brand'}],questions:[]}
  const report={schemaVersion:2,reviewId:'MANUAL',summary:'Synthetic protocol fixture',snapshotDigest:'snapshot',independence:'independent',reviewerId:'reviewer',verdict:'pass',checks:[{checkId:'C',result:'pass',confirmationRef:'explicit-acceptance',caseEvidenceMaterialId:'E',evidence:[{materialId:'E',location:'M',observation:'Every visual expectation explicitly accepted'}]}],findings:[]}
  await writeFile(path.join(f.root,'manual.json'),JSON.stringify(record))
  let sealed=await sealPacket(packet,f.root);report.snapshotDigest=sealed.snapshot.digest
  assert.deepEqual(await validateReport(sealed,report,f.root),[])
  for(const mutate of [r=>r.preconditionResults.pop(),r=>r.expectationResults.pop(),r=>delete r.expectationResults[0].observation,r=>delete r.confirmation.actor,r=>r.confirmation.kind='login']) {
    const copy=structuredClone(record);mutate(copy)
    await writeFile(path.join(f.root,'manual.json'),JSON.stringify(copy))
    sealed=await sealPacket(packet,f.root);report.snapshotDigest=sealed.snapshot.digest
    assert.ok((await validateReport(sealed,report,f.root)).some(e=>e.code==='INCOMPLETE_CASE_EVIDENCE'))
  }
})
