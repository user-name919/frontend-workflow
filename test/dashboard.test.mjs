import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createDashboardServer, readDashboard } from '../template/.ai-dev/scripts/dashboard.mjs'
import { startActivity } from '../template/.ai-dev/scripts/lib/monitor-events.mjs'

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-dashboard-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = path.join(root, '.ai-dev', 'features', 'REQ-1')
  await mkdir(path.join(dir, 'artifacts', 'design'), { recursive: true })
  await mkdir(path.join(dir, 'artifacts', 'analysis'), { recursive: true })
  const status = {
    id: 'REQ-1', title: '考点地图支持刷题', state: 'IMPLEMENTING', updatedAt: '2026-11-10T01:00:00Z',
    consistency: { staleArtifacts: [] }, approvals: { scope: {}, spec: {}, plan: {}, final: null },
    control: { version: 2, events: [{ sequence: 1, type: 'task.start', at: '2026-11-10T01:00:00Z', data: { taskId: 'T1' } }] },
    runtime: { activeTaskId: 'T1', taskResults: { T1: { status: 'running' } } },
  }
  await writeFile(path.join(dir, 'status.json'), JSON.stringify(status))
  await writeFile(path.join(dir, 'artifacts', 'design', 'delivery.json'), JSON.stringify({ tasks: [{ id: 'T1', title: '实现刷题入口' }] }))
  await writeFile(path.join(dir, 'artifacts', 'analysis', 'scope.md'), '# 需求范围\n\n| 项目 | 说明 |\n| --- | --- |\n| 测试 | 展示 |\n')
  return { root, dir }
}

function request(server, { url = '/', method = 'GET', host = '127.0.0.1:1234' } = {}) {
  return new Promise((resolve) => {
    const headers = {}
    const response = {
      headersSent: false,
      setHeader(name, value) { headers[name] = value },
      writeHead(status, extra = {}) { this.status = status; this.headersSent = true; Object.assign(headers, extra); return this },
      end(body = '') { resolve({ status: this.status, headers, body: String(body) }) },
    }
    server.emit('request', { url, method, headers: { host } }, response)
  })
}

test('dashboard reads feature state and observed activities without modifying the workflow ledger', async (t) => {
  const { root, dir } = await fixture(t)
  const before = await readFile(path.join(dir, 'status.json'), 'utf8')
  const activity = startActivity({ projectRoot: root, featureDir: dir, kind: 'command', component: 'verification-command', taskId: 'T1', command: 'npm test' })
  const result = await readDashboard(root)
  assert.equal(result.features.length, 1)
  assert.equal(result.features[0].state, 'IMPLEMENTING')
  assert.equal(result.features[0].activeTaskId, 'T1')
  assert.equal(result.features[0].events[0].component, 'task.start')
  assert.ok(result.features[0].artifacts.some((item) => item.name === '需求范围' && item.path === 'artifacts/analysis/scope.md'))
  assert.equal(result.catalog.stages.length, 8)
  assert.equal(result.catalog.components.command['verification-command'].name, '运行项目验证')
  assert.ok(result.observations.some((item) => item.id === activity.id && item.status === 'running' && item.command === 'npm test'))
  activity.finish(0)
  assert.equal((await readDashboard(root)).observations.find((item) => item.id === activity.id).status, 'completed')
  assert.equal(await readFile(path.join(dir, 'status.json'), 'utf8'), before)
})

test('old and unreadable workspaces are represented without inventing execution history', async (t) => {
  const { root } = await fixture(t)
  const broken = path.join(root, '.ai-dev', 'features', 'BROKEN')
  await mkdir(broken, { recursive: true })
  await writeFile(path.join(broken, 'status.json'), '{')
  const result = await readDashboard(root)
  assert.equal(result.features.find((item) => item.id === 'BROKEN').state, 'UNREADABLE')
  assert.deepEqual(result.observations, [])
})

