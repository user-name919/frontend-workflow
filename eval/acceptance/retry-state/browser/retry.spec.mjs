import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { capture, observePage } from './evidence.mjs'
const fixtures = JSON.parse(await readFile(new URL('../fixtures.json', import.meta.url), 'utf8'))
let hits
let requests
let registered
let respond
let release
let screenshots

test.beforeEach(async ({ page }) => {
  hits = 0
  requests = []
  registered = []
  release = null
  screenshots = []
  respond = async (route) => route.fulfill({ json: fixtures.first })
  await page.route('**/api/profile', async (route) => {
    const request = route.request()
    expect(request.method(), 'E-REQUEST-METHOD').toBe('GET')
    expect(new URL(request.url()).search, 'E-REQUEST-QUERY').toBe('')
    hits++
    requests.push({ method: request.method(), url: request.url() })
    await respond(route)
  })
  registered.push('profile')
  await page.goto('/')
})
test.afterEach(async ({ baseURL, page }, testInfo) => {
  const screenshot = await capture(page, testInfo, testInfo.status || 'end').catch(() => null)
  if (screenshot) screenshots.push(screenshot)
  const observation = await observePage(page)
  release?.()
  await testInfo.attach('acceptance-context', { contentType: 'application/json', body: Buffer.from(JSON.stringify({ environmentId: process.env.WORKFLOW_ENVIRONMENT_ID || 'mock', baseURL, mockedRoutes: registered, mockHits: { profile: hits }, requests, preconditionResults: [{ index: 0, result: registered.includes('profile') ? 'met' : 'unmet', observation: `${registered.includes('profile') ? '已启用' : '未启用'}个人资料接口的模拟响应；本次实际请求 ${hits} 次。` }], expectationResults: [{ id: 'E1', result: testInfo.status === 'passed' ? 'passed' : 'failed', observation: `个人资料接口请求 ${hits} 次。${observation}`, screenshotRefs: screenshots }] })) })
})
const status = (page) => page.locator('#status')
const load = (page) => page.getByRole('button', { name: '加载', exact: true })
const retry = (page) => page.getByRole('button', { name: '重试', exact: true })
async function expectSuccess(page, profile) {
  await expect(status(page), 'E-SUCCESS-STATE').toHaveText('success')
  await expect(page.locator('#data'), 'E-RESPONSE-CONTENT').toHaveText(JSON.stringify(profile, null, 2))
  await expect(page.getByRole('alert'), 'E-ERROR-CLEARED').toBeEmpty()
  await expect(retry(page), 'E-RETRY-HIDDEN').toBeHidden()
  screenshots.push(await capture(page, test.info(), 'success'))
}
async function expectFailure(page, message) {
  await expect(status(page), 'E-FAILURE-STATE').toHaveText('failed')
  await expect(page.getByRole('alert'), 'E-ERROR-VISIBLE').toContainText(message)
  await expect(retry(page), 'E-RETRY-AVAILABLE').toBeVisible()
  screenshots.push(await capture(page, test.info(), 'error'))
}

test('[TC-SUCCESS] 加载成功后展示返回的个人资料', async ({ page }) => {
  await load(page).click()
  await expectSuccess(page, fixtures.first)
  expect(hits, 'E-ONE-REQUEST').toBe(1)
})
test('[TC-LOADING] 等待响应时显示加载中，响应后展示资料', async ({ page }) => {
  const gate = new Promise((resolve) => { release = resolve })
  respond = async (route) => { await gate; await route.fulfill({ json: fixtures.first }) }
  await load(page).click()
  await expect.poll(() => hits).toBe(1)
  await expect(status(page), 'E-LOADING-STATE').toHaveText('loading')
  screenshots.push(await capture(page, test.info(), 'loading'))
  release()
  await expectSuccess(page, fixtures.first)
})
test('[TC-HTTP-FAIL] 接口请求失败后提示错误并允许重试', async ({ page }) => {
  respond = (route) => route.fulfill({ status: 500, body: 'Server failure' })
  await load(page).click()
  await expectFailure(page, '500')
  expect(hits, 'E-FAULT-HIT').toBe(1)
})
test('[TC-RECOVER] 请求失败后重试，展示新资料', async ({ page }) => {
  respond = (route) => hits === 1 ? route.fulfill({ status: 503, body: 'Unavailable' }) : route.fulfill({ json: fixtures.recovered })
  await load(page).click()
  await expectFailure(page, '503')
  await retry(page).click()
  await expect.poll(() => hits, { message: 'E-RETRY-REQUEST' }).toBe(2)
  await expectSuccess(page, fixtures.recovered)
})
test('[TC-REPEAT] 连续点击加载时不重复发送请求', async ({ page }) => {
  const gate = new Promise((resolve) => { release = resolve })
  respond = async (route) => { await gate; await route.fulfill({ json: fixtures.first }) }
  await load(page).click()
  await expect(status(page)).toHaveText('loading')
  await load(page).click({ clickCount: 3 })
  // A short observation window checks absence of extra requests, not readiness.
  await page.waitForTimeout(120)
  expect(hits, 'E-NO-PARALLEL-REQUEST').toBe(1)
  release()
  await expectSuccess(page, fixtures.first)
})
test('[TC-RETRY-REPEAT] 连续点击重试时只新增一次请求', async ({ page }) => {
  const gate = new Promise((resolve) => { release = resolve })
  respond = async (route) => {
    if (hits === 1) return route.fulfill({ status: 500, body: 'Error' })
    await gate
    await route.fulfill({ json: fixtures.recovered })
  }
  await load(page).click()
  await expectFailure(page, '500')
  await retry(page).click({ clickCount: 3 })
  await load(page).click()
  await page.waitForTimeout(120)
  expect(hits, 'E-NO-PARALLEL-RETRY').toBe(2)
  release()
  await expectSuccess(page, fixtures.recovered)
})
test('[TC-BUSINESS-FAIL] 接口返回业务错误时不能显示成功', async ({ page }) => {
  respond = (route) => route.fulfill({ json: fixtures.businessFailure })
  await load(page).click()
  await expectFailure(page, '资料暂不可用')
})
test('[TC-NETWORK-FAIL] 网络中断后可通过重试恢复', async ({ page }) => {
  respond = (route) => hits === 1 ? route.abort('connectionreset') : route.fulfill({ json: fixtures.recovered })
  await load(page).click()
  await expectFailure(page, /.+/)
  await retry(page).click()
  await expectSuccess(page, fixtures.recovered)
})
test('[TC-TIMEOUT] 请求超时后结束加载，并允许重试恢复', async ({ page }) => {
  const started = Date.now()
  respond = async (route) => { if (hits > 1) await route.fulfill({ json: fixtures.recovered }) }
  await load(page).click()
  await expectFailure(page, '请求超时，请重试')
  expect(Date.now() - started, 'E-CLIENT-TIMEOUT-THRESHOLD').toBeGreaterThanOrEqual(1400)
  await retry(page).click()
  await expectSuccess(page, fixtures.recovered)
})
