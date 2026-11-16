/** Requirement acceptance definitions. Structural coverage is not semantic approval. */
import path from 'node:path'

const text = (value) => typeof value === 'string' && value.trim().length > 0
const list = (value) => Array.isArray(value) ? value : []
const relative = (value) => text(value) && !path.isAbsolute(value) && !value.split(/[\\/]/).includes('..') && !value.startsWith('.ai-dev/') && value !== '.'

export function validateAcceptancePlan(delivery, phase = 'plan') {
  const errors = []
  const add = (code, message) => errors.push({ code, ruleId: code, message })
  const ids = (items, name) => {
    const seen = new Set()
    for (const item of list(items)) {
      if (!text(item?.id) || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(item.id) || seen.has(item.id)) add('INVALID_ID', `${name}: missing, unsafe or duplicate id ${item?.id}`)
      seen.add(item?.id)
    }
    return seen
  }
  for (const ac of delivery.acceptance || []) {
    if (!['test', 'manual', 'inspection'].includes(ac.verification)) add('INVALID_METHOD', `${ac.id}: verification must be test|manual|inspection`)
  }
  if (phase === 'spec') return { ok: errors.length === 0, errors }

  const cases = list(delivery.testCases)
  const verification = delivery.verification || {}
  const checks = list(verification.checks)
  const environments = list(verification.environments)
  const caseIds = ids(cases, 'testCases')
  const checkIds = ids(checks, 'checks')
  const environmentIds = ids(environments, 'environments')
  const tasks = delivery.tasks || []
  const acceptance = delivery.acceptance || []
  const finalIds = list(verification.finalCheckIds)
  if (!Array.isArray(delivery.testCases) || !cases.length) add('MISSING_CASES', 'testCases must describe the acceptance scenarios')
  if (!Array.isArray(verification.inputs) || !verification.inputs.length) add('MISSING_VERIFICATION_INPUTS', 'verification.inputs must bind original requirements/contracts or their local snapshots')
  for (const input of list(verification.inputs)) {
    if (!['feature', 'project'].includes(input?.space) || !relative(input?.path)) add('INVALID_INPUT', 'verification.inputs requires a confined space/path')
    if (input?.space === 'feature' && /^(revisions\/|artifacts\/verification\/|status\.json)/.test(input.path)) add('OUTPUT_AS_INPUT', 'Verification outputs cannot be execution inputs')
  }
  for (const env of environments) {
    if (!['local', 'contract-mock', 'live-test'].includes(env.kind)) add('INVALID_ENVIRONMENT', `${env.id}: kind must be local|contract-mock|live-test`)
    if (!text(env.setup) || !text(env.reset)) add('MISSING_ENVIRONMENT_SETUP', `${env.id}: setup and reset instructions are required`)
    if (!Array.isArray(env.inputs) || !env.inputs.length || env.inputs.some((item) => !relative(item))) add('INVALID_ENVIRONMENT_INPUTS', `${env.id}: inputs must include config/fixture files`)
    if (env.runtime && (!relative(env.runtime.file) || !text(env.runtime.profile))) add('INVALID_RUNTIME', `${env.id}: runtime requires a project file and profile`)
    if (env.kind !== 'local' && (!text(env.baseURL) || !text(env.projectName))) add('MISSING_BROWSER_ENVIRONMENT', `${env.id}: baseURL and Playwright projectName required`)
    const mocks = list(env.mocks)
    ids(mocks, `${env.id}.mocks`)
    if (env.kind === 'live-test' && mocks.length) add('LIVE_WITH_MOCKS', `${env.id}: live-test must not replace responses`)
    if (env.kind === 'contract-mock' && !mocks.length) add('MISSING_MOCK_RULES', `${env.id}: declare narrow interception rules`)
    if (env.kind !== 'local') {
      if (!relative(env.contract?.path) || !/^[a-f0-9]{64}$/.test(env.contract?.sha256 || '')) add('MISSING_CONTRACT', `${env.id}: confirmed contract path and sha256 required`)
    }
    for (const mock of mocks) {
      if (!text(mock.method) || !text(mock.url) || !relative(mock.fixture)) add('INVALID_MOCK', `${env.id}/${mock.id}: method, URL and fixture required`)
    }
  }
  for (const tc of cases) {
    if (!['browser', 'manual', 'inspection'].includes(tc.method)) add('INVALID_METHOD', `${tc.id}: method must be browser|manual|inspection`)
    if (!list(tc.acceptanceIds).length) add('CASE_WITHOUT_ACCEPTANCE', `${tc.id}: acceptanceIds required`)
    for (const id of list(tc.acceptanceIds)) {
      const ac = acceptance.find((item) => item.id === id)
      if (!ac) add('UNKNOWN_ACCEPTANCE', `${tc.id}: unknown ${id}`)
      else if (ac.verification !== (tc.method === 'browser' ? 'test' : tc.method)) add('METHOD_MISMATCH', `${tc.id}: method differs from ${id}`)
    }
    if (!environmentIds.has(tc.environmentId)) add('UNKNOWN_ENVIRONMENT', `${tc.id}: unknown ${tc.environmentId}`)
    if (!list(tc.requiredAt).includes('feature')) add('MISSING_FINAL_CASE', `${tc.id}: feature is required`)
    for (const at of list(tc.requiredAt)) {
      if (at !== 'feature' && !tasks.some((task) => at === `task:${task.id}`)) add('UNKNOWN_CASE_SCOPE', `${tc.id}: unknown ${at}`)
    }
    for (const field of ['preconditions', 'steps', 'expectations']) {
      if (!list(tc[field]).length) add('INCOMPLETE_CASE', `${tc.id}: ${field} required`)
    }
    for (const expectation of list(tc.expectations)) {
      if (!text(expectation?.id) || !text(expectation.expected) || !['ui', 'network', 'navigation', 'storage', 'document'].includes(expectation.observable)) add('INVALID_EXPECTATION', `${tc.id}: expected observable result required`)
    }
    ids(tc.expectations, `${tc.id}.expectations`)
    if (tc.method === 'inspection' && list(tc.expectations).some(e => e.observable !== 'document')) add('STATIC_AS_RUNTIME', `${tc.id}: inspection only proves document/source facts; UI/network behavior needs execution`)
    if (tc.method === 'manual' && (!['human-judgment', 'physical-device', 'external-action'].includes(tc.manualReason?.category) || !text(tc.manualReason?.reason) || !list(tc.manualReason?.sourceRefs).length)) add('MANUAL_REASON_REQUIRED', `${tc.id}: justify why this expectation needs a human; missing test tooling is not a reason`)
    if (tc.method === 'browser') {
      if (!relative(tc.implementation?.file) || !text(tc.implementation?.testId)) add('MISSING_TEST_IMPLEMENTATION', `${tc.id}: file and stable testId required`)
      if (!relative(tc.dataRef)) add('MISSING_TEST_DATA', `${tc.id}: dataRef required`)
      const env = environments.find((item) => item.id === tc.environmentId)
      if (env?.runtime && (!text(tc.entry?.id) || !tc.entry?.bindings || typeof tc.entry.bindings !== 'object')) add('MISSING_ENTRY', `${tc.id}: runtime cases need entry.id and bindings (may be empty)`)
      if (env?.kind === 'local') add('INVALID_BROWSER_ENVIRONMENT', `${tc.id}: use contract-mock or live-test`)
      for (const id of list(tc.mockRuleIds)) {
        if (!list(env?.mocks).some((mock) => mock.id === id)) add('UNKNOWN_MOCK', `${tc.id}: unknown mock ${id}`)
      }
      if (env?.kind === 'contract-mock' && !list(tc.mockRuleIds).length) add('MISSING_MOCK_HITS', `${tc.id}: declare required mockRuleIds`)
    }
  }
  for (const ac of acceptance) {
    if (!cases.some((tc) => list(tc.acceptanceIds).includes(ac.id))) add('ACCEPTANCE_WITHOUT_CASE', `${ac.id}: no case`)
  }
  for (const check of checks) {
    if (!['engineering', 'acceptance'].includes(check.kind) || !text(check.command) || !Array.isArray(check.args) || check.args.some((arg) => typeof arg !== 'string')) add('INVALID_CHECK', `${check.id}: kind, command and string args required`)
    if (check.cwd && check.cwd !== '.' && !relative(check.cwd)) add('PATH_ESCAPE', `${check.id}: cwd must stay inside project`)
    if (!environmentIds.has(check.environmentId)) add('UNKNOWN_ENVIRONMENT', `${check.id}: unknown environment`)
    if (check.kind === 'acceptance' && (!['playwright-json', 'browser-json'].includes(check.report) || !list(check.caseIds).length)) add('MISSING_CASE_REPORT', `${check.id}: full supported browser report and caseIds required`)
    if (check.kind === 'engineering' && list(check.caseIds).length) add('ENGINEERING_AS_ACCEPTANCE', `${check.id}: engineering checks cannot prove cases`)
    for (const id of list(check.caseIds)) {
      const tc = cases.find((item) => item.id === id)
      if (!caseIds.has(id) || tc.method !== 'browser' || tc.environmentId !== check.environmentId) add('CASE_CHECK_MISMATCH', `${check.id}: wrong case/method/environment for ${id}`)
    }
  }
  for (const id of finalIds) if (!checkIds.has(id)) add('UNKNOWN_CHECK', `finalCheckIds: ${id}`)
  for (const task of tasks) {
    if (!Array.isArray(task.verifyIds) || !task.verifyIds.length) add('MISSING_VERIFY', `${task.id}: verifyIds required`)
    if (task.verify) add('AMBIGUOUS_VERIFY', `${task.id}: v2 uses verifyIds, remove inline verify`)
    for (const id of list(task.verifyIds)) if (!checkIds.has(id)) add('UNKNOWN_CHECK', `${task.id}: ${id}`)
  }
  for (const tc of cases.filter((item) => item.method === 'browser')) {
    for (const at of list(tc.requiredAt)) {
      const requiredIds = at === 'feature' ? finalIds : list(tasks.find((task) => at === `task:${task.id}`)?.verifyIds)
      if (!checks.some((check) => requiredIds.includes(check.id) && list(check.caseIds).includes(tc.id))) add('CASE_NOT_SCHEDULED', `${tc.id}: no check scheduled at ${at}`)
    }
  }
  const mappings = new Set()
  for (const tc of cases.filter((item) => item.method === 'browser')) {
    const key = `${tc.environmentId}:${tc.implementation?.file}:${tc.implementation?.testId}`
    if (mappings.has(key)) add('AMBIGUOUS_TEST_ID', `${tc.id}: test already mapped in this environment`)
    mappings.add(key)
  }
  return { ok: errors.length === 0, errors }
}

/** Preserve old commands; leave unknown semantics as gaps for source-backed completion. */
export function draftDeliveryUpgrade(delivery) {
  if (delivery.schemaVersion !== 1) throw new Error('Only delivery v1 needs an upgrade draft')
  const draft = structuredClone(delivery)
  draft.schemaVersion = 2
  draft.testCases = []
  draft.verification = { inputs: [], environments: [], checks: [], finalCheckIds: [] }
  for (const task of draft.tasks) {
    task.verifyIds = (task.verify || []).map((command, index) => {
      const id = `${task.id}-CHECK-${index + 1}`
      draft.verification.checks.push({ ...command, id, kind: 'engineering', environmentId: null, caseIds: [] })
      return id
    })
    delete task.verify
  }
  return draft
}

export function taskChecks(delivery, task) {
  return delivery.schemaVersion === 2
    ? (task.verifyIds || []).map((id) => delivery.verification?.checks?.find((check) => check.id === id)).filter(Boolean)
    : task.verify || []
}
