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
 * @returns {{action: 'accept'|'repair'|'ask_human', reason: string}}
 */
export function decideReviewAction({ report, fixRound = 0, maxFixRounds = 3 }) {
  if (!report || typeof report !== 'object') {
    return { action: 'ask_human', reason: 'missing report' }
  }

  if (report.verdict === 'pass') {
    return { action: 'accept', reason: 'review passed' }
  }

  if (report.verdict === 'needs_human') {
    return { action: 'ask_human', reason: 'reviewer requested human' }
  }

  const findings = Array.isArray(report.findings) ? report.findings : []
  if (findings.some((finding) => finding.requiresHuman === true)) {
    return { action: 'ask_human', reason: 'finding requiresHuman' }
  }

  // Ambiguity / ownership / conflict style findings escalate immediately.
  if (
    findings.some(
      (finding) =>
        finding.severity === 'blocking' &&
        (BUSINESS_RULES.has(finding.ruleId) || /conflict|ownership|contract/i.test(finding.message || '')),
    )
  ) {
    return { action: 'ask_human', reason: 'business conflict or ownership ambiguity' }
  }

  const unresolvedMajor = findings.some(
    (finding) => finding.severity === 'blocking' || finding.severity === 'major',
  )

  if (!unresolvedMajor && report.verdict === 'revise') {
    // Only minors left — still go to human checklist rather than silent accept.
    return { action: 'ask_human', reason: 'minor findings need human checklist' }
  }

  if (unresolvedMajor) {
    if (fixRound >= maxFixRounds) {
      return { action: 'ask_human', reason: `maxFixRounds ${maxFixRounds} exhausted` }
    }
    return { action: 'repair', reason: `repair round ${fixRound + 1} of ${maxFixRounds}` }
  }

  return { action: 'ask_human', reason: 'unhandled verdict' }
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
