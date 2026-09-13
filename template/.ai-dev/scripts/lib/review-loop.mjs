/**
 * 解决什么问题：独立审核未通过时，要决定修、补证还是问人，且不能无限修。
 * 通过什么方式解决：按 verdict/findings 映射 action；escalateTo 仅为 none/main/human；修复最多 maxFixRounds（默认 3）。
 * 触发时机：acceptReview 落库时、生成 summary 时。
 * 被谁控制触发：reviews / review-summary。
 */

const BUSINESS_RULES = new Set([
  'SCOPE-CONFLICTS',
  'SCOPE-OWNERSHIP',
  'SPEC-OBSERVABLE',
])

/**
 * 把报告收成下一步。escalateTo 只有 none（放行）、main（主 Agent 修/补证）、human（必须问人）。
 * pass → accept/none；needs_human 或业务冲突 → ask_human/human；缺证 → collect_evidence/main。
 * blocking/major 且未满轮次 → repair/main；满 maxFixRounds（默认 3）则问人。
 */
export function decideReviewAction({ report, fixRound = 0, maxFixRounds = 3 }) {
  if (!report || typeof report !== 'object') {
    return { action: 'ask_human', escalateTo: 'human', reason: 'missing report' }
  }

  if (report.verdict === 'pass') {
    return { action: 'accept', escalateTo: 'none', reason: 'review passed; sub-agent may release this task' }
  }

  if (report.verdict === 'needs_human') {
    return { action: 'ask_human', escalateTo: 'human', reason: 'reviewer requested human' }
  }

  if (report.verdict === 'needs_evidence') {
    return {
      action: 'collect_evidence',
      escalateTo: 'main',
      reason: 'missing evidence the main agent can gather',
    }
  }

  const findings = Array.isArray(report.findings) ? report.findings : []
  if (findings.some((finding) => finding.requiresHuman === true)) {
    return { action: 'ask_human', escalateTo: 'human', reason: 'finding requiresHuman' }
  }

  if (
    findings.some(
      (finding) =>
        finding.severity === 'blocking' &&
        (BUSINESS_RULES.has(finding.ruleId) || /conflict|ownership|contract/i.test(finding.message || '')),
    )
  ) {
    return { action: 'ask_human', escalateTo: 'human', reason: 'business conflict or ownership ambiguity' }
  }

  const unresolvedMajor = findings.some(
    (finding) => finding.severity === 'blocking' || finding.severity === 'major',
  )

  if (!unresolvedMajor) {
    return {
      action: 'accept',
      escalateTo: 'none',
      reason: 'no blocking or major findings; minors do not block release',
    }
  }

  // escalateTo 只有 none / main / human；修复最多 3 轮，满额后必须问人。
  if (fixRound >= maxFixRounds) {
    return { action: 'ask_human', escalateTo: 'human', reason: `maxFixRounds ${maxFixRounds} exhausted` }
  }
  return {
    action: 'repair',
    escalateTo: 'main',
    reason: `repair round ${fixRound + 1} of ${maxFixRounds}`,
  }
}

/**
 * 对照 addressing 与新发现。未解决的 blocking/major 阻止 canMarkDone。
 * 只汇总，不改账本。
 */
export function summarizeReReview({ previousFindings = [], addressing = [], newFindings = [] }) {
  const byId = new Map(previousFindings.map((finding) => [finding.id, finding]))
  const unresolved = []
  for (const item of addressing) {
    const prior = byId.get(item.findingId)
    if (!prior) continue
    if (item.status !== 'addressed' && (prior.severity === 'blocking' || prior.severity === 'major')) {
      unresolved.push(prior.id)
    }
  }
  for (const finding of newFindings) {
    if (finding.severity === 'blocking' || finding.severity === 'major') {
      unresolved.push(finding.id)
    }
  }
  return {
    unresolvedMajorIds: [...new Set(unresolved)],
    canMarkDone: unresolved.length === 0,
  }
}
