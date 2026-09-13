import assert from 'node:assert/strict'
import test from 'node:test'

import { decideReviewAction, summarizeReReview } from '../template/.ai-dev/scripts/lib/review-loop.mjs'

const majorFailure = {
  verdict: 'revise',
  findings: [
    {
      id: 'F-1',
      severity: 'major',
      ruleId: 'SPEC-COVERAGE',
      message: 'missing retry',
      requiresHuman: false,
    },
  ],
}

const businessConflict = {
  verdict: 'revise',
  findings: [
    {
      id: 'F-2',
      severity: 'blocking',
      ruleId: 'SCOPE-CONFLICTS',
      message: 'PRD/API conflict on guardianMobile',
      requiresHuman: true,
    },
  ],
}

test('decideReviewAction repairs majors until max rounds then asks human', () => {
  const repair = decideReviewAction({ report: majorFailure, fixRound: 0, maxFixRounds: 3 })
  assert.equal(repair.action, 'repair')
  assert.equal(repair.escalateTo, 'main')
  assert.equal(
    decideReviewAction({ report: majorFailure, fixRound: 3, maxFixRounds: 3 }).action,
    'ask_human',
  )
  assert.equal(
    decideReviewAction({ report: businessConflict, fixRound: 0, maxFixRounds: 3 }).escalateTo,
    'human',
  )
})

test('pass and minors release; missing evidence returns to the main agent', () => {
  const passed = decideReviewAction({ report: { verdict: 'pass', findings: [] } })
  assert.equal(passed.action, 'accept')
  assert.equal(passed.escalateTo, 'none')

  const minors = decideReviewAction({
    report: {
      verdict: 'revise',
      findings: [{ id: 'F-3', severity: 'minor', ruleId: 'CODE-QUALITY', message: 'naming', requiresHuman: false }],
    },
  })
  assert.equal(minors.action, 'accept')
  assert.equal(minors.escalateTo, 'none')

  const evidence = decideReviewAction({ report: { verdict: 'needs_evidence', findings: [] } })
  assert.equal(evidence.action, 'collect_evidence')
  assert.equal(evidence.escalateTo, 'main')
})

test('summarizeReReview blocks done while majors remain', () => {
  const summary = summarizeReReview({
    previousFindings: majorFailure.findings,
    addressing: [{ findingId: 'F-1', status: 'not_addressed' }],
    newFindings: [],
  })
  assert.equal(summary.canMarkDone, false)
  assert.deepEqual(summary.unresolvedMajorIds, ['F-1'])
})
