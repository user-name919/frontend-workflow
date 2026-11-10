/**
 * Best-effort local observations for the dashboard. They are separate from the
 * workflow ledger: a missing observation must never block the actual work.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const HEARTBEAT_MS = 15000
const ID = /^[a-f0-9-]{36}$/
const TOKEN = /^[\w.-]{1,100}$/
const SKILLS = new Set(['prd-to-code', 'prepare-review', 'review-delivery'])
let activeProcess = null

function eventDirectory(projectRoot) {
  return path.join(projectRoot, '.ai-dev', 'runtime', 'dashboard', 'events')
}

function prepareDirectory(projectRoot) {
  if (!existsSync(path.join(projectRoot, '.ai-dev'))) return null
  const runtime = path.join(projectRoot, '.ai-dev', 'runtime', 'dashboard')
  const directory = eventDirectory(projectRoot)
  mkdirSync(directory, { recursive: true })
  try {
    writeFileSync(path.join(runtime, '.gitignore'), '*\n', { flag: 'wx' })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  return directory
}

function saveEvent(projectRoot, event) {
  const directory = prepareDirectory(projectRoot)
  if (!directory) return false
  const target = path.join(directory, `${event.id}.json`)
  const temporary = path.join(directory, `.${event.id}-${randomUUID()}.tmp`)
  writeFileSync(temporary, `${JSON.stringify(event)}\n`, { mode: 0o600 })
  renameSync(temporary, target)
  return true
}

function safeToken(value) {
  return typeof value === 'string' && TOKEN.test(value) ? value : null
}

function findProjectRoot(start) {
  let current = path.resolve(start)
  while (!existsSync(path.join(current, '.ai-dev'))) {
    const parent = path.dirname(current)
    if (parent === current) return path.resolve(start)
    current = parent
  }
  return current
}

/** Only an explicitly passed, still-running observation can establish a parent. */
function explicitSkillParent(projectRoot, featureId) {
  const id = process.env.WORKFLOW_SKILL_RUN_ID
  if (!ID.test(id || '')) return null
  try {
    const event = JSON.parse(readFileSync(path.join(eventDirectory(projectRoot), `${id}.json`), 'utf8'))
    if (event.id !== id || event.kind !== 'skill' || event.source !== 'agent' || event.status !== 'running') return null
    if (featureId && event.featureId && event.featureId !== featureId) return null
    return event
  } catch { return null }
}

/** Only attach a feature when its path identifies a real workflow workspace. */
export function traceContext(featureDir, fallbackRoot = process.cwd()) {
  if (!featureDir || typeof featureDir !== 'string') return { projectRoot: path.resolve(fallbackRoot), featureId: null }
  const resolved = path.resolve(fallbackRoot, featureDir)
  const marker = `${path.sep}.ai-dev${path.sep}features${path.sep}`
  const position = resolved.lastIndexOf(marker)
  if (position < 0) return { projectRoot: path.resolve(fallbackRoot), featureId: null }
  const featureId = resolved.slice(position + marker.length).split(path.sep)[0]
  return { projectRoot: resolved.slice(0, position) || path.parse(resolved).root, featureId: safeToken(featureId) }
}

/** Begin a single independent activity; disk errors are intentionally ignored. */
export function startActivity(options = {}) {
  const context = traceContext(options.featureDir, options.projectRoot || process.cwd())
  const projectRoot = options.projectRoot ? path.resolve(options.projectRoot) : context.projectRoot
  const now = new Date().toISOString()
  const event = {
    schemaVersion: 1,
    id: randomUUID(),
    kind: options.kind || 'script',
    component: String(options.component || '').slice(0, 100),
    action: safeToken(options.action),
    featureId: safeToken(options.featureId) || context.featureId,
    taskId: safeToken(options.taskId),
    attemptId: safeToken(options.attemptId),
    parentId: ID.test(options.parentId || '') ? options.parentId : null,
    command: typeof options.command === 'string' ? options.command.slice(0, 120) : null,
    source: options.source || options.kind || 'script',
    status: 'running',
    startedAt: now,
    updatedAt: now,
    endedAt: null,
    exitCode: null,
  }
  let available = false
  try { available = saveEvent(projectRoot, event) } catch { /* Observability is best effort. */ }
  let finished = false
  let heartbeat = null
  if (available && options.heartbeat !== false) {
    heartbeat = setInterval(() => {
      event.updatedAt = new Date().toISOString()
      try { saveEvent(projectRoot, event) } catch { /* Do not affect the workflow. */ }
    }, HEARTBEAT_MS)
    heartbeat.unref()
  }
  return {
    id: event.id,
    available,
    update(values = {}) {
      if (values.featureId) event.featureId = safeToken(values.featureId)
      if (values.featureDir) event.featureId = traceContext(values.featureDir, projectRoot).featureId
      if (values.taskId) event.taskId = safeToken(values.taskId)
      if (values.attemptId) event.attemptId = safeToken(values.attemptId)
      event.updatedAt = new Date().toISOString()
      try { if (available) saveEvent(projectRoot, event) } catch { /* Best effort. */ }
    },
    finish(exitCode = 0, status) {
      if (finished) return
      finished = true
      if (heartbeat) clearInterval(heartbeat)
      event.endedAt = new Date().toISOString()
      event.updatedAt = event.endedAt
      event.exitCode = Number.isInteger(exitCode) ? exitCode : null
      event.status = status || (exitCode === 0 ? 'completed' : 'failed')
      try { if (available) saveEvent(projectRoot, event) } catch { /* Best effort. */ }
    },
  }
}

