#!/usr/bin/env node

import { createServer } from 'node:http'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const dashboardDir = path.resolve(here, '../dashboard')
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/dashboard.css', ['dashboard.css', 'text/css; charset=utf-8']],
  ['/dashboard.js', ['dashboard.js', 'text/javascript; charset=utf-8']],
  ['/vendor/markdown-it.min.js', ['vendor/markdown-it.min.js', 'text/javascript; charset=utf-8']],
  ['/vendor/mermaid.min.js', ['vendor/mermaid.min.js', 'text/javascript; charset=utf-8']],
])
const eventId = /^[a-f0-9-]{36}\.json$/
const featureIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const imageTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' }
const artifactNames = {
  'scope.md': '需求范围', 'source-index.md': '资料来源', 'evidence.md': '需求证据', 'open-questions.md': '待确认问题',
  'frontend-spec.md': '前端技术方案', 'acceptance.md': '验收标准', 'implementation-plan.md': '实施计划',
  'tasks.md': '实施任务', 'traceability.md': '需求追踪', 'verification.md': '验证结果', 'brief.md': '任务说明', 'summary.md': '审核摘要',
}

async function readJson(file) {
  const stat = await lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error('Invalid data file')
  return JSON.parse(await readFile(file, 'utf8'))
}

async function directoryEntries(directory) {
  try { return await readdir(directory, { withFileTypes: true }) } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

function within(root, target) {
  const relative = path.relative(root, target)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function shortText(value, fallback = '') {
  return typeof value === 'string' ? value.slice(0, 200) : fallback
}

function ledgerEvent(record, featureId) {
  const data = record?.data || {}
  return {
    id: `ledger-${featureId}-${record.sequence}`,
    kind: 'ledger', component: shortText(record.type, 'unknown'), source: 'ledger',
    featureId, taskId: shortText(data.taskId) || null,
    stage: shortText(data.to) || null, gate: shortText(data.gate) || null,
    status: 'recorded', startedAt: shortText(record.at), updatedAt: shortText(record.at),
  }
}

async function markdownFiles(featureDir) {
  const files = []
  async function walk(relative) {
    const directory = path.join(featureDir, relative)
    for (const entry of await directoryEntries(directory)) {
      const relativePath = path.join(relative, entry.name)
      if (entry.isDirectory()) await walk(relativePath)
      else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        const info = await lstat(path.join(featureDir, relativePath))
        if (!info.isFile() || info.isSymbolicLink()) continue
        const segments = relativePath.split(path.sep)
        const group = segments[0] === 'revisions' ? '审核与任务' : ({ analysis: '需求分析', design: '方案与计划', verification: '验证', 'coding-changes': '代码变更' }[segments[1]] || '其他产物')
        files.push({ path: segments.join('/'), name: artifactNames[entry.name] || entry.name, group, updatedAt: info.mtime.toISOString() })
      }
    }
  }
  await walk('artifacts')
  await walk('revisions')
  return files.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'))
}

async function featureFile(projectRoot, featureId, relativePath, allowedExtensions) {
  if (!featureIdPattern.test(featureId || '') || typeof relativePath !== 'string' || path.isAbsolute(relativePath)) throw new Error('Invalid artifact')
  const segments = relativePath.split('/')
  if (!['artifacts', 'revisions'].includes(segments[0]) || segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('\\'))) throw new Error('Invalid artifact')
  const extension = path.extname(relativePath).toLowerCase()
  if (!allowedExtensions.includes(extension)) throw new Error('Invalid artifact')
  const workspace = path.join(projectRoot, '.ai-dev', 'features', featureId)
  const workspaceStat = await lstat(workspace)
  if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) throw new Error('Invalid artifact')
  const root = await realpath(workspace)
  if (!within(await realpath(projectRoot), root)) throw new Error('Invalid artifact')
  let component = workspace
  for (const segment of segments) {
    component = path.join(component, segment)
    if ((await lstat(component)).isSymbolicLink()) throw new Error('Invalid artifact')
  }
  const target = await realpath(path.join(workspace, ...segments))
  if (target === root || !within(root, target)) throw new Error('Invalid artifact')
  const info = await lstat(target)
  if (!info.isFile() || info.size > 8 * 1024 * 1024) throw new Error('Invalid artifact')
  return { target, info, extension }
}