test('local server exposes only the read-only dashboard and checks the host', async (t) => {
  const { root } = await fixture(t)
  const server = createDashboardServer(root)
  const page = await request(server)
  assert.equal(page.status, 200)
  assert.match(page.body, /工作流看板/)
  assert.match(page.headers['Content-Security-Policy'], /default-src 'self'/)
  const data = await request(server, { url: '/api/workflow' })
  assert.equal(data.status, 200)
  assert.equal(JSON.parse(data.body).features[0].id, 'REQ-1')
  assert.equal((await request(server, { url: '/api/workflow', method: 'POST' })).status, 405)
  assert.equal((await request(server, { url: '/../../README.md' })).status, 404)
  assert.equal((await request(server, { host: 'example.com' })).status, 403)
  const document = await request(server, { url: '/api/artifact?feature=REQ-1&path=artifacts%2Fanalysis%2Fscope.md' })
  assert.equal(document.status, 200)
  assert.match(JSON.parse(document.body).content, /# 需求范围/)
  assert.equal((await request(server, { url: '/api/artifact?feature=REQ-1&path=artifacts%2F..%2F..%2Fsecret.md' })).status, 404)
  assert.equal((await request(server, { url: '/api/artifact?feature=..%2F..&path=artifacts%2Fanalysis%2Fscope.md' })).status, 404)
  await writeFile(path.join(root, 'secret.md'), 'private')
  await symlink(path.join(root, 'secret.md'), path.join(root, '.ai-dev', 'features', 'REQ-1', 'artifacts', 'analysis', 'escape.md'))
  assert.equal((await request(server, { url: '/api/artifact?feature=REQ-1&path=artifacts%2Fanalysis%2Fescape.md' })).status, 404)
})

test('the timeline retains every recorded invocation beyond 500 entries', async (t) => {
  const { root, dir } = await fixture(t)
  const activity = startActivity({ projectRoot: root, featureDir: dir, kind: 'skill', component: 'prd-to-code', source: 'agent', heartbeat: false })
  activity.finish(0)
  const eventDir = path.join(root, '.ai-dev', 'runtime', 'dashboard', 'events')
  const now = new Date().toISOString()
  await Promise.all(Array.from({ length: 505 }, async () => {
    const id = randomUUID()
    await writeFile(path.join(eventDir, `${id}.json`), JSON.stringify({ id, kind: 'script', component: 'workflow-control.mjs', action: 'next', featureId: 'REQ-1', source: 'script', status: 'completed', startedAt: now, updatedAt: now, endedAt: now }))
  }))
  const result = await readDashboard(root)
  assert.equal(result.observations.length, 506)
  assert.equal(result.observations.filter((item) => item.component === 'workflow-control.mjs').length, 505)
})

test('missing or old heartbeat is displayed as unknown instead of indefinitely running', async (t) => {
  const { root, dir } = await fixture(t)
  const activity = startActivity({ projectRoot: root, featureDir: dir, kind: 'skill', component: 'prd-to-code', source: 'agent', heartbeat: false })
  const eventFile = path.join(root, '.ai-dev', 'runtime', 'dashboard', 'events', `${activity.id}.json`)
  const event = JSON.parse(await readFile(eventFile, 'utf8'))
  event.updatedAt = 'not-a-date'
  await writeFile(eventFile, JSON.stringify(event))
  assert.equal((await readDashboard(root)).observations.find((item) => item.id === activity.id).status, 'unknown')
  activity.finish(0)
})

test('server refreshes cached observations when an invocation finishes', async (t) => {
  const { root, dir } = await fixture(t)
  const server = createDashboardServer(root)
  const activity = startActivity({ projectRoot: root, featureDir: dir, kind: 'script', component: 'workflow-control.mjs', action: 'next' })
  const before = JSON.parse((await request(server, { url: '/api/workflow' })).body)
  assert.equal(before.observations.find((item) => item.id === activity.id).status, 'running')
  activity.finish(0)
  const after = JSON.parse((await request(server, { url: '/api/workflow' })).body)
  assert.equal(after.observations.find((item) => item.id === activity.id).status, 'completed')
})
