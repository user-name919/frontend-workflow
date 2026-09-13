/**
 * 解决什么问题：独立审核报告要能入库，但不能把自审当通过，也不能伪造人工批准。
 * 通过什么方式解决：校验报告字段与独立性；self_check 禁止 pass；接受后只写 reviews.* 与 summary，不写 approvals.*。
 * 触发时机：record-review / acceptReview。
 * 被谁控制触发：审核脚本；本模块不调模型。宿主独立性只记录，不密码学证明。
 */

import { createHash } from 'node:crypto'
import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { decideReviewAction } from './review-loop.mjs'
import { buildReviewSummary, renderReviewSummaryMarkdown } from './review-summary.mjs'
import { mutateFeature, readFeature, StoreError } from './workspace-store.mjs'
import { readSnapshot, verifySnapshot } from './snapshots.mjs'

const VERDICTS = new Set(['pass', 'revise', 'needs_human'])
const DIM = new Set(['pass', 'fail', 'not_run'])
const SEVERITIES = new Set(['blocking', 'major', 'minor'])
const GATES = new Set(['scope', 'spec', 'plan', 'task', 'final'])
const INDEPENDENCE = new Set(['independent', 'self_check', 'assisted'])
const CHECK_RESULTS = new Set(['pass', 'fail', 'not_run', 'skipped'])

const STAGE_DOC_GATES = new Set(['scope', 'spec', 'plan'])
const DUAL_GATES = new Set(['task', 'final'])

