/**
 * 解决什么问题：feature 状态只能沿合法边前进，批准和委派必须可审计。
 * 通过什么方式解决：相邻前进转态、闸门结构检查、人工 approve 绑快照；委派仅允许 spec/plan。
 * 触发时机：transition / block / resume / approve / delegate。
 * 被谁控制触发：workflow-control 与协调脚本；不评判业务语义。
 */

import { mutateFeature, readFeature, StoreError } from './workspace-store.mjs'
import { validateFeature } from '../validate-change.mjs'
import { evaluateGate } from './gates.mjs'
import { reconcileArtifacts } from './consistency.mjs'
import { captureSnapshot } from './snapshots.mjs'
import { gateAuthorized } from './reviews.mjs'

export const MAIN_CHAIN = [
  'INGEST',
  'SCOPE_REVIEW',
  'SPEC_REVIEW',
  'PLAN_REVIEW',
  'IMPLEMENTING',
  'VERIFYING',
  'FINAL_REVIEW',
  'COMPLETE',
]

const GATE_BY_STATE = {
  SCOPE_REVIEW: 'scope',
  SPEC_REVIEW: 'spec',
  PLAN_REVIEW: 'plan',
  FINAL_REVIEW: 'final',
}

const STATE_FOR_GATE = {
  scope: 'SCOPE_REVIEW',
  spec: 'SPEC_REVIEW',
  plan: 'PLAN_REVIEW',
  final: 'FINAL_REVIEW',
}

const APPROVALS_REQUIRED_TO_ENTER = {
  SCOPE_REVIEW: [],
  SPEC_REVIEW: ['scope'],
  PLAN_REVIEW: ['scope', 'spec'],
  IMPLEMENTING: ['scope', 'spec', 'plan'],
  VERIFYING: ['scope', 'spec', 'plan'],
  FINAL_REVIEW: ['scope', 'spec', 'plan'],
  COMPLETE: ['scope', 'spec', 'plan', 'final'],
}

const GATE_REQUIRED_BEFORE_ENTERING = {
  SPEC_REVIEW: 'scope',
  PLAN_REVIEW: 'spec',
  IMPLEMENTING: 'plan',
  VERIFYING: 'plan',
  FINAL_REVIEW: 'plan',
  COMPLETE: 'final',
}

async function reconcileOrReload(featureDir, expectedVersion, actor) {
  const current = await readFeature(featureDir)
  if (current.control.version !== expectedVersion) {
    throw new StoreError(
      'VERSION_CONFLICT',
      `expectedVersion ${expectedVersion} does not match disk version ${current.control.version}`,
    )
  }
  return reconcileArtifacts(featureDir, {
    expectedVersion,
    actor: actor || 'system',
  })
}

const GATES = new Set(['scope', 'spec', 'plan', 'final'])

function err(code, message, extra = {}) {
  return { code, message, ruleId: code, ...extra }
}

function hasApproval(status, gate) {
  return gateAuthorized(status, gate)
}

function approvalErrors(status, gates) {
  const errors = []
  for (const gate of gates) {
    if (!hasApproval(status, gate)) {
      errors.push(
        err('MISSING_APPROVAL', `${gate} approval is required`, { artifact: `approvals.${gate}` }),
      )
    }
  }
  return errors
}

/**
 * 判断 from→to 是否合法。只允许主链相邻前进；BLOCKED 只能走 resume；COMPLETE 为终态。
 * 离开闸门态必须已有该闸批准，进入目标态还要备齐前置批准，且不能有 stale。
 * 只看结构与批准记录，不评语义质量。
 */
