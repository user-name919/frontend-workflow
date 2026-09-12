/**
 * Pure next-action decision for the host coordinator.
 * Does not call models, spawn workers, or mutate state.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { reconcileArtifacts } from './consistency.mjs'
import { gateAuthorized } from './reviews.mjs'
import { readFeature } from './workspace-store.mjs'

const STAGE_INPUTS = {
  generate_analysis: [
    'artifacts/analysis/intake.json',
    'artifacts/analysis/scope.md',
    'artifacts/analysis/source-index.md',
    'artifacts/analysis/evidence.md',
    'artifacts/analysis/open-questions.md',
  ],
  generate_spec: [
    'artifacts/analysis/intake.json',
    'artifacts/design/delivery.json',
    'artifacts/design/frontend-spec.md',
    'artifacts/design/acceptance.md',
  ],
  generate_plan: [
    'artifacts/design/delivery.json',
    'artifacts/design/implementation-plan.md',
    'artifacts/design/tasks.md',
    'artifacts/design/traceability.md',
  ],
}

function action(type, status, extra = {}) {
  return {
    type,
    featureId: status?.id ?? null,
    taskId: extra.taskId ?? null,
    reason: extra.reason || type,
    inputPaths: extra.inputPaths || [],
    expectedVersion: status?.control?.version ?? null,
    gate: extra.gate ?? null,
    capability: extra.capability || 'assisted',
  }
}

function capabilityOf(capabilities) {
  return capabilities?.freshContextDispatch ? 'autonomous-in-host' : 'assisted'
}

function approvalOk(status, gate, gates) {
  if (gates?.staleApprovals?.includes(gate)) return false
  if (gates?.[gate]?.stale === true) return false
  if (gates?.[gate]?.authorized === false) return false
  if (gates?.[gate]?.authorized === true) return true
  return gateAuthorized(status, gate)
}

function reviewKey(gate, taskId) {
  return gate === 'task' && taskId ? `task:${taskId}` : gate
}

function hasReview(status, key, gates) {
  if (gates?.hasReview?.[key] === true) return true
  if (gates?.hasReview?.[key] === false) return false
  return Boolean(status?.reviews?.[key])
}

function reviewFresh(status, key, gates) {
  if (gates?.staleReviews?.includes(key)) return false
  if (gates?.reviews?.[key]?.fresh === false) return false
  const record = status?.reviews?.[key]
  if (!record) return Boolean(gates?.reviews?.[key]?.fresh)
  if (record.verdict !== 'pass') return false
  if (record.independence && record.independence !== 'independent') return false
  return true
}

function reviewOrHuman(status, gate, capabilities, gates) {
  const cap = capabilityOf(capabilities)
  const key = reviewKey(gate, null)
  if (gates?.staleApprovals?.includes(gate) || gates?.staleReviews?.includes(key)) {
    return action('request_review', status, {
      gate,
      capability: cap,
      reason: `${gate} approval or review is stale`,
      inputPaths: STAGE_INPUTS.generate_spec,
    })
  }
  if (hasReview(status, key, gates)) {
    if (!reviewFresh(status, key, gates)) {
      return action('request_review', status, {
        gate,
        capability: cap,
        reason: `${gate} review is stale`,
      })
    }
    return action('await_human', status, {
      gate,
      capability: cap,
      reason: `${gate} has a current review; human decision still required`,
    })
  }
  if (capabilities?.freshContextDispatch || capabilities?.requestReview) {
    return action('request_review', status, {
      gate,
      capability: cap,
      reason: `prepare ${gate} review packet`,
    })
  }
  return action('await_human', status, {
    gate,
    capability: cap,
    reason: `${gate} awaiting human`,
  })
}

function taskRecord(status, taskId) {
  return status?.runtime?.taskResults?.[taskId] || {}
}

function taskRunStatus(status, taskId) {
  return taskRecord(status, taskId).status || 'pending'
}

function depsPassed(status, task) {
  return (task.dependsOn || []).every((dep) => taskRecord(status, dep).status === 'passed')
}

function implementingAction(status, delivery, capabilities, gates) {
  const cap = capabilityOf(capabilities)
  const tasks = Array.isArray(delivery?.tasks) ? delivery.tasks : []
  if (!tasks.length) {
    return action('await_human', status, {
      capability: cap,
      reason: 'no tasks in approved delivery; cannot mark complete',
    })
  }

  const repairing = tasks.find((task) => taskRunStatus(status, task.id) === 'repairing')
  if (repairing) {
    return action('repair', status, {
      taskId: repairing.id,
      capability: cap,
      reason: `${repairing.id} is repairing; do not dispatch later tasks`,
    })
  }

  const running = tasks.find((task) => taskRunStatus(status, task.id) === 'running')
  if (running) {
    return action('dispatch_implementer', status, {
      taskId: running.id,
      capability: cap,
      reason: `${running.id} already running; inspect, do not create a second run`,
    })
  }

  const reviewPending = tasks.find((task) => taskRunStatus(status, task.id) === 'review_pending')
  if (reviewPending) {
    return action('dispatch_reviewer', status, {
      taskId: reviewPending.id,
      gate: 'task',
      capability: cap,
      reason: `${reviewPending.id} waiting for independent review`,
    })
  }

  const needsContext = tasks.find((task) => taskRunStatus(status, task.id) === 'needs_context')
  if (needsContext) {
    return action('await_human', status, {
      taskId: needsContext.id,
      capability: cap,
      reason: `${needsContext.id} needs context the repository cannot supply`,
    })
  }

  const blockedTask = tasks.find((task) => taskRunStatus(status, task.id) === 'blocked')
  if (blockedTask) {
    return action('await_human', status, {
      taskId: blockedTask.id,
      capability: cap,
      reason: `${blockedTask.id} is blocked`,
    })
  }

  const ready = tasks.find((task) => {
    const run = taskRunStatus(status, task.id)
    return (run === 'pending' || !run) && depsPassed(status, task)
  })
  if (ready) {
    return action('dispatch_implementer', status, {
      taskId: ready.id,
      capability: cap,
      reason: `dispatch ${ready.id}`,
      inputPaths: (ready.files || []).map((file) => file.path),
    })
  }

  const waitingOnDeps = tasks.find((task) => {
    const run = taskRunStatus(status, task.id)
    return (run === 'pending' || !run) && !depsPassed(status, task)
  })
  if (waitingOnDeps) {
    return action('await_human', status, {
      taskId: waitingOnDeps.id,
      capability: cap,
      reason: `${waitingOnDeps.id} depends on tasks that have not passed review`,
    })
  }

  const allPassed = tasks.every((task) => taskRunStatus(status, task.id) === 'passed')
  if (allPassed) {
    return action('verify', status, {
      capability: cap,
      reason: 'all tasks passed independent review',
      inputPaths: ['artifacts/verification/verification.md'],
    })
  }

  return action('await_human', status, {
    capability: cap,
    reason: 'implementing has no dispatchable task',
  })
}

/**
 * @param {{
 *   status: object,
 *   intake?: object,
 *   delivery?: object,
 *   gates?: object,
 *   capabilities?: { freshContextDispatch?: boolean, requestReview?: boolean }
 * }} input
 */
