import { test, expect } from '@playwright/test'
// No response interception in this project. The temporary HTTP service is the integration peer.
test('[TC-LIVE] real request follows the confirmed demo contract', async ({ page, baseURL }, testInfo) => {
  await page.goto('/')
  const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/profile')
  await page.getByRole('button', { name: '加载', exact: true }).click()
  const response = await responsePromise
  expect(response.status(), 'E-LIVE-HTTP').toBe(200)
  expect(response.headers()['x-demo-backend'], 'E-LIVE-SERVICE').toBe('local-service-v1')
  const body = await response.json()
  expect(typeof body.name, 'E-LIVE-NAME-CONTRACT').toBe('string')
  expect(Number.isInteger(body.revision), 'E-LIVE-REVISION-CONTRACT').toBe(true)
  await expect(page.locator('#status')).toHaveText('success')
  await expect(page.locator('#data'), 'E-LIVE-UI-RESPONSE').toHaveText(JSON.stringify(body, null, 2))
  await testInfo.attach('acceptance-context', { contentType: 'application/json', body: Buffer.from(JSON.stringify({ environmentId: process.env.WORKFLOW_ENVIRONMENT_ID || 'live', baseURL, mockedRoutes: [], mockHits: {}, backendIdentity: response.headers()['x-demo-backend'], preconditionResults: [{ index: 0, result: 'met', observation: `Actual backend header=${response.headers()['x-demo-backend']}` }], expectationResults: [{ id: 'E1', result: 'passed', observation: `HTTP ${response.status()}, returned revision=${body.revision}, UI matched exact response after click` }] })) })
})
