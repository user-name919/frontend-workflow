import assert from 'node:assert/strict'
import test from 'node:test'

import { validateReview, gateAuthorized } from '../template/.ai-dev/scripts/lib/reviews.mjs'

function baseRequest(overrides = {}) {
  return {
    requestId: 'RV-1',
    gate: 'task',
    taskId: 'T1',
    packageId: 'pkg-1',
    snapshotId: 'SNAP-1',
    requiredRuleIds: ['SPEC-COVERAGE', 'CODE-QUALITY'],
    implementerRunId: 'HOST-RUN-1',
    ...overrides,
  }
}

function validPassReport(overrides = {}) {
  return {
    schemaVersion: 1,
    requestId: 'RV-1',
    snapshotId: 'SNAP-1',
    reviewer: {
      runId: 'HOST-RUN-2',
      host: 'manual',
      model: 'test-model',
      independence: 'independent',
    },
    gate: 'task',
    taskId: 'T1',
    verdict: 'pass',
    specVerdict: 'pass',
    qualityVerdict: 'pass',
    checks: [
      { ruleId: 'SPEC-COVERAGE', result: 'pass', evidence: ['AC-1'] },
      { ruleId: 'CODE-QUALITY', result: 'pass', evidence: ['src/retry.js'] },
    ],
    findings: [],
    ...overrides,
  }
}

test('validateReview accepts a coherent pass and rejects contradictions', () => {
  const context = { request: baseRequest() }
  assert.equal(validateReview(validPassReport(), context).ok, true)

  const contradictoryReport = validPassReport({
    verdict: 'pass',
    findings: [
      {
        id: 'F-1',
        severity: 'major',
        ruleId: 'SPEC-COVERAGE',
        location: 'src/retry.js:12',
        message: 'missing retry',
        requestedChange: 'add retry',
        requiresHuman: false,
      },
    ],
  })
  assert.equal(validateReview(contradictoryReport, context).ok, false)
})

test('validateReview rejects missing rules, same implementer run, and quality-before-spec', () => {
  const context = { request: baseRequest() }
  assert.ok(
    validateReview(
      validPassReport({
        checks: [{ ruleId: 'SPEC-COVERAGE', result: 'pass', evidence: [] }],
      }),
      context,
    ).errors.some((e) => e.code === 'MISSING_REQUIRED_RULE'),
  )

  assert.ok(
    validateReview(
      validPassReport({
        reviewer: {
          runId: 'HOST-RUN-1',
          host: 'manual',
          model: 'm',
          independence: 'independent',
        },
      }),
      context,
    ).errors.some((e) => e.code === 'SAME_IMPLEMENTER_RUN'),
  )

  assert.ok(
    validateReview(
      validPassReport({
        specVerdict: 'fail',
        qualityVerdict: 'pass',
        verdict: 'revise',
        checks: [
          { ruleId: 'SPEC-COVERAGE', result: 'fail', evidence: ['FR-1'] },
          { ruleId: 'CODE-QUALITY', result: 'pass', evidence: [] },
        ],
        findings: [
          {
            id: 'F-1',
            severity: 'major',
            ruleId: 'SPEC-COVERAGE',
            location: 'unknown',
            message: 'gap',
            requestedChange: 'fix',
            requiresHuman: false,
          },
        ],
      }),
      context,
    ).errors.some((e) => e.code === 'QUALITY_BEFORE_SPEC' || e.code === 'QUALITY_MUST_NOT_RUN'),
  )
})

test('self_check cannot pass as independent; stage docs force quality not_run', () => {
  const taskContext = { request: baseRequest() }
  assert.ok(
    validateReview(
      validPassReport({
        reviewer: {
          runId: 'HOST-RUN-2',
          host: 'manual',
          model: 'm',
          independence: 'self_check',
        },
      }),
      taskContext,
    ).errors.some((e) => e.code === 'SELF_CHECK_NOT_INDEPENDENT'),
  )

  const specContext = {
    request: baseRequest({
      gate: 'spec',
      taskId: null,
      requiredRuleIds: ['SPEC-ACCEPTANCE'],
    }),
  }
  const stage = validPassReport({
    gate: 'spec',
    taskId: null,
    qualityVerdict: 'pass',
    checks: [{ ruleId: 'SPEC-ACCEPTANCE', result: 'pass', evidence: ['AC-1'] }],
  })
  assert.ok(validateReview(stage, specContext).errors.some((e) => e.code === 'STAGE_QUALITY_NOT_RUN'))
})

test('gateAuthorized respects strict vs delegated-review and never auto-final', () => {
  const validReview = validPassReport({ gate: 'spec', taskId: null })
  const strictStatus = {
    policy: { mode: 'strict', delegation: null },
    approvals: { scope: null, spec: null, plan: null, final: null },
    reviews: {},
  }
  assert.equal(gateAuthorized(strictStatus, 'spec', validReview), false)

  const delegatedSpecStatus = {
    policy: {
      mode: 'delegated-review',
      delegation: { gates: ['spec'], actor: 'lead', decisionRef: 'd1', at: '2026-09-12T00:00:00.000Z' },
    },
    approvals: { scope: null, spec: null, plan: null, final: null },
    reviews: {},
  }
  assert.equal(gateAuthorized(delegatedSpecStatus, 'spec', validReview), true)
  assert.equal(gateAuthorized(delegatedSpecStatus, 'final', validReview), false)
  assert.equal(
    gateAuthorized(delegatedSpecStatus, 'plan', validPassReport({ gate: 'plan', taskId: null })),
    false,
  )
})
