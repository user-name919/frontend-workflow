import { test, expect } from '@playwright/test'
import { capture } from './evidence.mjs'
let responseObservation
test.beforeEach(() => { responseObservation = null })
test.afterEach(async ({ page, baseURL }, testInfo) => {
  const shot = await capture(page, testInfo, testInfo.status || 'end').catch(() => null)
  await testInfo.attach('acceptance-context', { contentType: 'application/json', body: Buffer.from(JSON.stringify({ environmentId: process.env.WORKFLOW_ENVIRONMENT_ID || 'live', baseURL, mockedRoutes: [], mockHits: {}, preconditionResults: [{ index: 0, result: responseObservation ? 'met' : 'unmet', observation: responseObservation || 'No backend response observed' }], expectationResults: [{ id: 'E1', result: testInfo.status === 'passed' ? 'passed' : 'failed', observation: `${responseObservation || 'No response'}; assertions ${testInfo.status}`, screenshotRefs: shot ? [shot] : [] }] })) })
})
// No response interception in this project. The temporary HTTP service is the integration peer.
test('[TC-LIVE] real request follows the confirmed demo contract', async ({ page }) => {
  await page.goto('/')
  const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/profile')
  await page.getByRole('button', { name: '加载', exact: true }).click()
  const response = await responsePromise
  responseObservation = `HTTP ${response.status()}, backend=${response.headers()['x-demo-backend']}`
  expect(response.status(), 'E-LIVE-HTTP').toBe(200)
  expect(response.headers()['x-demo-backend'], 'E-LIVE-SERVICE').toBe('local-service-v1')
  const body = await response.json()
  expect(typeof body.name, 'E-LIVE-NAME-CONTRACT').toBe('string')
  expect(Number.isInteger(body.revision), 'E-LIVE-REVISION-CONTRACT').toBe(true)
  await expect(page.locator('#status')).toHaveText('success')
  await expect(page.locator('#data'), 'E-LIVE-UI-RESPONSE').toHaveText(JSON.stringify(body, null, 2))
  responseObservation += `, returned revision=${body.revision}, UI matched exact response after click`
})
