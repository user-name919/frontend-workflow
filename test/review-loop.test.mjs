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
  assert.equal(
    decideReviewAction({ report: majorFailure, fixRound: 0, maxFixRounds: 3 }).action,
    'repair',
  )
  assert.equal(
    decideReviewAction({ report: majorFailure, fixRound: 3, maxFixRounds: 3 }).action,
    'ask_human',
  )
  assert.equal(
    decideReviewAction({ report: businessConflict, fixRound: 0, maxFixRounds: 3 }).action,
    'ask_human',
  )
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
