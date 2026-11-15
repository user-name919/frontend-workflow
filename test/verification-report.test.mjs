import assert from 'node:assert/strict'
import test from 'node:test'
import { readPlaywrightReport } from '../template/.ai-dev/scripts/lib/verification-report.mjs'
import { acceptanceFixture, playwrightReport } from './helpers/acceptance.mjs'

test('report adapter rejects missing, ambiguous, wrong-file/project, flaky and expected-failure cases', async () => {
  const f = await acceptanceFixture()
  const options = { check: f.delivery.verification.checks[0], cases: f.delivery.testCases, environment: f.delivery.verification.environments[0], projectRoot: f.root, outputDir: f.featureDir }
  assert.deepEqual((await readPlaywrightReport(f.report, options)).errors, [])
  for (const mutate of [
    (r) => { r.suites[0].specs = [] },
    (r) => { r.suites[0].specs.push(structuredClone(r.suites[0].specs[0])) },
    (r) => { r.suites[0].specs[0].file = 'other.spec.mjs' },
    (r) => { r.suites[0].specs[0].tests[0].projectName = 'live' },
    (r) => { r.suites[0].specs[0].tests[0].expectedStatus = 'failed' },
    (r) => { r.suites[0].specs[0].tests[0].results.unshift({ status: 'failed', retry: 0 }) },
    (r) => { r.errors = [{ message: 'webServer failed' }] },
  ]) {
    const report = structuredClone(f.report)
    mutate(report)
    assert.ok((await readPlaywrightReport(report, options)).errors.length)
  }
})

test('declared fault must hit; live-test evidence cannot contain mocked routes', async () => {
  const f = await acceptanceFixture()
  const env = f.delivery.verification.environments[0]
  const options = { check: f.delivery.verification.checks[0], cases: f.delivery.testCases, environment: env, projectRoot: f.root, outputDir: f.featureDir }
  const report = playwrightReport(f.root)
  const context = { environmentId: env.id, baseURL: env.baseURL, mockedRoutes: ['profile'], mockHits: { profile: 0 } }
  report.suites[0].specs[0].tests[0].results[0].attachments[0].body = Buffer.from(JSON.stringify(context)).toString('base64')
  assert.ok((await readPlaywrightReport(report, options)).errors.length)
  const live = { ...options, environment: { ...env, kind: 'live-test', mocks: [] } }
  assert.ok((await readPlaywrightReport(f.report, live)).errors.length)
})
