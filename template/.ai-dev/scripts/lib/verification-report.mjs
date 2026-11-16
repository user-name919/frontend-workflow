/** Read the complete Playwright JSON report; exit 0 alone never proves a case. */
import path from 'node:path'
import { realpath } from 'node:fs/promises'
import { readEvidenceFile } from './evidence-files.mjs'
import { observedCaseErrors } from './case-evidence.mjs'
import { loadTestRuntime, runtimeEvidenceErrors } from './test-runtime.mjs'
export { readEvidenceFile } from './evidence-files.mjs'

function flatten(suites, rootDir) {
  const tests = []
  for (const suite of suites || []) {
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) tests.push({ spec, test, file: path.resolve(rootDir, spec.file) })
    }
    tests.push(...flatten(suite.suites, rootDir))
  }
  return tests
}

export async function readPlaywrightReport(report, { check, cases, environment, projectRoot, outputDir }) {
  const errors = []
  const evidencePaths = new Set()
  const results = []
  if (!Array.isArray(report?.suites) || typeof report.config?.rootDir !== 'string') {
    return { cases: [], errors: ['Missing complete Playwright suites/config'], evidencePaths: [] }
  }
  const globalErrors = []
  if (report.errors?.length) globalErrors.push('Playwright reported global/setup errors')
  const root = await realpath(projectRoot)
  const reportRoot = await realpath(report.config.rootDir)
  const runtime = await loadTestRuntime(projectRoot, environment)
  const tests = await Promise.all(flatten(report.suites, reportRoot).map(async (item) => ({ ...item, file: await realpath(item.file).catch(() => item.file) })))
  if (!tests.length) globalErrors.push('No tests collected')
  const clean = (test) => test.expectedStatus === 'passed' && test.status === 'expected' && test.results?.length === 1 && test.results[0].status === 'passed' && (test.results[0].retry || 0) === 0
  const handled = new Set()

  for (const caseId of check.caseIds || []) {
    const tc = cases.find((item) => item.id === caseId)
    const matches = tests.filter(({ spec, test, file }) => {
      const id = tc.implementation.testId
      const declared = (test.annotations || []).filter((annotation) => annotation.type === 'acceptance-case').map((annotation) => annotation.description)
      const identified = declared.length ? declared.length === 1 && declared[0] === id : spec.title === id || spec.title.startsWith(`[${id}] `)
      return identified && file === path.resolve(root, tc.implementation.file) && test.projectName === environment.projectName
    })
    const outcome = { caseId, environmentId: environment.id, status: 'failed', testId: tc.implementation.testId, file: tc.implementation.file, errors: [] }
    if (matches.length !== 1) {
      outcome.errors.push(`Expected one matching test/file/project; found ${matches.length}`)
      results.push(outcome)
      continue
    }
    const { test } = matches[0]
    handled.add(test)
    outcome.status = clean(test) ? 'passed' : test.status === 'flaky' || test.results?.length > 1 ? 'flaky' : 'failed'
    outcome.attempts = (test.results || []).map((item) => ({ status: item.status, retry: item.retry, errors: item.errors || [] }))
    const last = test.results?.at(-1)
    const contexts = (last?.attachments || []).filter((item) => item.name === 'acceptance-context')
    try {
      if (contexts.length !== 1) throw new Error('Each case must attach one acceptance-context')
      const contextAttachment = contexts[0]
      let bytes
      if (contextAttachment.body) bytes = Buffer.from(contextAttachment.body, 'base64')
      else {
        const relative = path.relative(outputDir, contextAttachment.path || '')
        bytes = await readEvidenceFile(outputDir, relative)
        evidencePaths.add(relative)
      }
      const context = JSON.parse(bytes)
      // 只有附有真实未满足前提、没有执行失败的单次 skip 才是准备阻塞。
      const blocked = context.result === 'blocked' && test.results?.length === 1 && last.status === 'skipped' && !(last.retry || 0) && !(last.errors || []).length
      if (blocked) outcome.status = 'blocked'
      if (context.environmentId !== environment.id || context.baseURL !== environment.baseURL) throw new Error('Wrong observed environment/baseURL')
      const problems = [...(blocked ? [] : runtimeEvidenceErrors(runtime, tc, context)), ...observedCaseErrors(tc, { ...context, result: outcome.status })]
      if (problems.length) throw new Error(problems.join('; '))
      if (!Array.isArray(context.mockedRoutes) || !context.mockHits || typeof context.mockHits !== 'object') throw new Error('Missing observed mock routes/hits')
      const declared = new Set((environment.mocks || []).map((mock) => mock.id))
      if (context.mockedRoutes.some((id) => !declared.has(id)) || Object.keys(context.mockHits).some((id) => !declared.has(id))) throw new Error('Undeclared mocked route')
      if (environment.kind === 'live-test' && (context.mockedRoutes.length || Object.values(context.mockHits).some((n) => n > 0))) throw new Error('Live integration used substituted responses')
      for (const id of blocked ? [] : tc.mockRuleIds || []) {
        if (!context.mockedRoutes.includes(id) || !Number.isInteger(context.mockHits[id]) || context.mockHits[id] < 1) throw new Error(`Required mock was not hit: ${id}`)
      }
      outcome.context = context
      for (const attachment of last?.attachments || []) {
        if (attachment.path) {
          const relative = path.relative(outputDir, attachment.path)
          await readEvidenceFile(outputDir, relative)
          evidencePaths.add(relative)
        }
      }
    } catch (error) {
      outcome.errors.push(error.message)
      outcome.status = 'failed'
    }
    results.push(outcome)
  }
  if (tests.some(({test}) => !handled.has(test) && !clean(test))) globalErrors.push('Unmapped test did not pass')
  errors.push(...globalErrors)
  if (results.some((item) => item.status !== 'passed')) errors.push('Required cases did not pass with complete environment evidence')
  return { cases: results, errors, globalErrors, evidencePaths: [...evidencePaths] }
}