export function evaluateTransition(status, to) {
  const errors = []
  if (!status || typeof status !== 'object') {
    return { ok: false, errors: [err('INVALID_STATUS', 'status is required')] }
  }
  if (![...MAIN_CHAIN, 'BLOCKED'].includes(to)) {
    return { ok: false, errors: [err('UNKNOWN_STATE', `Unknown target state: ${to}`)] }
  }

  const from = status.state
  if (from === 'BLOCKED') {
    return {
      ok: false,
      errors: [err('BLOCKED_RESUME_ONLY', 'BLOCKED features may only resume; use resumeFeature')],
    }
  }
  if (to === 'BLOCKED') {
    return { ok: true, errors: [] }
  }
  if (from === 'COMPLETE') {
    return {
      ok: false,
      errors: [err('COMPLETE_TERMINAL', 'COMPLETE cannot transition to another state')],
    }
  }

  const fromIndex = MAIN_CHAIN.indexOf(from)
  const toIndex = MAIN_CHAIN.indexOf(to)
  if (fromIndex < 0) {
    return { ok: false, errors: [err('UNKNOWN_STATE', `Unknown current state: ${from}`)] }
  }
  if (toIndex !== fromIndex + 1) {
    errors.push(
      err(
        'NON_ADJACENT_TRANSITION',
        `Only adjacent forward transitions are allowed (tried ${from} → ${to})`,
      ),
    )
  }

  const currentGate = GATE_BY_STATE[from]
  if (currentGate && !hasApproval(status, currentGate)) {
    errors.push(
      err(
        'CURRENT_GATE_UNAPPROVED',
        `Cannot leave ${from} without ${currentGate} approval`,
        { artifact: `approvals.${currentGate}` },
      ),
    )
  }

  errors.push(...approvalErrors(status, APPROVALS_REQUIRED_TO_ENTER[to] || []))

  if (Array.isArray(status.consistency?.staleArtifacts) && status.consistency.staleArtifacts.length) {
    errors.push(
      err('STALE_ARTIFACTS', `stale artifacts: ${status.consistency.staleArtifacts.join(', ')}`),
    )
  }

  return { ok: errors.length === 0, errors }
}

async function assertGate(featureDir, gate) {
  const result = await evaluateGate(featureDir, gate)
  if (!result.ok) {
    const error = new StoreError(
      'GATE_FAILED',
      result.errors.map((item) => `${item.code}: ${item.message}`).join('; '),
    )
    error.errors = result.errors
    error.gate = result
    throw error
  }
  return result
}

/**
 * 合法转态：先对 expectedVersion 与 evaluateTransition 把关，再 reconcile、validate、过必要闸门。
 * 最后 mutate 改 state。这不是批准本身，也不会跳过相邻边。
 */
export async function transitionFeature(featureDir, to, options = {}) {
  const { expectedVersion, actor, decisionRef = null } = options
  if (!Number.isInteger(expectedVersion) || !actor) {
    throw new StoreError('INVALID_REQUEST', 'actor and expectedVersion are required')
  }

  const current = await readFeature(featureDir)
  if (current.control.version !== expectedVersion) {
    throw new StoreError(
      'VERSION_CONFLICT',
      `expectedVersion ${expectedVersion} does not match disk version ${current.control.version}`,
    )
  }

  const evaluation = evaluateTransition(current, to)
  if (!evaluation.ok) {
    const error = new StoreError(
      'INVALID_TRANSITION',
      evaluation.errors.map((item) => item.message).join('; '),
    )
    error.errors = evaluation.errors
    throw error
  }

  const status = await reconcileArtifacts(featureDir, {
    expectedVersion,
    actor,
  })

  const probe = structuredClone(status)
  probe.state = to
  const validation = await validateFeature(featureDir, { status: probe })
  if (!validation.ok) {
    const error = new StoreError('VALIDATION_FAILED', validation.errors.join('; '))
    error.errors = validation.errors.map((message) => err('VALIDATION', message))
    throw error
  }

  const requiredGate = GATE_REQUIRED_BEFORE_ENTERING[to]
  if (requiredGate) {
    await assertGate(featureDir, requiredGate)
  }

  return mutateFeature(
    featureDir,
    {
      expectedVersion: status.control.version,
      event: {
        type: 'workflow.transition',
        actor,
        data: { from: status.state, to, decisionRef },
      },
    },
    (draft) => {
      draft.state = to
      draft.control.blocked = null
    },
  )
}

/**
 * 把当前阶段记入 suspendedFrom 后进入 BLOCKED。COMPLETE 不能拦。
 * 恢复时必须回到记下的原阶段，不在这里猜。
 */
