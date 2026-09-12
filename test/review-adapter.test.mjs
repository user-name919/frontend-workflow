import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import * as contract from '../.agents/skills/prepare-review/scripts/review-contract.mjs'
import { adaptDeliveryReview } from '../template/.ai-dev/scripts/lib/review-adapter.mjs'
import { gateAuthorized } from '../template/.ai-dev/scripts/lib/reviews.mjs'

function draft() {
  return {
    schemaVersion: 1,
    reviewId: 'R-1',
    stage: 'task',
    implementerId: 'writer-1',
    materials: [
      { id: 'M1', path: 'prd.md', role: 'requirement' },
      { id: 'M2', path: 'code.js', role: 'implementation' },
    ],
    requirements: [
      { id: 'FR-1', text: 'Skip occupied answers', status: 'confirmed', basis: ['M1'] },
    ],
    checks: [
      {
        id: 'C1',
        kind: 'acceptance',
        requirementIds: ['FR-1'],
        basis: ['M1'],
        scenario: 'two occupied then free',
        expected: 'return third',
        method: 'inspection',
      },
    ],
    questions: [],
  }
}

function deliveryReport(packet, overrides = {}) {
  return {
    schemaVersion: 1,
    reviewId: packet.reviewId,
    snapshotDigest: packet.snapshot.digest,
    reviewerId: 'reader-2',
    independence: 'independent',
    verdict: 'pass',
    summary: 'Matches inspected requirement',
    checks: [
      {
        checkId: 'C1',
        result: 'pass',
        evidence: [{ materialId: 'M2', location: 'line 1', observation: 'uses find' }],
      },
    ],
    findings: [],
    ...overrides,
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-adapter-'))
  await writeFile(path.join(root, 'prd.md'), 'Skip occupied answers')
  await writeFile(path.join(root, 'code.js'), 'answers.find(a => !a.locked)')
  const packet = await contract.sealPacket(draft(), root)
  return { root, packet }
}

test('adapted pass still does not authorize a gate by itself', async () => {
  const { root, packet } = await fixture()
  const request = {
    requestId: 'RV-1',
    gate: 'task',
    taskId: 'T1',
    packageId: 'R-1',
    snapshotId: 'SNAP-1',
    requiredRuleIds: ['SPEC-COVERAGE', 'CODE-QUALITY', 'NO-EXTRA-SCOPE', 'TEST-EVIDENCE'],
    implementerRunId: 'writer-1',
    host: 'assisted',
    model: 'test-model',
  }
  const adapted = await adaptDeliveryReview({
    packet,
    report: deliveryReport(packet),
    request,
    projectRoot: root,
  })
  assert.equal(adapted.contractOk, true)
  assert.equal(adapted.authorizesGate, false)
  assert.equal(adapted.workflowReport.verdict, 'pass')
  assert.equal(adapted.workflowReport.reviewer.independence, 'independent')
  assert.equal(
    gateAuthorized({ policy: { mode: 'strict' }, approvals: {} }, 'spec', adapted.workflowReport),
    false,
  )
})

test('needs_evidence and self_check cannot be treated as independent pass', async () => {
  const { root, packet } = await fixture()
  const request = {
    requestId: 'RV-1',
    gate: 'task',
    taskId: 'T1',
    packageId: 'R-1',
    snapshotId: 'SNAP-1',
    requiredRuleIds: ['SPEC-COVERAGE'],
    implementerRunId: 'writer-1',
  }

  const evidencePacket = structuredClone(packet)
  evidencePacket.questions = [
    {
      id: 'Q1',
      kind: 'evidence',
      blocking: true,
      text: 'missing test log',
      requirementIds: ['FR-1'],
      attempted: ['checked logs'],
    },
  ]
  // reseal because questions changed
  const { snapshot, ...content } = evidencePacket
  const resealed = await contract.sealPacket(content, root)
  const evidenceReport = deliveryReport(resealed, {
    snapshotDigest: resealed.snapshot.digest,
    verdict: 'needs_evidence',
    summary: 'need test output',
    checks: [
      {
        checkId: 'C1',
        result: 'unknown',
        reason: 'test not run',
      },
    ],
  })
  const evidence = await adaptDeliveryReview({
    packet: resealed,
    report: evidenceReport,
    request,
    projectRoot: root,
  })
  assert.equal(evidence.workflowAction, 'collect_evidence')
  assert.equal(evidence.authorizesGate, false)
  assert.notEqual(evidence.workflowReport.verdict, 'pass')

  const self = await adaptDeliveryReview({
    packet,
    report: deliveryReport(packet, { independence: 'self_check', reviewerId: 'reader-9' }),
    request,
    projectRoot: root,
  })
  assert.equal(self.workflowReport.reviewer.independence, 'self_check')
  assert.equal(self.workflowValidation.ok, false)
})
