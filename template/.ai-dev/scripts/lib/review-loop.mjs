/**
 * Bounded repair / re-review decisions for independent reviews.
 */

const BUSINESS_RULES = new Set([
  'SCOPE-CONFLICTS',
  'SCOPE-OWNERSHIP',
  'SPEC-OBSERVABLE',
])

/**
 * @param {{report: object, fixRound: number, maxFixRounds?: number}} input
 * @returns {{action: 'accept'|'repair'|'collect_evidence'|'ask_human', escalateTo: 'none'|'main'|'human', reason: string}}
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
 * Merge re-review addressing map; unresolved majors block done.
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
