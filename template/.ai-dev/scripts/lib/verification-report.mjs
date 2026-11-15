/** Read the complete Playwright JSON report; exit 0 alone never proves a case. */
import path from 'node:path'
import { readFile, realpath } from 'node:fs/promises'

export async function readEvidenceFile(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error(`Invalid evidence path: ${relative}`)
  const absolute = await realpath(path.resolve(root, relative))
  const base = await realpath(root)
  if (!absolute.startsWith(`${base}${path.sep}`)) throw new Error(`Evidence escapes root: ${relative}`)
  return readFile(absolute)
}

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
  if (report.errors?.length) errors.push('Playwright reported global/setup errors')
  const root = await realpath(projectRoot)
  const reportRoot = await realpath(report.config.rootDir)
  const tests = await Promise.all(flatten(report.suites, reportRoot).map(async (item) => ({ ...item, file: await realpath(item.file).catch(() => item.file) })))
  if (!tests.length) errors.push('No tests collected')
  const clean = (test) => test.expectedStatus === 'passed' && test.status === 'expected' && test.results?.length === 1 && test.results[0].status === 'passed' && (test.results[0].retry || 0) === 0
  if (tests.some(({ test }) => !clean(test))) errors.push('Report contains failed, skipped, expected-failure, interrupted or flaky tests')

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
      if (context.environmentId !== environment.id || context.baseURL !== environment.baseURL) throw new Error('Wrong observed environment/baseURL')
      if (!Array.isArray(context.mockedRoutes) || !context.mockHits || typeof context.mockHits !== 'object') throw new Error('Missing observed mock routes/hits')
      const declared = new Set((environment.mocks || []).map((mock) => mock.id))
      if (context.mockedRoutes.some((id) => !declared.has(id)) || Object.keys(context.mockHits).some((id) => !declared.has(id))) throw new Error('Undeclared mocked route')
      if (environment.kind === 'live-test' && (context.mockedRoutes.length || Object.values(context.mockHits).some((n) => n > 0))) throw new Error('Live integration used substituted responses')
      for (const id of tc.mockRuleIds || []) {
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
  if (results.some((item) => item.status !== 'passed')) errors.push('Required cases did not pass with complete environment evidence')
  return { cases: results, errors, evidencePaths: [...evidencePaths] }
}
