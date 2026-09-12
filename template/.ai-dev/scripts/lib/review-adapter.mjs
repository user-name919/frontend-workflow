/**
 * Adapt prepare-review / review-delivery v1 packet+report into the workflow review protocol.
 * Contract ok is never gate authorization.
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { validateReview } from './reviews.mjs'

const STAGE_DOC = new Set(['scope', 'spec', 'plan'])

const RULE_BY_KIND = {
  scope: { acceptance: 'SCOPE-SOURCES', engineering: 'SCOPE-OWNERSHIP' },
  spec: { acceptance: 'SPEC-ACCEPTANCE', engineering: 'SPEC-BOUNDARIES' },
  plan: { acceptance: 'PLAN-SCOPE', engineering: 'PLAN-LOCATE' },
  task: { acceptance: 'SPEC-COVERAGE', engineering: 'CODE-QUALITY' },
  final: { acceptance: 'FINAL-TRACE', engineering: 'FINAL-QUALITY' },
}

async function loadContract(projectRoot) {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    projectRoot && path.join(projectRoot, '.agents/skills/prepare-review/scripts/review-contract.mjs'),
    path.resolve(here, '../../../../.agents/skills/prepare-review/scripts/review-contract.mjs'),
    path.resolve(here, '../../../.agents/skills/prepare-review/scripts/review-contract.mjs'),
  ].filter(Boolean)
  let lastError
  for (const candidate of candidates) {
    try {
      return await import(pathToFileURL(candidate).href)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error('prepare-review review-contract.mjs not found')
}

function mapVerdict(verdict) {
  if (verdict === 'needs_human') return 'needs_human'
  if (verdict === 'pass') return 'pass'
  return 'revise'
}

function resultOf(value) {
  if (value === 'pass') return 'pass'
  if (value === 'fail') return 'fail'
  return 'not_run'
}

function mapChecks(packet, report, request) {
  const required = Array.isArray(request.requiredRuleIds) ? request.requiredRuleIds : []
  const byRule = new Map()
  const stage = packet.stage
  for (const check of report.checks || []) {
    const defined = (packet.checks || []).find((item) => item.id === check.checkId)
    const mapped = request.ruleMap?.[check.checkId]
    const ruleId =
      mapped ||
      (defined?.method === 'test' && (stage === 'task' || stage === 'final')
        ? 'TEST-EVIDENCE'
        : RULE_BY_KIND[stage]?.[defined?.kind] || check.checkId)
    const current = byRule.get(ruleId) || { ruleId, result: 'pass', evidence: [] }
    if (check.result === 'fail' || current.result === 'fail') current.result = 'fail'
    else if (check.result === 'unknown' && current.result !== 'fail') current.result = 'not_run'
    const evidence = (check.evidence || []).map((item) => `${item.materialId}:${item.location}`)
    current.evidence.push(...(evidence.length ? evidence : [check.checkId]))
    byRule.set(ruleId, current)
  }

  const checks = []
  const used = new Set()
  for (const ruleId of required) {
    const mapped = byRule.get(ruleId)
    if (mapped) {
      checks.push({ ruleId, result: resultOf(mapped.result), evidence: mapped.evidence })
      used.add(ruleId)
    } else {
      const fallback = [...byRule.values()][0]
      checks.push({
        ruleId,
        result: fallback ? resultOf(fallback.result) : 'not_run',
        evidence: fallback?.evidence || ['adapter:no-direct-packet-check'],
      })
    }
  }
  for (const [ruleId, mapped] of byRule) {
    if (used.has(ruleId) || required.includes(ruleId)) continue
    checks.push({ ruleId, result: resultOf(mapped.result), evidence: mapped.evidence })
  }
  return checks
}

function mapFindings(report) {
  return (report.findings || []).map((finding) => ({
    id: finding.id,
    severity: finding.severity,
    ruleId: finding.checkId,
    location: finding.evidence?.[0]?.location || finding.checkId,
    message: finding.message,
    requestedChange: finding.message,
    requiresHuman: finding.action === 'ask_human',
    action: finding.action,
  }))
}

function dimensionVerdicts(packet, report) {
  if (STAGE_DOC.has(packet.stage)) {
    return {
      specVerdict: report.verdict === 'pass' ? 'pass' : 'fail',
      qualityVerdict: 'not_run',
    }
  }
  const checks = report.checks || []
  const packetChecks = packet.checks || []
  const acceptanceFailed = checks.some((check) => {
    const defined = packetChecks.find((item) => item.id === check.checkId)
    return defined?.kind === 'acceptance' && check.result === 'fail'
  })
  const engineeringFailed = checks.some((check) => {
    const defined = packetChecks.find((item) => item.id === check.checkId)
    return defined?.kind === 'engineering' && check.result === 'fail'
  })
  if (acceptanceFailed) return { specVerdict: 'fail', qualityVerdict: 'not_run' }
  if (report.verdict === 'pass') return { specVerdict: 'pass', qualityVerdict: 'pass' }
  if (engineeringFailed) return { specVerdict: 'pass', qualityVerdict: 'fail' }
  if (report.verdict === 'needs_human') return { specVerdict: 'fail', qualityVerdict: 'not_run' }
  return { specVerdict: 'fail', qualityVerdict: 'not_run' }
}

export function adaptToWorkflowReport(packet, report, request) {
  const dims = dimensionVerdicts(packet, report)
  return {
    schemaVersion: 1,
    requestId: request.requestId,
    snapshotId: request.snapshotId,
    reviewer: {
      runId: report.reviewerId,
      host: request.host || 'assisted',
      model: request.model || 'unknown',
      independence: report.independence === 'independent' ? 'independent' : 'self_check',
    },
    gate: request.gate || packet.stage,
    taskId: request.taskId ?? (packet.stage === 'task' ? packet.reviewId : null),
    verdict: mapVerdict(report.verdict),
    specVerdict: dims.specVerdict,
    qualityVerdict: dims.qualityVerdict,
    checks: mapChecks(packet, report, request),
    findings: mapFindings(report),
    packetReviewId: packet.reviewId,
    packetDigest: packet.snapshot?.digest || report.snapshotDigest,
    sourceVerdict: report.verdict,
  }
}

export function workflowActionFromDelivery(verdict) {
  if (verdict === 'pass') return 'accept'
  if (verdict === 'needs_human') return 'ask_human'
  if (verdict === 'needs_evidence') return 'collect_evidence'
  return 'repair'
}

/**
 * Validate the skill contract, adapt, and validate the workflow report.
 * authorizesGate is always false here.
 */
export async function adaptDeliveryReview({ packet, report, request, projectRoot }) {
  const api = await loadContract(projectRoot)
  const packetErrors = await api.verifyPacket(packet, projectRoot)
  const reportErrors = packetErrors.length ? packetErrors : await api.validateReport(packet, report, projectRoot)
  const workflowReport = adaptToWorkflowReport(packet, report, request)
  const workflowValidation = validateReview(workflowReport, { request })
  return {
    contractOk: reportErrors.length === 0,
    contractErrors: reportErrors,
    workflowReport,
    workflowValidation,
    workflowAction: workflowActionFromDelivery(report.verdict),
    authorizesGate: false,
    note: 'prepare-review/review-delivery contract ok is not workflow gate authorization',
  }
}
