import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
const fixtures = JSON.parse(await readFile(new URL('../fixtures.json', import.meta.url), 'utf8'))
let hits
let requests
let registered
let respond
let release

test.beforeEach(async ({ page }) => {
  hits = 0
  requests = []
  registered = []
  release = null
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
  release?.()
  const state = await page.locator('#status').textContent().catch(() => 'unavailable')
  await testInfo.attach('acceptance-context', { contentType: 'application/json', body: Buffer.from(JSON.stringify({ environmentId: process.env.WORKFLOW_ENVIRONMENT_ID || 'mock', baseURL, mockedRoutes: registered, mockHits: { profile: hits }, requests, preconditionResults: [{ index: 0, result: registered.includes('profile') ? 'met' : 'unmet', observation: `profile route registered; observed hits=${hits}` }], expectationResults: [{ id: 'E1', result: testInfo.status === 'passed' ? 'passed' : 'failed', observation: `Assertions in ${testInfo.title}; observed final UI state=${state}; requests=${hits}` }] })) })
})
const status = (page) => page.locator('#status')
const load = (page) => page.getByRole('button', { name: '加载', exact: true })
const retry = (page) => page.getByRole('button', { name: '重试', exact: true })
async function expectSuccess(page, profile) {
  await expect(status(page), 'E-SUCCESS-STATE').toHaveText('success')
  await expect(page.locator('#data'), 'E-RESPONSE-CONTENT').toHaveText(JSON.stringify(profile, null, 2))
  await expect(page.getByRole('alert'), 'E-ERROR-CLEARED').toBeEmpty()
  await expect(retry(page), 'E-RETRY-HIDDEN').toBeHidden()
}
async function expectFailure(page, message) {
  await expect(status(page), 'E-FAILURE-STATE').toHaveText('failed')
  await expect(page.getByRole('alert'), 'E-ERROR-VISIBLE').toContainText(message)
  await expect(retry(page), 'E-RETRY-AVAILABLE').toBeVisible()
}

test('[TC-SUCCESS] original successful JSON remains visible', async ({ page }) => {
  await load(page).click()
  await expectSuccess(page, fixtures.first)
  expect(hits, 'E-ONE-REQUEST').toBe(1)
})
test('[TC-LOADING] pending request exposes loading', async ({ page }) => {
  const gate = new Promise((resolve) => { release = resolve })
  respond = async (route) => { await gate; await route.fulfill({ json: fixtures.first }) }
  await load(page).click()
  await expect.poll(() => hits).toBe(1)
  await expect(status(page), 'E-LOADING-STATE').toHaveText('loading')
  release()
  await expectSuccess(page, fixtures.first)
})
test('[TC-HTTP-FAIL] HTTP failure offers retry', async ({ page }) => {
  respond = (route) => route.fulfill({ status: 500, body: 'Server failure' })
  await load(page).click()
  await expectFailure(page, '500')
  expect(hits, 'E-FAULT-HIT').toBe(1)
})
test('[TC-RECOVER] retry sends new request and renders new response', async ({ page }) => {
  respond = (route) => hits === 1 ? route.fulfill({ status: 503, body: 'Unavailable' }) : route.fulfill({ json: fixtures.recovered })
  await load(page).click()
  await expectFailure(page, '503')
  await retry(page).click()
  await expect.poll(() => hits, { message: 'E-RETRY-REQUEST' }).toBe(2)
  await expectSuccess(page, fixtures.recovered)
})
test('[TC-REPEAT] repeated load while pending sends one request', async ({ page }) => {
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
test('[TC-RETRY-REPEAT] repeated retry while pending sends one new request', async ({ page }) => {
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
test('[TC-BUSINESS-FAIL] 200 business failure does not become success', async ({ page }) => {
  respond = (route) => route.fulfill({ json: fixtures.businessFailure })
  await load(page).click()
  await expectFailure(page, '资料暂不可用')
})
test('[TC-NETWORK-FAIL] transport failure can recover', async ({ page }) => {
  respond = (route) => hits === 1 ? route.abort('connectionreset') : route.fulfill({ json: fixtures.recovered })
  await load(page).click()
  await expectFailure(page, /.+/)
  await retry(page).click()
  await expectSuccess(page, fixtures.recovered)
})
test('[TC-TIMEOUT] application timeout leaves loading and permits recovery', async ({ page }) => {
  const started = Date.now()
  respond = async (route) => { if (hits > 1) await route.fulfill({ json: fixtures.recovered }) }
  await load(page).click()
  await expectFailure(page, '请求超时，请重试')
  expect(Date.now() - started, 'E-CLIENT-TIMEOUT-THRESHOLD').toBeGreaterThanOrEqual(1400)
  await retry(page).click()
  await expectSuccess(page, fixtures.recovered)
})
