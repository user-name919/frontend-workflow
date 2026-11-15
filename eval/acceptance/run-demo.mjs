#!/usr/bin/env node
/** Real browser runs in isolated copies; never edits the original evaluation baseline. */
import { cp, mkdtemp, readFile, writeFile, symlink, mkdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createFeatureWorkspace } from '../../template/.ai-dev/scripts/init-change.mjs'
import { runVerification } from '../../template/.ai-dev/scripts/lib/verification.mjs'
import { acceptanceReadiness, digest, writeJsonAtomic } from '../../template/.ai-dev/scripts/lib/acceptance.mjs'
import { mutateFeature, readFeature } from '../../template/.ai-dev/scripts/lib/workspace-store.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const fixture = path.join(repo, 'eval/acceptance/retry-state')
const output = path.resolve(process.argv[2] || await mkdtemp(path.join(os.tmpdir(), 'acceptance-demo-results-')))
await mkdir(output, { recursive: true })
const root = await mkdtemp(path.join(os.tmpdir(), 'acceptance-demo-project-'))
await cp(fixture, root, { recursive: true, filter: (file) => !['node_modules', 'test-results', 'playwright-report'].includes(path.relative(fixture, file).split(path.sep)[0]) })
await symlink(path.join(fixture, 'node_modules'), path.join(root, 'node_modules'), 'dir')
await cp(path.join(repo, 'template/.ai-dev'), path.join(root, '.ai-dev'), { recursive: true })
for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Acceptance Demo'], ['config', 'user.email', 'demo@example.invalid'], ['add', '.'], ['commit', '-m', 'isolated demo baseline']]) execFileSync('git', args, { cwd: root, stdio: 'ignore' })
const listener = net.createServer()
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve))
const port = listener.address().port
await new Promise((resolve) => listener.close(resolve))
const baseURL = `http://127.0.0.1:${port}`
const featureDir = await createFeatureWorkspace(root, { id: 'REQ-RETRY-DEMO', idSource: 'user', title: 'Retry acceptance demonstration' })
const definitions = [
  ['TC-SUCCESS', 1, ['mock'], '成功响应', ['点击加载'], '显示响应 JSON 与 success'],
  ['TC-LOADING', 1, ['mock'], '挂起响应', ['点击加载', '观察 pending', '释放响应'], 'pending 期间 loading，响应后 success'],
  ['TC-HTTP-FAIL', 2, ['mock'], 'HTTP 500', ['点击加载'], 'failed、错误内容、可用重试'],
  ['TC-RECOVER', 3, ['mock'], '首次 503 后返回新资料', ['加载', '重试'], '新增正确请求、新资料、清除旧错误'],
  ['TC-REPEAT', 4, ['mock'], '挂起响应', ['重复点击加载'], '仅一个请求'],
  ['TC-RETRY-REPEAT', 4, ['mock'], '失败后挂起重试响应', ['连续重试和加载'], '仅新增一个请求'],
  ['TC-BUSINESS-FAIL', 2, ['mock'], '200 带 error 对象', ['加载'], 'failed，业务错误，不显示成功'],
  ['TC-NETWORK-FAIL', 2, ['mock'], '连接中断，随后恢复', ['加载', '重试'], '失败可恢复'],
  ['TC-TIMEOUT', 5, ['mock'], '请求持续 pending', ['加载', '等待应用超时', '重试'], '1500ms 应用超时，结束 loading，可恢复'],
  ['TC-LIVE', 6, ['live'], '启动临时真实 HTTP 服务', ['加载'], '真实请求响应满足契约并渲染'],
]
const source = await readFile(path.join(root, 'requirements.md'), 'utf8')
const rules = source.split('\n').filter((line) => /^\d\. /.test(line)).map((line) => line.slice(3))
const intake = {
  schemaVersion: 1,
  sources: [{ id: 'SRC-DEMO', kind: 'prd', locator: 'requirements.md', version: 'demo-1', contentHash: digest(source), availability: 'available' }],
  evidence: rules.map((rule, index) => ({ id: `EV-${index + 1}`, claim: rule, label: 'CONFIRMED', sourceId: 'SRC-DEMO', location: `item ${index + 1}` })),
  requirements: rules.map((rule, index) => ({ id: `FR-${index + 1}`, statement: rule, evidenceIds: [`EV-${index + 1}`], ownership: 'FRONTEND_BEHAVIOR', disposition: 'included' })), questions: [],
}
const cases = definitions.map(([id, rule, envs, given, steps, expected]) => ({ id, acceptanceIds: [`AC-${rule}`], method: 'browser', environmentId: envs[0], requiredAt: ['feature'], preconditions: [given], steps, expectations: [{ id: 'E1', observable: 'ui', expected }], dataRef: 'fixtures.json', implementation: { file: `browser/${envs[0] === 'live' ? 'live' : 'retry'}.spec.mjs`, testId: id }, ...(envs[0] === 'mock' ? { mockRuleIds: ['profile'] } : {}) }))
const contract = { path: 'contract.json', sha256: digest(await readFile(path.join(root, 'contract.json'))) }
const delivery = {
  schemaVersion: 2,
  acceptance: rules.map((rule, index) => ({ id: `AC-${index + 1}`, requirementIds: [`FR-${index + 1}`], given: '演示规格与契约', when: '用户加载或重试', then: rule, verification: 'test' })),
  testCases: cases,
  tasks: [{ id: 'T1', title: 'Retry demo', requirementIds: intake.requirements.map((r) => r.id), acceptanceIds: rules.map((_, index) => `AC-${index + 1}`), dependsOn: [], files: [{ path: 'src/app.js', operation: 'modify' }, { path: 'src/request.mjs', operation: 'modify' }, { path: 'browser/retry.spec.mjs', operation: 'modify' }, { path: 'browser/live.spec.mjs', operation: 'modify' }], steps: ['Implement confirmed demo behavior'], verifyIds: ['mock-browser'] }],
  links: rules.map((_, index) => ({ requirementId: `FR-${index + 1}`, acceptanceId: `AC-${index + 1}`, taskId: 'T1' })),
  verification: {
    inputs: [{ space: 'project', path: 'requirements.md' }],
    environments: ['mock', 'live'].map((id) => ({ id, kind: id === 'mock' ? 'contract-mock' : 'live-test', baseURL, projectName: id, setup: 'Playwright starts current fixture server; mock backend returns 503 without interception', reset: 'fresh browser context per case, fixed fixtures', inputs: ['playwright.config.mjs', 'server.mjs', 'fixtures.json', 'backend-response.json', 'package.json', 'package-lock.json'], contract, mocks: id === 'mock' ? [{ id: 'profile', method: 'GET', url: '/api/profile', fixture: 'fixtures.json' }] : [] })),
    checks: ['mock', 'live'].map((id) => ({ id: `${id}-browser`, kind: 'acceptance', command: process.execPath, args: ['node_modules/@playwright/test/cli.js', 'test'], cwd: '.', environmentId: id, caseIds: cases.filter((tc) => tc.environmentId === id).map((tc) => tc.id), report: 'playwright-json' })),
    finalCheckIds: ['mock-browser', 'live-browser'],
  },
}
await writeJsonAtomic(path.join(featureDir, 'artifacts/analysis/intake.json'), intake)
await writeJsonAtomic(path.join(featureDir, 'artifacts/design/delivery.json'), delivery)
// Demo/test setup only; it is not a human approval or a full workflow simulation.
await mutateFeature(featureDir, { expectedVersion: (await readFeature(featureDir)).control.version, event: { type: 'demo.setup', actor: 'local-demo' } }, (draft) => { draft.state = 'VERIFYING' })
const runs = []
async function execute(label, checkId, expectation = null) {
  const result = await runVerification(featureDir, { scope: 'feature', checkId, timeoutMs: 90000, actor: 'local-demo' })
  const failures = result.cases.filter((tc) => tc.status !== 'passed')
  const detected = expectation ? failures.some((tc) => tc.caseId === expectation.caseId && JSON.stringify(tc.attempts).includes(expectation.assertion)) : result.status === 'passed'
  const entry = { label, runId: result.id, status: result.status, expectation, detected, summary: result.summary, cases: result.cases.map((tc) => ({ id: tc.caseId, status: tc.status, errors: tc.attempts?.flatMap((attempt) => attempt.errors || []).map((error) => error.message) || tc.errors })), record: path.join(featureDir, 'revisions/verifications', result.id, 'record.json') }
  runs.push(entry)
  console.log(JSON.stringify({ label, status: result.status, detected, failingCases: failures.map((tc) => tc.caseId) }))
  await writeJsonAtomic(path.join(output, 'summary.json'), { root, featureDir, baseURL, runs })
  if (!detected) throw new Error(`Expected outcome not observed: ${label}; inspect ${entry.record}`)
  return result
}
await execute('correct baseline / backend unavailable / controlled responses', 'mock-browser')
const beforeLive = await acceptanceReadiness(featureDir)
if (beforeLive.ok) throw new Error('Mock pass incorrectly replaced mandatory live integration')
await execute('real local HTTP integration', 'live-browser')
if (!(await acceptanceReadiness(featureDir)).ok) throw new Error('Complete baseline evidence not ready')
const originalApp = await readFile(path.join(root, 'src/app.js'), 'utf8')
const originalRequest = await readFile(path.join(root, 'src/request.mjs'), 'utf8')
const variants = [
  ['missing retry entry', 'TC-HTTP-FAIL', 'E-RETRY-AVAILABLE', (a, r) => [a.replace('retry.hidden = false', 'retry.hidden = true'), r]],
  ['retry not wired', 'TC-RECOVER', 'E-RETRY-REQUEST', (a, r) => [a.replace("retry.addEventListener('click', onLoad)", '// retry handler missing'), r]],
  ['error hidden', 'TC-HTTP-FAIL', 'E-ERROR-VISIBLE', (a, r) => [a.replace('errorMessage.textContent = error.message', "errorMessage.textContent = ''"), r]],
  ['stale response', 'TC-RECOVER', 'E-RESPONSE-CONTENT', (a, r) => [a.replace('JSON.stringify(profile, null, 2)', 'JSON.stringify({ name: "Ada", revision: 1 }, null, 2)'), r]],
  ['parallel requests', 'TC-REPEAT', 'E-NO-PARALLEL-REQUEST', (a, r) => [a.replace('if (controller.isLoading()) return', ''), r.replace('if (inFlight) return inFlight', '')]],
  ['success regression', 'TC-SUCCESS', 'E-SUCCESS-STATE', (a, r) => [a.replace("status.textContent = 'success'", "status.textContent = 'idle'"), r]],
  ['business error treated as success', 'TC-BUSINESS-FAIL', 'E-FAILURE-STATE', (a, r) => [a, r.replace('if (data.error) throw new Error(data.error.message)', '')]],
  ['client timeout removed', 'TC-TIMEOUT', 'E-FAILURE-STATE', (a, r) => [a, r.replace('abort.abort()', '/* never cancels */')]],
]
for (const [label, caseId, assertion, mutate] of variants) {
  const [app, request] = mutate(originalApp, originalRequest)
  await writeFile(path.join(root, 'src/app.js'), app)
  await writeFile(path.join(root, 'src/request.mjs'), request)
  await execute(label, 'mock-browser', { caseId, assertion })
  if ((await acceptanceReadiness(featureDir)).ok) throw new Error('Mutant admitted')
}
await writeFile(path.join(root, 'src/app.js'), originalApp)
await writeFile(path.join(root, 'src/request.mjs'), originalRequest)
const originalBackend = await readFile(path.join(root, 'backend-response.json'), 'utf8')
await writeFile(path.join(root, 'backend-response.json'), '{"name":42,"revision":"wrong"}')
await execute('live contract mismatch', 'live-browser', { caseId: 'TC-LIVE', assertion: 'E-LIVE-NAME-CONTRACT' })
await writeFile(path.join(root, 'backend-response.json'), originalBackend)
await execute('restored baseline', 'mock-browser')
await execute('restored integration', 'live-browser')
if (!(await acceptanceReadiness(featureDir)).ok) throw new Error('Restored baseline not ready')
console.log(JSON.stringify({ ok: true, output, root, featureDir, variantsDetected: variants.length + 1 }))
