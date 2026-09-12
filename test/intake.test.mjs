import assert from 'node:assert/strict'
import test from 'node:test'

import { validateIntake, renderIntake } from '../template/.ai-dev/scripts/lib/intake.mjs'

function validIntake(overrides = {}) {
  return {
    schemaVersion: 1,
    sources: [
      {
        id: 'SRC-1',
        kind: 'prd',
        locator: 'inputs/prd.md',
        version: '1',
        contentHash: null,
        availability: 'available',
      },
    ],
    evidence: [
      {
        id: 'EV-1',
        claim: '请求失败后可重试',
        label: 'CONFIRMED',
        sourceId: 'SRC-1',
        location: '第2节',
      },
    ],
    requirements: [
      {
        id: 'FR-1',
        statement: '加载失败时展示重试按钮',
        evidenceIds: ['EV-1'],
        ownership: 'FRONTEND_BEHAVIOR',
        disposition: 'included',
      },
    ],
    questions: [],
    ...overrides,
  }
}

test('validateIntake accepts a valid ledger and rejects unknown source', () => {
  const inputWithMissingSource = validIntake({
    evidence: [
      {
        id: 'EV-1',
        claim: 'x',
        label: 'CONFIRMED',
        sourceId: 'SRC-MISSING',
        location: '1',
      },
    ],
  })
  const result = validateIntake(inputWithMissingSource)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.code === 'UNKNOWN_SOURCE'))
  assert.equal(validateIntake(validIntake()).ok, true)
})

test('validateIntake rejects duplicate ids and inferred-only included requirements', () => {
  const dup = validIntake({
    sources: [
      ...validIntake().sources,
      {
        id: 'SRC-1',
        kind: 'api',
        locator: 'a',
        version: '1',
        contentHash: null,
        availability: 'available',
      },
    ],
  })
  assert.ok(validateIntake(dup).errors.some((e) => e.code === 'DUPLICATE_ID'))

  const inferredOnly = validIntake({
    evidence: [
      {
        id: 'EV-1',
        claim: 'maybe',
        label: 'INFERRED',
        sourceId: 'SRC-1',
        location: 'x',
      },
    ],
  })
  assert.ok(validateIntake(inferredOnly).errors.some((e) => e.code === 'INFERRED_ONLY_REQUIREMENT'))
})

test('excluded OUT_OF_SCOPE with reason is allowed; resolved question needs decision evidence', () => {
  const excluded = validIntake({
    evidence: [
      {
        id: 'EV-2',
        claim: 'backend owns field',
        label: 'OUT_OF_SCOPE',
        sourceId: 'SRC-1',
        location: 'api',
      },
    ],
    requirements: [
      {
        id: 'FR-2',
        statement: 'backend field',
        evidenceIds: ['EV-2'],
        ownership: 'BACKEND_DATA',
        disposition: 'excluded',
        exclusionReason: 'Owned by backend service',
      },
    ],
  })
  assert.equal(validateIntake(excluded).ok, true)

  const badQuestion = validIntake({
    questions: [
      {
        id: 'Q1',
        text: 'Which repo?',
        blocking: true,
        owner: 'Product',
        status: 'resolved',
        blocksGates: ['scope'],
        decisionEvidenceIds: [],
      },
    ],
  })
  assert.ok(validateIntake(badQuestion).errors.some((e) => e.code === 'MISSING_DECISION_EVIDENCE'))
})

test('renderIntake escapes pipes/newlines and is byte-stable', () => {
  const intake = validIntake({
    evidence: [
      {
        id: 'EV-1',
        claim: 'line1\nline2 | pipe',
        label: 'CONFIRMED',
        sourceId: 'SRC-1',
        location: '§1',
      },
    ],
  })
  const first = renderIntake(intake)
  const second = renderIntake(intake)
  assert.equal(first['artifacts/analysis/evidence.md'], second['artifacts/analysis/evidence.md'])
  assert.match(first['artifacts/analysis/evidence.md'], /generated:from=artifacts\/analysis\/intake\.json/)
  assert.match(first['artifacts/analysis/evidence.md'], /line1 line2 \\| pipe/)
})