async function readFeature(projectRoot, entry) {
  const dir = path.join(projectRoot, '.ai-dev', 'features', entry.name)
  try {
    if (!within(await realpath(projectRoot), await realpath(dir))) throw new Error('Workspace outside project')
    const status = await readJson(path.join(dir, 'status.json'))
    if (!featureIdPattern.test(entry.name) || status.id !== entry.name) throw new Error('Invalid feature ID')
    let delivery = {}
    try { delivery = await readJson(path.join(dir, 'artifacts', 'design', 'delivery.json')) } catch { /* Drafts may not exist yet. */ }
    const featureId = shortText(status.id, entry.name)
    const taskResults = status.runtime?.taskResults || {}
    const tasks = Array.isArray(delivery.tasks) ? delivery.tasks.map((task) => ({
      id: shortText(task.id), title: shortText(task.title), status: shortText(taskResults[task.id]?.status, 'pending'),
    })) : []
    const events = Array.isArray(status.control?.events) ? status.control.events.map((event) => ledgerEvent(event, featureId)) : []
    let artifacts = []
    let artifactsError = false
    try { artifacts = await markdownFiles(dir) } catch { artifactsError = true }
    return {
      id: featureId, title: shortText(status.title, featureId), state: shortText(status.state, 'UNKNOWN'),
      suspendedFrom: shortText(status.control?.blocked?.suspendedFrom) || null,
      blockedReason: shortText(status.control?.blocked?.requiredInput) || null,
      staleCount: Array.isArray(status.consistency?.staleArtifacts) ? status.consistency.staleArtifacts.length : 0,
      approvals: Object.fromEntries(['scope', 'spec', 'plan', 'final'].map((key) => [key, Boolean(status.approvals?.[key])])),
      activeTaskId: shortText(status.runtime?.activeTaskId) || null,
      tasks, events, artifacts, artifactsError, updatedAt: shortText(status.updatedAt),
    }
  } catch {
    return { id: entry.name, title: entry.name, state: 'UNREADABLE', suspendedFrom: null, blockedReason: null, staleCount: 0, approvals: {}, activeTaskId: null, tasks: [], events: [], artifacts: [], artifactsError: true, updatedAt: '' }
  }
}

async function readObservations(projectRoot, cache) {
  const dir = path.join(projectRoot, '.ai-dev', 'runtime', 'dashboard', 'events')
  const entries = (await directoryEntries(dir)).filter((entry) => entry.isFile() && eventId.test(entry.name))
  const names = new Set(entries.map((entry) => entry.name))
  if (cache) for (const name of cache.keys()) if (!names.has(name)) cache.delete(name)
  const observations = await Promise.all(entries.map(async (entry) => {
    try {
      const file = path.join(dir, entry.name)
      const info = await lstat(file)
      if (!info.isFile() || info.isSymbolicLink()) return null
      const cached = cache?.get(entry.name)
      const event = cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size ? cached.event : await readJson(file)
      if (`${event.id}.json` !== entry.name || !['script', 'hook', 'skill', 'command'].includes(event.kind)) return null
      if (cache && event !== cached?.event) cache.set(entry.name, { mtimeMs: info.mtimeMs, size: info.size, event })
      const lastUpdate = Date.parse(event.updatedAt)
      const stale = event.status === 'running' && (!Number.isFinite(lastUpdate) || Date.now() - lastUpdate > 60000)
      return {
        id: event.id, kind: event.kind, component: shortText(event.component), action: shortText(event.action) || null,
        featureId: shortText(event.featureId) || null, taskId: shortText(event.taskId) || null,
        attemptId: shortText(event.attemptId) || null, parentId: shortText(event.parentId) || null,
        command: shortText(event.command) || null, source: shortText(event.source),
        status: stale ? 'unknown' : shortText(event.status, 'unknown'),
        startedAt: shortText(event.startedAt), updatedAt: shortText(event.updatedAt), endedAt: shortText(event.endedAt) || null,
        exitCode: Number.isInteger(event.exitCode) ? event.exitCode : null,
      }
    } catch { return null }
  }))
  return observations.filter(Boolean).sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

export async function readDashboard(projectRoot, cache) {
  const root = path.resolve(projectRoot)
  const catalog = await readJson(path.join(dashboardDir, 'catalog.json'))
  const entries = await directoryEntries(path.join(root, '.ai-dev', 'features'))
  const features = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => readFeature(root, entry)))
  features.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
  return { project: path.basename(root), features, observations: await readObservations(root, cache), catalog, refreshedAt: new Date().toISOString() }
}