/** 接纳可重复浏览器脚本的真实报告，避免把 Agent 浏览器操作伪装成人工确认。 */
export async function readBrowserReport(report, { check, cases, environment, projectRoot, outputDir }) {
  const errors = []
  const results = []
  const evidencePaths = new Set()
  const runtime = await loadTestRuntime(projectRoot, environment)
  if (report.schemaVersion !== 1 || report.engine !== 'ego-browser' || !Array.isArray(report.cases) || report.runId !== path.basename(outputDir)) return { cases: [], errors: ['Missing/wrong browser report identity'], evidencePaths: [] }
  const globalErrors = []
  if (report.errors?.length) globalErrors.push('Browser suite reported errors')
  if (report.cases.some(item => !check.caseIds.includes(item.caseId))) globalErrors.push('Report contains undeclared cases')
  for (const caseId of check.caseIds) {
    const tc = cases.find(item => item.id === caseId)
    const matches = report.cases.filter(item => item.caseId === caseId)
    const item = matches[0]
    const problems = []
    if (matches.length !== 1 || item?.file !== tc.implementation.file || item?.testId !== tc.implementation.testId || item?.attempts !== 1) problems.push('Missing/duplicate/wrong test identity or retry')
    if (item) problems.push(...observedCaseErrors(tc, item))
    const context = item?.context
    if (!context || context.environmentId !== environment.id || context.baseURL !== environment.baseURL) problems.push('Wrong observed environment/baseURL')
    else {
      if (item.result !== 'blocked') problems.push(...runtimeEvidenceErrors(runtime, tc, context))
      const declared = new Set((environment.mocks || []).map(mock => mock.id))
      if (!Array.isArray(context.mockedRoutes) || !context.mockHits || context.mockedRoutes.some(id => !declared.has(id)) || Object.keys(context.mockHits).some(id => !declared.has(id))) problems.push('Missing/undeclared observed mocks')
      if (environment.kind === 'live-test' && (context.mockedRoutes?.length || Object.values(context.mockHits || {}).some(n => n > 0))) problems.push('Live integration used substituted responses')
      for (const id of item.result === 'blocked' ? [] : tc.mockRuleIds || []) if (!context.mockedRoutes?.includes(id) || !Number.isInteger(context.mockHits?.[id]) || context.mockHits[id] < 1) problems.push(`Required mock was not hit: ${id}`)
    }
    for (const file of item?.attachments || []) {
      try { await readEvidenceFile(outputDir, file); evidencePaths.add(file) } catch (error) { problems.push(error.message) }
    }
    const status = !problems.length && item?.result === 'blocked' ? 'blocked' : item?.result === 'passed' && !problems.length ? 'passed' : 'failed'
    results.push({ caseId, environmentId: environment.id, method: 'browser', status, errors: problems, context, preconditionResults: item?.preconditionResults || [], expectationResults: item?.expectationResults || [] })
    if (status !== 'passed') errors.push(`${caseId}: ${status}${problems.length ? ': ' + problems.join('; ') : ''}`)
  }
  errors.push(...globalErrors)
  return { cases: results, errors, globalErrors, evidencePaths: [...evidencePaths] }
}

export function readAcceptanceReport(report, options) {
  return options.check.report === 'browser-json' ? readBrowserReport(report, options) : readPlaywrightReport(report, options)
}
