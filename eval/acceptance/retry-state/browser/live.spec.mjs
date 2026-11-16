import { test, expect } from '@playwright/test'
import { capture, observePage } from './evidence.mjs'
let responseObservation
test.beforeEach(() => { responseObservation = null })
test.afterEach(async ({ page, baseURL }, testInfo) => {
  const shot = await capture(page, testInfo, testInfo.status || 'end').catch(() => null)
  const observation = await observePage(page)
  await testInfo.attach('acceptance-context', { contentType: 'application/json', body: Buffer.from(JSON.stringify({ environmentId: process.env.WORKFLOW_ENVIRONMENT_ID || 'live', baseURL, mockedRoutes: [], mockHits: {}, preconditionResults: [{ index: 0, result: responseObservation ? 'met' : 'unmet', observation: responseObservation || '尚未收到后端响应。' }], expectationResults: [{ id: 'E1', result: testInfo.status === 'passed' ? 'passed' : 'failed', observation: `${responseObservation || '尚未收到响应。'}${observation}`, screenshotRefs: shot ? [shot] : [] }] })) })
})
// No response interception in this project. The temporary HTTP service is the integration peer.
test('[TC-LIVE] 真实接口返回符合契约，页面展示实际资料', async ({ page }) => {
  await page.goto('/')
  const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/profile')
  await page.getByRole('button', { name: '加载', exact: true }).click()
  const response = await responsePromise
  responseObservation = `已收到真实服务响应，状态码 ${response.status()}；服务标识：${response.headers()['x-demo-backend'] || '未提供'}。`
  expect(response.status(), 'E-LIVE-HTTP').toBe(200)
  expect(response.headers()['x-demo-backend'], 'E-LIVE-SERVICE').toBe('local-service-v1')
  const body = await response.json()
  expect(typeof body.name, 'E-LIVE-NAME-CONTRACT').toBe('string')
  expect(Number.isInteger(body.revision), 'E-LIVE-REVISION-CONTRACT').toBe(true)
  await expect(page.locator('#status')).toHaveText('success')
  await expect(page.locator('#data'), 'E-LIVE-UI-RESPONSE').toHaveText(JSON.stringify(body, null, 2))
  responseObservation += `返回资料版本为 ${body.revision}，页面内容与响应一致。`
})