export function createDashboardServer(projectRoot) {
  const observationCache = new Map()
  return createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
    const host = String(request.headers.host || '')
    if (!/^127\.0\.0\.1(?::\d+)?$/.test(host)) {
      response.writeHead(403).end('Forbidden')
      return
    }
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET' }).end('Method not allowed')
      return
    }
    const url = new URL(request.url, 'http://127.0.0.1')
    const pathname = url.pathname
    try {
      if (pathname === '/api/workflow') {
        const data = await readDashboard(projectRoot, observationCache)
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify(data))
      } else if (pathname === '/api/artifact' || pathname === '/api/artifact-image') {
        try {
          const isImage = pathname === '/api/artifact-image'
          const file = await featureFile(projectRoot, url.searchParams.get('feature'), url.searchParams.get('path'), isImage ? Object.keys(imageTypes) : ['.md'])
          if (isImage) {
            if (file.extension === '.svg') response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
            const image = await readFile(file.target)
            response.writeHead(200, { 'Content-Type': imageTypes[file.extension] }).end(image)
          } else {
            const content = await readFile(file.target, 'utf8')
            response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ content, updatedAt: file.info.mtime.toISOString() }))
          }
        } catch {
          response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: '产物不存在、无法读取或不在当前需求目录中。' }))
        }
      } else if (assets.has(pathname)) {
        const [file, contentType] = assets.get(pathname)
        const contents = await readFile(path.join(dashboardDir, file))
        response.writeHead(200, { 'Content-Type': contentType }).end(contents)
      } else {
        response.writeHead(404).end('Not found')
      }
    } catch {
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ error: '无法读取工作流数据，请检查项目目录。' }))
    }
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  let projectRoot = process.cwd()
  let port = 0
  for (let index = 0; index < args.length; index += 2) {
    if (args[index] === '--project' && args[index + 1]) projectRoot = path.resolve(args[index + 1])
    else if (args[index] === '--port' && /^\d+$/.test(args[index + 1] || '') && Number(args[index + 1]) <= 65535) port = Number(args[index + 1])
    else {
      console.error('用法：node .ai-dev/scripts/dashboard.mjs [--project 项目目录] [--port 端口]')
      process.exitCode = 1
      break
    }
  }
  if (!process.exitCode) {
    try {
      const workflowDir = await lstat(path.join(projectRoot, '.ai-dev'))
      if (!workflowDir.isDirectory()) throw new Error('missing workflow')
      const server = createDashboardServer(projectRoot)
      server.on('error', (error) => { console.error(`看板启动失败：${error.message}`); process.exitCode = 1 })
      server.listen(port, '127.0.0.1', () => {
        console.log(`工作流看板：http://127.0.0.1:${server.address().port}/`)
        console.log('按 Ctrl+C 停止。')
      })
    } catch {
      console.error('未找到 .ai-dev 目录；请在已配置工作流的项目中运行。')
      process.exitCode = 1
    }
  }
}