export async function blockFeature(featureDir, options = {}) {
  const { reasonCode, requiredInput, actor, expectedVersion } = options
  if (!reasonCode || !requiredInput || !actor || !Number.isInteger(expectedVersion)) {
    throw new StoreError(
      'INVALID_REQUEST',
      'reasonCode, requiredInput, actor, and expectedVersion are required',
    )
  }

  const status = await readFeature(featureDir)
  if (status.state === 'BLOCKED') {
    throw new StoreError('ALREADY_BLOCKED', 'Feature is already BLOCKED')
  }
  if (status.state === 'COMPLETE') {
    throw new StoreError('COMPLETE_TERMINAL', 'COMPLETE cannot be blocked')
  }

  return mutateFeature(
    featureDir,
    {
      expectedVersion,
      event: {
        type: 'workflow.block',
        actor,
        data: { reasonCode, requiredInput, suspendedFrom: status.state },
      },
    },
    (draft) => {
      draft.control.blocked = {
        suspendedFrom: draft.state,
        reasonCode,
        requiredInput,
        blockedAt: new Date().toISOString(),
      }
      draft.state = 'BLOCKED'
    },
  )
}

/**
 * 只从 BLOCKED 回到 suspendedFrom。缺原阶段则要求人工指定，不猜。
 * 进入该阶段所需批准仍缺、或还有 stale，则拒绝恢复。
 */
export async function resumeFeature(featureDir, options = {}) {
  const { actor, expectedVersion } = options
  if (!actor || !Number.isInteger(expectedVersion)) {
    throw new StoreError('INVALID_REQUEST', 'actor and expectedVersion are required')
  }

  const status = await readFeature(featureDir)
  if (status.state !== 'BLOCKED') {
    throw new StoreError('NOT_BLOCKED', 'Only BLOCKED features can resume')
  }

  const suspendedFrom = status.control?.blocked?.suspendedFrom
  if (!suspendedFrom) {
    throw new StoreError(
      'RESUME_NEEDS_HUMAN',
      status.control?.blocked?.requiredInput || '人工指定原阶段',
    )
  }

  const missing = approvalErrors(status, APPROVALS_REQUIRED_TO_ENTER[suspendedFrom] || [])
  if (missing.length) {
    const error = new StoreError(
      'RESUME_BLOCKED',
      `Cannot resume to ${suspendedFrom}: ${missing.map((item) => item.message).join('; ')}`,
    )
    error.errors = missing
    throw error
  }

  if (Array.isArray(status.consistency?.staleArtifacts) && status.consistency.staleArtifacts.length) {
    throw new StoreError(
      'STALE_ARTIFACTS',
      `Cannot resume while stale artifacts remain: ${status.consistency.staleArtifacts.join(', ')}`,
    )
  }

  const probe = structuredClone(status)
  probe.state = suspendedFrom
  probe.control = { ...probe.control, blocked: null }
  const validation = await validateFeature(featureDir, { status: probe })
  if (!validation.ok) {
    const error = new StoreError('VALIDATION_FAILED', validation.errors.join('; '))
    error.errors = validation.errors.map((message) => err('VALIDATION', message))
    throw error
  }

  return mutateFeature(
    featureDir,
    {
      expectedVersion,
      event: {
        type: 'workflow.resume',
        actor,
        data: { to: suspendedFrom },
      },
    },
    (draft) => {
      draft.state = suspendedFrom
      draft.control.blocked = null
    },
  )
}

/**
 * 人工闸门批准。只能批当前闸，或状态已越过该闸但批准已被失效的情况。
 * 先过结构闸门再绑新鲜快照，写入 approvals.*；独立审核不能代写这一笔。
 */