/** Instrument only direct CLI invocations; importing a module is not an execution. */
export function traceCli(component, options = {}) {
  const args = process.argv.slice(2)
  let featureDir = options.featureDir
  let projectRoot
  if (!featureDir && component === 'normalize-markdown-assets.mjs') {
    const index = args.indexOf('--feature-dir')
    if (index >= 0) featureDir = args[index + 1]
    const rootIndex = args.indexOf('--project-root')
    if (!featureDir) projectRoot = rootIndex >= 0 && args[rootIndex + 1] ? path.resolve(args[rootIndex + 1]) : findProjectRoot(process.cwd())
  } else if (component === 'init-change.mjs') {
    projectRoot = findProjectRoot(process.cwd())
  } else if (!featureDir && component !== 'init-change.mjs') {
    featureDir = args[0]
  }
  const actions = new Set(['next', 'inspect', 'migrate', 'transition', 'block', 'resume', 'approve', 'delegate', 'recover', 'capture', 'verify', 'start', 'accept', 'adapt', 'validate', 'decide', 'mark', 'resolve', 'draft'])
  const action = actions.has(args[1]) ? args[1] : null
  const context = traceContext(featureDir, projectRoot || process.cwd())
  const parent = explicitSkillParent(projectRoot || context.projectRoot, context.featureId)
  const trace = startActivity({
    kind: 'script', component, featureDir, projectRoot, action,
    featureId: context.featureId || parent?.featureId, parentId: parent?.id,
    taskId: component === 'prepare-task.mjs' ? args[1] : null,
    attemptId: component === 'prepare-task.mjs' && args.includes('--attempt') ? args[args.indexOf('--attempt') + 1] : null,
  })
  activeProcess = trace
  process.once('exit', (code) => trace.finish(code))
  return trace
}

export function currentTraceId() {
  return activeProcess?.id || null
}

export function updateCurrentTrace(values) {
  activeProcess?.update(values)
}

/** Agent-reported skill activity is explicitly distinct from host observations. */
export function startSkillObservation(projectRoot, featureDir, skill, taskId) {
  if (!SKILLS.has(skill)) throw new Error('Unknown workflow skill')
  const context = traceContext(featureDir, projectRoot)
  const parent = explicitSkillParent(projectRoot, context.featureId)
  const activity = startActivity({ projectRoot, featureDir, featureId: context.featureId || parent?.featureId, kind: 'skill', component: skill, source: 'agent', taskId, parentId: parent?.id, heartbeat: false })
  if (!activity.available) throw new Error('Cannot write dashboard observation')
  return activity.id
}

export function finishSkillObservation(projectRoot, id) {
  if (!ID.test(id || '')) throw new Error('Invalid activity id')
  const file = path.join(eventDirectory(projectRoot), `${id}.json`)
  const event = JSON.parse(readFileSync(file, 'utf8'))
  if (event.id !== id || event.kind !== 'skill' || event.source !== 'agent') throw new Error('Activity is not a skill observation')
  if (event.status !== 'running') return event
  event.status = 'completed'
  event.endedAt = new Date().toISOString()
  event.updatedAt = event.endedAt
  saveEvent(projectRoot, event)
  return event
}
