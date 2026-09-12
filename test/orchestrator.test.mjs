import assert from 'node:assert/strict'
import test from 'node:test'

import { nextAction } from '../template/.ai-dev/scripts/lib/orchestrator.mjs'

function approval(actor = 'human') {
  return { approvedBy: actor, approvedAt: '2026-09-12T00:00:00.000Z', decisionRef: 'd1', snapshotId: 'snap-1' }
}

function status(state, extra = {}) {
  return {
    id: 'REQ-ORCH',
    state,
    control: { version: 4 },
    policy: { mode: 'strict', delegation: null, maxFixRounds: 3 },
    approvals: { scope: null, spec: null, plan: null, final: null },
    reviews: {},
    runtime: { activeTaskId: null, attempts: {}, taskResults: {} },
    ...extra,
  }
}

function delivery(tasks = [{ id: 'T1', dependsOn: [], files: [{ path: 'src/app.js', operation: 'modify' }] }]) {
  return { schemaVersion: 1, tasks, acceptance: [], links: [] }
}

const approvedPlan = {
  scope: approval(),
  spec: approval(),
  plan: approval(),
}

test('decision table: ingest, reviews, implementing, terminal', () => {
  assert.equal(nextAction({ status: status('INGEST'), delivery: delivery() }).type, 'generate_analysis')

  const scopePending = nextAction({
    status: status('SCOPE_REVIEW'),
    delivery: delivery(),
    capabilities: { freshContextDispatch: false },
  })
  assert.equal(scopePending.type, 'await_human')
  assert.notEqual(scopePending.type, 'generate_spec')

  const scopeReady = nextAction({
    status: status('SCOPE_REVIEW', { approvals: { scope: approval() } }),
    delivery: delivery(),
  })
  assert.equal(scopeReady.type, 'generate_spec')

  const specReady = nextAction({
    status: status('SPEC_REVIEW', { approvals: { scope: approval(), spec: approval() } }),
    delivery: delivery(),
  })
  assert.equal(specReady.type, 'generate_plan')

  const unapprovedPlanContext = {
    status: status('PLAN_REVIEW', { approvals: { scope: approval(), spec: approval(), plan: null } }),
    delivery: delivery(),
    capabilities: { freshContextDispatch: false },
  }
  assert.equal(nextAction(unapprovedPlanContext).type, 'await_human')

  const planApproved = nextAction({
    status: status('PLAN_REVIEW', { approvals: approvedPlan }),
    delivery: delivery(),
  })
  assert.equal(planApproved.type, 'dispatch_implementer')
  assert.match(planApproved.reason, /IMPLEMENTING/)

  const readyTaskContext = {
    status: status('IMPLEMENTING', { approvals: approvedPlan }),
    delivery: delivery(),
    capabilities: { freshContextDispatch: true },
  }
  assert.equal(nextAction(readyTaskContext).type, 'dispatch_implementer')
  assert.equal(nextAction(readyTaskContext).taskId, 'T1')
  assert.equal(nextAction(readyTaskContext).capability, 'autonomous-in-host')

  const repairing = nextAction({
    status: status('IMPLEMENTING', {
      approvals: approvedPlan,
      runtime: { activeTaskId: 'T1', attempts: {}, taskResults: { T1: { status: 'repairing' } } },
    }),
    delivery: delivery([
      { id: 'T1', dependsOn: [], files: [] },
      { id: 'T2', dependsOn: ['T1'], files: [] },
    ]),
  })
  assert.equal(repairing.type, 'repair')
  assert.equal(repairing.taskId, 'T1')

  const allPassed = nextAction({
    status: status('IMPLEMENTING', {
      approvals: approvedPlan,
      runtime: {
        activeTaskId: null,
        attempts: {},
        taskResults: { T1: { status: 'passed' }, T2: { status: 'passed' } },
      },
    }),
    delivery: delivery([
      { id: 'T1', dependsOn: [], files: [] },
      { id: 'T2', dependsOn: ['T1'], files: [] },
    ]),
  })
  assert.equal(allPassed.type, 'verify')

  const finalNoReview = nextAction({
    status: status('FINAL_REVIEW', { approvals: approvedPlan }),
    delivery: delivery(),
  })
  assert.equal(finalNoReview.type, 'dispatch_reviewer')
  assert.equal(finalNoReview.taskId, null)
  assert.equal(finalNoReview.gate, 'final')

  const finalAwait = nextAction({
    status: status('FINAL_REVIEW', {
      approvals: approvedPlan,
      reviews: { final: { verdict: 'pass', independence: 'independent' } },
    }),
    delivery: delivery(),
  })
  assert.equal(finalAwait.type, 'await_human')

  assert.equal(nextAction({ status: status('COMPLETE') }).type, 'complete')
  assert.equal(nextAction({ status: status('BLOCKED') }).type, 'blocked')
})

test('stale review, missing deps, empty tasks, and repeat next stay stable', () => {
  const staleReviewContext = {
    status: status('SPEC_REVIEW', {
      approvals: { scope: approval(), spec: null },
      reviews: { spec: { verdict: 'pass', independence: 'independent' } },
    }),
    gates: { staleReviews: ['spec'] },
    delivery: delivery(),
    capabilities: { freshContextDispatch: true },
  }
  assert.equal(nextAction(staleReviewContext).type, 'request_review')

  const staleApproval = nextAction({
    status: status('SPEC_REVIEW', { approvals: { scope: approval(), spec: approval() } }),
    gates: { staleApprovals: ['spec'] },
    delivery: delivery(),
  })
  assert.equal(staleApproval.type, 'request_review')

  const blockedByDep = nextAction({
    status: status('IMPLEMENTING', {
      approvals: approvedPlan,
      runtime: { activeTaskId: null, attempts: {}, taskResults: { T1: { status: 'review_pending' } } },
    }),
    delivery: delivery([
      { id: 'T1', dependsOn: [], files: [] },
      { id: 'T2', dependsOn: ['T1'], files: [] },
    ]),
  })
  assert.equal(blockedByDep.type, 'dispatch_reviewer')
  assert.equal(blockedByDep.taskId, 'T1')
  assert.notEqual(blockedByDep.taskId, 'T2')

  const emptyTasks = nextAction({
    status: status('IMPLEMENTING', { approvals: approvedPlan }),
    delivery: delivery([]),
  })
  assert.notEqual(emptyTasks.type, 'complete')
  assert.equal(emptyTasks.type, 'await_human')

  const first = nextAction({
    status: status('IMPLEMENTING', { approvals: approvedPlan }),
    delivery: delivery(),
  })
  const second = nextAction({
    status: status('IMPLEMENTING', { approvals: approvedPlan }),
    delivery: delivery(),
  })
  assert.deepEqual(first, second)
})

test('valid current review is not requested again; generate is never implied by next', () => {
  const afterScopeReview = nextAction({
    status: status('SCOPE_REVIEW', {
      reviews: { scope: { verdict: 'pass', independence: 'independent' } },
    }),
    delivery: delivery(),
    capabilities: { freshContextDispatch: true },
  })
  assert.equal(afterScopeReview.type, 'await_human')

  const ingestEvenIfFilesExist = nextAction({
    status: status('INGEST'),
    delivery: delivery(),
    gates: { analysisPresent: true },
  })
  assert.equal(ingestEvenIfFilesExist.type, 'generate_analysis')
})