function err(code, message, extra = {}) {
  return { code, message, ruleId: code, ...extra }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/**
 * 校验报告与 request/snapshot 对齐，检查项与发现完整。
 * stage 文档 quality 必须 not_run；task/final 双维 pass 才能总 pass。
 * self_check 不能当作独立 pass。
 */
export function validateReview(report, context = {}) {
  const errors = []
  const request = context.request

  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return { ok: false, errors: [err('INVALID_REPORT', 'report must be an object')] }
  }
  if (report.schemaVersion !== 1) {
    errors.push(err('UNSUPPORTED_SCHEMA', 'report.schemaVersion must be 1'))
  }
  if (!request || typeof request !== 'object') {
    errors.push(err('MISSING_REQUEST', 'request context is required'))
    return { ok: false, errors }
  }

  if (report.requestId !== request.requestId) {
    errors.push(err('UNKNOWN_REQUEST', `report.requestId ${report.requestId} does not match request`))
  }
  if (report.snapshotId !== request.snapshotId) {
    errors.push(err('SNAPSHOT_MISMATCH', 'report.snapshotId must match request.snapshotId'))
  }
  if (report.gate !== request.gate) {
    errors.push(err('GATE_MISMATCH', 'report.gate must match request.gate'))
  }
  if ((report.taskId || null) !== (request.taskId || null)) {
    errors.push(err('TASK_MISMATCH', 'report.taskId must match request.taskId'))
  }
  if (!GATES.has(report.gate)) {
    errors.push(err('INVALID_GATE', `Unknown gate: ${report.gate}`))
  }
  if (!VERDICTS.has(report.verdict)) {
    errors.push(err('INVALID_VERDICT', `Unknown verdict: ${report.verdict}`))
  }
  if (!DIM.has(report.specVerdict)) {
    errors.push(err('INVALID_SPEC_VERDICT', `Unknown specVerdict: ${report.specVerdict}`))
  }
  if (!DIM.has(report.qualityVerdict)) {
    errors.push(err('INVALID_QUALITY_VERDICT', `Unknown qualityVerdict: ${report.qualityVerdict}`))
  }

  const reviewer = report.reviewer
  if (!reviewer || !isNonEmptyString(reviewer.runId) || !isNonEmptyString(reviewer.host)) {
    errors.push(err('MISSING_REVIEWER', 'reviewer.runId and reviewer.host are required'))
  } else {
    if (!INDEPENDENCE.has(reviewer.independence)) {
      errors.push(err('INVALID_INDEPENDENCE', `Unknown independence: ${reviewer.independence}`))
    }
    if (!isNonEmptyString(reviewer.model)) {
      errors.push(err('MISSING_MODEL', 'reviewer.model must record the actual model id (or explicit unknown)'))
    }
    if (request.implementerRunId && reviewer.runId === request.implementerRunId) {
      errors.push(err('SAME_IMPLEMENTER_RUN', 'reviewer.runId must differ from implementerRunId for independent review'))
    }
  }

  const requiredRuleIds = Array.isArray(request.requiredRuleIds) ? request.requiredRuleIds : []
  const checks = Array.isArray(report.checks) ? report.checks : null
  const findings = Array.isArray(report.findings) ? report.findings : null
  if (!checks) errors.push(err('MISSING_CHECKS', 'checks must be an array'))
  if (!findings) errors.push(err('MISSING_FINDINGS', 'findings must be an array'))

  if (checks) {
    const seen = new Set()
    for (const check of checks) {
      if (!isNonEmptyString(check.ruleId)) {
        errors.push(err('MISSING_RULE', 'check.ruleId is required'))
        continue
      }
      if (seen.has(check.ruleId)) {
        errors.push(err('DUPLICATE_RULE', `Duplicate check for ${check.ruleId}`))
      }
      seen.add(check.ruleId)
      if (!CHECK_RESULTS.has(check.result)) {
        errors.push(err('INVALID_CHECK_RESULT', `Invalid check result for ${check.ruleId}`))
      }
      if (!Array.isArray(check.evidence)) {
        errors.push(err('MISSING_EVIDENCE', `check ${check.ruleId} requires evidence array`))
      }
    }
    for (const ruleId of requiredRuleIds) {
      if (!seen.has(ruleId)) {
        errors.push(err('MISSING_REQUIRED_RULE', `Missing required ruleId ${ruleId}`))
      }
    }
  }

  if (findings) {
    const findingIds = new Set()
    for (const finding of findings) {
      if (!isNonEmptyString(finding.id)) {
        errors.push(err('MISSING_FINDING_ID', 'finding.id is required'))
        continue
      }
      if (findingIds.has(finding.id)) {
        errors.push(err('DUPLICATE_FINDING', `Duplicate finding id ${finding.id}`))
      }
      findingIds.add(finding.id)
      if (!SEVERITIES.has(finding.severity)) {
        errors.push(err('INVALID_SEVERITY', `Invalid severity on ${finding.id}`))
      }
      if (!isNonEmptyString(finding.ruleId) || !isNonEmptyString(finding.message)) {
        errors.push(err('INVALID_FINDING', `finding ${finding.id} needs ruleId and message`))
      }
      if (typeof finding.requiresHuman !== 'boolean') {
        errors.push(err('INVALID_REQUIRES_HUMAN', `finding ${finding.id} needs boolean requiresHuman`))
      }
    }
  }

  // Spec-then-quality consistency
  if (STAGE_DOC_GATES.has(report.gate)) {
    if (report.qualityVerdict !== 'not_run') {
      errors.push(err('STAGE_QUALITY_NOT_RUN', 'stage document reviews must set qualityVerdict=not_run'))
    }
  }
  if (report.specVerdict === 'fail' && report.qualityVerdict === 'pass') {
    errors.push(err('QUALITY_BEFORE_SPEC', 'quality cannot pass when specVerdict is fail'))
  }
  if (report.specVerdict === 'fail' && report.qualityVerdict !== 'not_run' && DUAL_GATES.has(report.gate)) {
    errors.push(err('QUALITY_MUST_NOT_RUN', 'when spec fails, qualityVerdict must be not_run'))
  }

  const hasBlockingOrMajor = (findings || []).some(
    (finding) => finding.severity === 'blocking' || finding.severity === 'major',
  )
  if (report.verdict === 'pass' && hasBlockingOrMajor) {
    errors.push(err('PASS_WITH_MAJOR', 'verdict pass is forbidden while blocking/major findings remain'))
  }

  if (DUAL_GATES.has(report.gate) && report.verdict === 'pass') {
    if (report.specVerdict !== 'pass' || report.qualityVerdict !== 'pass') {
      errors.push(err('DUAL_PASS_REQUIRED', 'task/final pass requires both specVerdict and qualityVerdict pass'))
    }
  }
  if (STAGE_DOC_GATES.has(report.gate) && report.verdict === 'pass' && report.specVerdict !== 'pass') {
    errors.push(err('SPEC_PASS_REQUIRED', 'stage document pass requires specVerdict pass'))
  }

  // self_check 只能当对照，不能作为独立通过。
  if (reviewer?.independence === 'self_check' && report.verdict === 'pass') {
    errors.push(err('SELF_CHECK_NOT_INDEPENDENT', 'self_check reports cannot be accepted as independent pass'))
  }

  return { ok: errors.length === 0, errors }
}

