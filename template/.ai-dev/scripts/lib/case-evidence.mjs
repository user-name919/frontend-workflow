/** 一条用例通过必须覆盖所有前提与预期；登录和页面可见性不能代替业务验收。 */
export function observedCaseErrors(tc, record) {
  const errors = []
  const text = value => typeof value === 'string' && value.trim().length > 0
  const preconditions = record.preconditionResults || []
  const expectations = record.expectationResults || []
  if (!['passed', 'failed', 'blocked'].includes(record.result)) errors.push('Unknown case result')
  if (new Set(preconditions.map(p => p.index)).size !== preconditions.length || preconditions.some(p => !Number.isInteger(p.index) || p.index < 0 || p.index >= tc.preconditions.length)) errors.push('Unknown/duplicate precondition')
  if (new Set(expectations.map(e => e.id)).size !== expectations.length || expectations.some(e => !tc.expectations.some(item => item.id === e.id))) errors.push('Unknown/duplicate expectation')
  if (record.result === 'blocked' && (!preconditions.some(p => p.result === 'unmet' && text(p.observation)) || expectations.some(e => e.result === 'failed'))) errors.push('Blocked needs an observed unmet precondition and no failed expectation')
  if (record.result !== 'passed') return errors
  for (const [index] of tc.preconditions.entries()) {
    const p = preconditions.find(item => item.index === index)
    if (p?.result !== 'met' || !text(p.observation)) errors.push(`Precondition ${index + 1} was not met with an observation`)
  }
  for (const expected of tc.expectations) {
    const e = expectations.find(item => item.id === expected.id)
    if (e?.result !== 'passed' || !text(e.observation)) errors.push(`Expectation ${expected.id} lacks passing observation`)
    if (tc.method === 'inspection' && !e?.evidenceRefs?.length) errors.push(`Inspection ${expected.id} needs concrete source references`)
  }
  if (tc.method === 'manual') {
    const confirmation = record.confirmation
    if (confirmation?.kind !== 'acceptance' || confirmation.caseId !== tc.id || !text(confirmation.actor) || !text(confirmation.sourceRef) || confirmation.sourceRef !== record.confirmationRef || !text(confirmation.quote)) errors.push('Manual pass needs actual acceptance confirmation, not login/setup consent')
    if (tc.expectations.some(e => !confirmation?.expectationIds?.includes(e.id))) errors.push('Human confirmation does not cover every expectation')
  }
  return errors
}
