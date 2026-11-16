import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { acceptanceFixture } from './helpers/acceptance.mjs'
import { runVerification } from '../template/.ai-dev/scripts/lib/verification.mjs'
import { writeJsonAtomic, acceptanceReadiness } from '../template/.ai-dev/scripts/lib/acceptance.mjs'
import {writeFile} from 'node:fs/promises'
import { readFeature } from '../template/.ai-dev/scripts/lib/workspace-store.mjs'
import { readPlaywrightReport } from '../template/.ai-dev/scripts/lib/verification-report.mjs'

// Synthetic protocol fixtures: these test ingestion/state accounting, not browser behavior.
test('a blocked case cannot mask a failed case or suppress its repair accounting', async () => {
  const f = await acceptanceFixture()
  const second = structuredClone(f.delivery.testCases[0])
  second.id = second.implementation.testId = 'TC-2'
  f.delivery.testCases.push(second)
  const check = f.delivery.verification.checks[0]
  check.report = 'browser-json'
  check.caseIds.push('TC-2')
  const context = { environmentId: 'mock', baseURL: 'http://127.0.0.1:3000', mockedRoutes: ['profile'], mockHits: { profile: 1 } }
  const report = { schemaVersion: 1, engine: 'ego-browser', errors: [], cases: [
    { caseId: 'TC-1', file: 'tests/cases.spec.mjs', testId: 'TC-1', attempts: 1, result: 'blocked', context,
      preconditionResults: [{ index: 0, result: 'unmet', observation: 'Required populated data is absent' }], expectationResults: [] },
    { caseId: 'TC-2', file: 'tests/cases.spec.mjs', testId: 'TC-2', attempts: 1, result: 'failed', context,
      preconditionResults: [{ index: 0, result: 'met', observation: 'Required fixture is available' }],
      expectationResults: [{ id: 'E1', result: 'failed', observation: 'Wrong rendered response' }] },
  ] }
  check.args = ['-e', `const report=${JSON.stringify(report)};report.runId=process.env.WORKFLOW_RUN_ID;require('fs').writeFileSync(process.env.WORKFLOW_JSON_OUTPUT_FILE,JSON.stringify(report));process.exitCode=1`]
  await writeJsonAtomic(path.join(f.featureDir, 'artifacts/design/delivery.json'), f.delivery)
  const run = await runVerification(f.featureDir, { scope: 'feature', checkId: 'browser' })
  assert.deepEqual(run.cases.map(c => c.status), ['blocked', 'failed'])
  assert.equal(run.status, 'failed')
  assert.equal((await readFeature(f.featureDir)).runtime.verificationRepairs['feature:feature:browser'].consecutiveFailures, 1)
})

test('Playwright skips with an observed unmet precondition block without spending repair rounds', async () => {
  const f = await acceptanceFixture()
  const pwTest = f.report.suites[0].specs[0].tests[0]
  pwTest.expectedStatus = 'skipped'
  pwTest.results[0].status = 'skipped'
  const attachment = pwTest.results[0].attachments[0]
  const context = JSON.parse(Buffer.from(attachment.body, 'base64'))
  context.result = 'blocked'
  context.preconditionResults = [{ index: 0, result: 'unmet', observation: 'Required login is unavailable' }]
  context.expectationResults = []
  attachment.body = Buffer.from(JSON.stringify(context)).toString('base64')
  f.delivery.verification.checks[0].args = ['-e', `require('fs').writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE,${JSON.stringify(JSON.stringify(f.report))})`]
  await writeJsonAtomic(path.join(f.featureDir, 'artifacts/design/delivery.json'), f.delivery)
  const run = await runVerification(f.featureDir, { scope: 'feature', checkId: 'browser' })
  assert.equal(run.status, 'blocked')
  assert.equal(run.cases[0].status, 'blocked')
  assert.equal((await readFeature(f.featureDir)).runtime.verificationRepairs['feature:feature:browser'].consecutiveFailures, 0)

  const options = { check: f.delivery.verification.checks[0], cases: f.delivery.testCases, environment: f.delivery.verification.environments[0], projectRoot: f.root, outputDir: path.dirname(path.join(f.featureDir, run.rawReportPath)) }
  const ordinarySkip = structuredClone(f.report)
  ordinarySkip.suites[0].specs[0].tests[0].results[0].attachments[0].body = Buffer.from(JSON.stringify({ ...context, result: 'passed', preconditionResults: [] })).toString('base64')
  assert.equal((await readPlaywrightReport(ordinarySkip, options)).cases[0].status, 'failed')
  const assertionFailure = structuredClone(f.report)
  assertionFailure.suites[0].specs[0].tests[0].results[0].errors = [{ message: 'An assertion actually failed' }]
  assert.equal((await readPlaywrightReport(assertionFailure, options)).cases[0].status, 'failed')
  assert.equal((await acceptanceReadiness(f.featureDir)).cases[0].status,'blocked')
  await writeFile(path.join(f.root,'tests/cases.spec.mjs'),'// candidate changed\n')
  assert.equal((await acceptanceReadiness(f.featureDir)).cases[0].status,'not_verified')
})