/**
 * 闸门是否可前进：有人工批准即过。
 * scope/final 绝不能只靠审核；spec/plan 仅在 delegated-review 且独立 pass 时放行。
 */
export function gateAuthorized(status, gate, review = null) {
  const human = status?.approvals?.[gate]
  if (human?.approvedBy && human?.approvedAt) {
    return true
  }

  // scope/final 必须人工批，审核单独不能授权。
  if (gate === 'scope' || gate === 'final') {
    return false
  }

  if (status?.policy?.mode !== 'delegated-review') {
    return false
  }
  const delegation = status.policy.delegation
  if (!delegation || !Array.isArray(delegation.gates) || !delegation.gates.includes(gate)) {
    return false
  }
  if (!review) {
    const accepted = status.reviews?.[gate]
    if (!accepted?.reportRef || accepted.verdict !== 'pass') return false
    if (accepted.independence !== 'independent') return false
    return true
  }

  if (review.verdict !== 'pass') return false
  if (review.reviewer?.independence !== 'independent') return false
  if (review.gate !== gate) return false
  return true
}

async function persistReport(featureDir, report) {
  const dir = path.join(featureDir, 'revisions/reviews', report.requestId)
  await mkdir(dir, { recursive: true })
  const fileName = `${report.reviewer.runId}.json`
  const filePath = path.join(dir, fileName)
  const payload = `${JSON.stringify(report, null, 2)}\n`
  try {
    const handle = await open(filePath, 'wx')
    try {
      await handle.writeFile(payload)
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (error.code === 'EEXIST') {
      const existing = await readFile(filePath, 'utf8')
      if (stableHash(JSON.parse(existing)) === stableHash(report)) {
        return {
          relative: path.relative(featureDir, filePath),
          duplicate: true,
        }
      }
      throw new StoreError('REVIEW_CONTENT_CONFLICT', `Different report already stored for ${report.requestId}/${report.reviewer.runId}`)
    }
    throw error
  }
  return { relative: path.relative(featureDir, filePath), duplicate: false }
}

/**
 * 校验后把报告落入 revisions/reviews，并写 summary.json/md。
 * 快照不新鲜则只留审计不接受。mutate 只写 reviews 引用，不伪造 approvals.*。
 */
export async function acceptReview(featureDir, report, options = {}) {
  const resolved = path.resolve(featureDir)
  const expectedVersion = options.expectedVersion
  if (!Number.isInteger(expectedVersion)) {
    throw new StoreError('INVALID_REQUEST', 'expectedVersion is required')
  }
  const request = options.request
  if (!request) throw new StoreError('INVALID_REQUEST', 'request is required')

  const validation = validateReview(report, { request, snapshot: options.snapshot })
  if (!validation.ok) {
    const error = new StoreError('INVALID_REVIEW', validation.errors.map((item) => item.message).join('; '))
    error.errors = validation.errors
    throw error
  }

  const status = await readFeature(resolved)
  if (status.control.version !== expectedVersion) {
    throw new StoreError(
      'VERSION_CONFLICT',
      `expectedVersion ${expectedVersion} does not match disk version ${status.control.version}`,
    )
  }

  const snapshot = options.snapshot || (await readSnapshot(resolved, report.snapshotId))
  const freshness = await verifySnapshot(resolved, snapshot)
  if (!freshness.fresh) {
    // Keep report on disk for audit, but do not accept as release decision.
    await persistReport(resolved, report)
    throw new StoreError('STALE_REVIEW_SNAPSHOT', 'Review snapshot is no longer fresh; report retained without acceptance')
  }

  const stored = await persistReport(resolved, report)
  const currentTask = status.runtime?.taskResults?.[report.taskId] || {}
  const decision = decideReviewAction({
    report,
    fixRound: Number.isInteger(request.fixRound) ? request.fixRound : currentTask.fixRound || 0,
    maxFixRounds: status.policy?.maxFixRounds || 3,
  })
  const summary = buildReviewSummary(report, { decision })
  const summaryDir = path.dirname(path.join(resolved, stored.relative))
  const summaryJsonRel = path.relative(resolved, path.join(summaryDir, 'summary.json'))
  const summaryMdRel = path.relative(resolved, path.join(summaryDir, 'summary.md'))
  await writeFile(path.join(resolved, summaryJsonRel), `${JSON.stringify(summary, null, 2)}\n`)
  await writeFile(path.join(resolved, summaryMdRel), renderReviewSummaryMarkdown(summary))

  if (stored.duplicate) {
    const existing = status.reviews?.[report.gate]
    if (existing?.reportRef === stored.relative) {
      return status
    }
  }

  const key = report.gate === 'task' ? `task:${report.taskId}` : report.gate

  return mutateFeature(
    resolved,
    {
      expectedVersion,
      event: {
        type: 'review.accept',
        actor: options.actor || report.reviewer.host,
        data: {
          requestId: report.requestId,
          gate: report.gate,
          taskId: report.taskId,
          verdict: report.verdict,
          reportRef: stored.relative,
          summaryRef: summaryMdRel,
          reviewEvent: summary.event.type,
        },
      },
    },
    (draft) => {
      draft.reviews = {
        ...(draft.reviews || {}),
        [key]: {
          requestId: report.requestId,
          reportRef: stored.relative,
          snapshotId: report.snapshotId,
          verdict: report.verdict,
          specVerdict: report.specVerdict,
          qualityVerdict: report.qualityVerdict,
          independence: report.reviewer.independence,
          acceptedAt: new Date().toISOString(),
          definitionRevision: draft.consistency?.revision ?? 0,
          summaryRef: summaryMdRel,
          reviewEvent: summary.event.type,
        },
      }
      if (report.gate === 'task' && report.taskId) {
        draft.runtime = draft.runtime || { activeTaskId: null, attempts: {}, taskResults: {} }
        const current = draft.runtime.taskResults?.[report.taskId] || {}
        const nextTask = {
          ...current,
          reviewStatus: report.verdict === 'pass' ? 'passed' : report.verdict,
          lastReviewRef: stored.relative,
          reviewDecision: decision.action,
          escalateTo: decision.escalateTo,
          reviewEvent: summary.event.type,
          lastSummaryRef: summaryMdRel,
        }
        if (decision.action === 'accept' && report.verdict === 'pass') {
          nextTask.status = 'passed'
        } else if (decision.action === 'repair' || decision.action === 'collect_evidence') {
          nextTask.status = 'repairing'
          if (decision.action === 'repair') nextTask.fixRound = (current.fixRound || 0) + 1
        } else if (decision.action === 'ask_human') {
          nextTask.status = 'blocked'
          nextTask.reasonCode = 'NEEDS_HUMAN'
        }
        draft.runtime.taskResults = {
          ...(draft.runtime.taskResults || {}),
          [report.taskId]: nextTask,
        }
      }
    },
  )
}

export { STAGE_DOC_GATES, DUAL_GATES, GATES }