export async function recordHumanApproval(featureDir, options = {}) {
  const { gate, actor, decisionRef, expectedVersion } = options
  if (!GATES.has(gate)) {
    throw new StoreError('INVALID_REQUEST', `gate must be one of ${[...GATES].join('|')}`)
  }
  if (!actor || !decisionRef || !Number.isInteger(expectedVersion)) {
    throw new StoreError('INVALID_REQUEST', 'actor, decisionRef, and expectedVersion are required')
  }

  const status = await reconcileOrReload(featureDir, expectedVersion, actor)
  if (status.state === 'BLOCKED' || status.state === 'COMPLETE') {
    throw new StoreError('APPROVAL_NOT_ALLOWED', `Cannot approve ${gate} while state is ${status.state}`)
  }

  const gateState = STATE_FOR_GATE[gate]
  const isCurrentGate = GATE_BY_STATE[status.state] === gate
  const isInvalidatedUpstream =
    !hasApproval(status, gate) &&
    MAIN_CHAIN.indexOf(status.state) >= MAIN_CHAIN.indexOf(gateState)

  if (!isCurrentGate && !isInvalidatedUpstream) {
    throw new StoreError(
      'APPROVAL_NOT_ALLOWED',
      `Cannot approve ${gate} while state is ${status.state}`,
    )
  }

  await assertGate(featureDir, gate)

  const snapshot = await captureSnapshot(featureDir, {
    gate,
    inputs: undefined,
    includeProjectDigest: gate === 'final',
  })
  const freshness = await import('./snapshots.mjs').then((mod) => mod.verifySnapshot(featureDir, snapshot))
  if (!freshness.fresh) {
    throw new StoreError('SNAPSHOT_NOT_FRESH', 'Captured approval snapshot was not fresh')
  }

  return mutateFeature(
    featureDir,
    {
      expectedVersion: status.control.version,
      event: {
        type: 'workflow.approve',
        actor,
        data: { gate, decisionRef, snapshotId: snapshot.id },
      },
    },
    (draft) => {
      draft.approvals[gate] = {
        approvedBy: actor,
        approvedAt: new Date().toISOString(),
        decisionRef,
        snapshotId: snapshot.id,
      }
    },
  )
}

const DELEGATABLE = new Set(['spec', 'plan'])

/**
 * 显式授权本 feature 的独立审核。gates 只能是 spec/plan。
 * scope/final 不能委派，必须人工批。写入 policy.mode=delegated-review。
 */
export async function recordDelegation(featureDir, options = {}) {
  const { expectedVersion, actor, decisionRef, gates } = options
  if (!actor || !decisionRef || !Number.isInteger(expectedVersion)) {
    throw new StoreError('INVALID_REQUEST', 'actor, decisionRef, and expectedVersion are required')
  }
  if (!Array.isArray(gates) || !gates.length) {
    throw new StoreError('INVALID_REQUEST', 'gates must be a non-empty array')
  }
  for (const gate of gates) {
    // scope/final 不能委派，只能人工批。
    if (!DELEGATABLE.has(gate)) {
      throw new StoreError('INVALID_DELEGATION', `Cannot delegate ${gate}; only spec|plan allowed`)
    }
  }

  const status = await reconcileOrReload(featureDir, expectedVersion, actor)
  return mutateFeature(
    featureDir,
    {
      expectedVersion: status.control.version,
      event: {
        type: 'policy.delegate',
        actor,
        data: { gates, decisionRef },
      },
    },
    (draft) => {
      draft.policy = {
        ...draft.policy,
        mode: 'delegated-review',
        delegation: {
          actor,
          decisionRef,
          gates: [...gates],
          at: new Date().toISOString(),
        },
      }
    },
  )
}

/**
 * 清掉委派，回到 strict。范围变化后应收回审核权，避免旧授权继续放行。
 */
export async function clearDelegation(featureDir, options = {}) {
  const { expectedVersion, actor, reason = 'scope-changed' } = options
  if (!actor || !Number.isInteger(expectedVersion)) {
    throw new StoreError('INVALID_REQUEST', 'actor and expectedVersion are required')
  }
  return mutateFeature(
    featureDir,
    {
      expectedVersion,
      event: {
        type: 'policy.delegate.clear',
        actor,
        data: { reason },
      },
    },
    (draft) => {
      draft.policy = {
        ...draft.policy,
        mode: 'strict',
        delegation: null,
      }
    },
  )
}