export function nextAction(input = {}) {
  const { status, delivery, gates = {}, capabilities = {} } = input
  const cap = capabilityOf(capabilities)
  if (!status || typeof status !== 'object') {
    return action('blocked', { control: { version: null } }, { reason: 'missing status', capability: cap })
  }

  switch (status.state) {
    case 'COMPLETE':
      return action('complete', status, { capability: cap })
    case 'BLOCKED':
      return action('blocked', status, { capability: cap, reason: 'feature is BLOCKED' })
    case 'INGEST':
      return action('generate_analysis', status, {
        capability: cap,
        reason: 'ingest: generate analysis artifacts then transition',
        inputPaths: STAGE_INPUTS.generate_analysis,
      })
    case 'SCOPE_REVIEW':
      if (approvalOk(status, 'scope', gates)) {
        return action('generate_spec', status, {
          capability: cap,
          reason: 'scope approved; generate spec then transition',
          inputPaths: STAGE_INPUTS.generate_spec,
        })
      }
      return reviewOrHuman(status, 'scope', capabilities, gates)
    case 'SPEC_REVIEW':
      if (approvalOk(status, 'spec', gates)) {
        return action('generate_plan', status, {
          capability: cap,
          reason: 'spec approved; generate plan then transition',
          inputPaths: STAGE_INPUTS.generate_plan,
        })
      }
      return reviewOrHuman(status, 'spec', capabilities, gates)
    case 'PLAN_REVIEW':
      if (approvalOk(status, 'plan', gates)) {
        const ready = (delivery?.tasks || []).find((task) => depsPassed(status, task))
        return action('dispatch_implementer', status, {
          capability: cap,
          taskId: ready?.id ?? null,
          reason: 'plan approved; legally transition to IMPLEMENTING then dispatch',
        })
      }
      return reviewOrHuman(status, 'plan', capabilities, gates)
    case 'IMPLEMENTING':
      return implementingAction(status, delivery, capabilities, gates)
    case 'VERIFYING':
      return action('verify', status, {
        capability: cap,
        reason: 'run approved verification commands',
        inputPaths: ['artifacts/verification/verification.md'],
      })
    case 'FINAL_REVIEW': {
      const key = 'final'
      if (!hasReview(status, key, gates) || !reviewFresh(status, key, gates)) {
        return action('dispatch_reviewer', status, {
          capability: cap,
          taskId: null,
          gate: 'final',
          reason: 'final independent review of the full diff is required',
          inputPaths: STAGE_INPUTS.generate_plan.concat([
            'artifacts/coding-changes/changes.patch',
            'artifacts/verification/verification.md',
          ]),
        })
      }
      if (!approvalOk(status, 'final', gates)) {
        return action('await_human', status, {
          capability: cap,
          gate: 'final',
          reason: 'final review exists; human approval is still required',
        })
      }
      return action('await_human', status, {
        capability: cap,
        gate: 'final',
        reason: 'final approved; coordinator may transition to COMPLETE',
      })
    }
    default:
      return action('blocked', status, {
        capability: cap,
        reason: `unknown state ${status.state}`,
      })
  }
}

async function readJsonOrNull(featureDir, relative) {
  try {
    return JSON.parse(await readFile(path.join(featureDir, relative), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Reconcile first (may register newly observed artifact bytes), then compute next.
 * This is not a state transition and does not create task runs.
 */
export async function computeNext(featureDir, options = {}) {
  const resolved = path.resolve(featureDir)
  const current = await readFeature(resolved)
  const status = await reconcileArtifacts(resolved, {
    expectedVersion: current.control.version,
    actor: options.actor || 'orchestrator',
  })
  const intake = await readJsonOrNull(resolved, 'artifacts/analysis/intake.json')
  const delivery = await readJsonOrNull(resolved, 'artifacts/design/delivery.json')
  const actionResult = nextAction({
    status,
    intake,
    delivery,
    gates: options.gates,
    capabilities: options.capabilities || { freshContextDispatch: false },
  })
  return {
    ok: true,
    action: actionResult,
    controlVersion: status.control.version,
    state: status.state,
    capability: actionResult.capability,
    note: 'next is a decision, not a generate/transition. Persist results before calling next again.',
  }
}
