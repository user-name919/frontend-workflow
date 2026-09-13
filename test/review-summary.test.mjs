import assert from 'node:assert/strict'
import test from 'node:test'

import { buildReviewSummary, renderReviewSummaryMarkdown } from '../template/.ai-dev/scripts/lib/review-summary.mjs'
import { shouldInjectReviewFollowup } from '../template/.ai-dev/scripts/lib/review-followup.mjs'

test('summary states pass, fail, and needs_human with next events', () => {
  const passed = buildReviewSummary({
    gate: 'task',
    taskId: 'T1',
    verdict: 'pass',
    checks: [{ ruleId: 'SPEC-COVERAGE', result: 'pass', evidence: ['AC-1'] }],
    findings: [],
  })
  assert.equal(passed.outcome, 'pass')
  assert.equal(passed.event.type, 'review.passed')
  assert.equal(passed.event.to, 'main')
  assert.match(renderReviewSummaryMarkdown(passed), /审核了哪些/)

  const failed = buildReviewSummary({
    gate: 'task',
    taskId: 'T1',
    verdict: 'revise',
    findings: [{ id: 'F-1', severity: 'major', ruleId: 'SPEC-COVERAGE', message: '没有重试', requiresHuman: false }],
  })
  assert.equal(failed.outcome, 'fail')
  assert.equal(failed.event.to, 'main')

  const human = buildReviewSummary({
    gate: 'task',
    taskId: 'T1',
    verdict: 'needs_human',
    findings: [{ id: 'F-2', severity: 'blocking', message: '重试次数产品未决', requiresHuman: true }],
  })
  assert.equal(human.outcome, 'needs_human')
  assert.equal(human.event.to, 'user')
  assert.ok(human.humanReasons.length)
})

test('stop hook injects once per review_pending key', () => {
  const status = {
    id: 'REQ-1',
    runtime: { taskResults: { T1: { status: 'review_pending', attemptId: 'A1' } } },
  }
  const first = shouldInjectReviewFollowup(status, [])
  assert.equal(first.inject, true)
  assert.equal(first.key, 'REQ-1:T1:A1')
  assert.equal(shouldInjectReviewFollowup(status, [first.key]).inject, false)
  assert.equal(shouldInjectReviewFollowup({ id: 'REQ-1', runtime: { taskResults: {} } }, []).inject, false)
})
