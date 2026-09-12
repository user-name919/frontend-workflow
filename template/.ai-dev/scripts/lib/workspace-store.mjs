/**
 * Versioned feature status store with exclusive lock and atomic rename.
 * Runtime does not call models.
 */

import { randomBytes } from 'node:crypto'
import { open, readFile, rename, unlink, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

export class StoreError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'StoreError'
    this.code = code
  }
}

const STATES = new Set([
  'INGEST',
  'SCOPE_REVIEW',
  'SPEC_REVIEW',
  'PLAN_REVIEW',
  'IMPLEMENTING',
  'VERIFYING',
  'FINAL_REVIEW',
  'COMPLETE',
  'BLOCKED',
])

function statusPath(featureDir) {
  return path.join(path.resolve(featureDir), 'status.json')
}

function lockPath(featureDir) {
  return path.join(path.resolve(featureDir), 'status.lock')
}

function defaultControl() {
  return {
    version: 0,
    nextEvent: 1,
    events: [],
    blocked: null,
    artifactStatus: null,
  }
}

function defaultPolicy() {
  return {
    mode: 'strict',
    delegation: null,
    maxFixRounds: 3,
  }
}

function defaultRuntime() {
  return {
    activeTaskId: null,
    attempts: {},
    taskResults: {},
  }
}

function assertV2Shape(status) {
  if (status.schemaVersion !== 2) {
    throw new StoreError('UNSUPPORTED_SCHEMA', `Unsupported schemaVersion: ${status.schemaVersion}`)
  }
  if (!STATES.has(status.state)) {
    throw new StoreError('INVALID_STATUS', `Invalid state: ${status.state}`)
  }
  if (!status.control || typeof status.control.version !== 'number') {
    throw new StoreError('INVALID_STATUS', 'status.control.version is required')
  }
  if (!status.policy || typeof status.policy.mode !== 'string') {
    throw new StoreError('INVALID_STATUS', 'status.policy.mode is required')
  }
  if (!status.runtime || typeof status.runtime !== 'object') {
    throw new StoreError('INVALID_STATUS', 'status.runtime is required')
  }
  if (!status.reviews || typeof status.reviews !== 'object') {
    throw new StoreError('INVALID_STATUS', 'status.reviews is required')
  }
}

/**
 * Pure migration from legacy (missing/1) to schemaVersion 2.
 * Preserves id/title/project/consistency/approvals and unknown business fields.
 */
export function migrateStatus(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new StoreError('INVALID_STATUS', 'status must be an object')
  }

  const version = raw.schemaVersion
  if (version === 2) {
    assertV2Shape(raw)
    return structuredClone(raw)
  }
  if (version !== undefined && version !== 1) {
    const error = new StoreError('UNSUPPORTED_SCHEMA', `Unsupported schemaVersion: ${version}`)
    throw error
  }

  const next = structuredClone(raw)
  next.schemaVersion = 2
  next.control = defaultControl()
  next.policy = next.policy && typeof next.policy === 'object'
    ? {
        mode: next.policy.mode || 'strict',
        delegation: next.policy.delegation ?? null,
        maxFixRounds: Number.isInteger(next.policy.maxFixRounds) ? next.policy.maxFixRounds : 3,
      }
    : defaultPolicy()
  next.reviews = next.reviews && typeof next.reviews === 'object' ? next.reviews : {}
  next.runtime = next.runtime && typeof next.runtime === 'object'
    ? {
        activeTaskId: next.runtime.activeTaskId ?? null,
        attempts: next.runtime.attempts && typeof next.runtime.attempts === 'object'
          ? next.runtime.attempts
          : {},
        taskResults: next.runtime.taskResults && typeof next.runtime.taskResults === 'object'
          ? next.runtime.taskResults
          : {},
      }
    : defaultRuntime()

  if (next.state === 'BLOCKED') {
    const blocked = next.control.blocked && typeof next.control.blocked === 'object'
      ? { ...next.control.blocked }
      : {}
    if (!blocked.suspendedFrom) {
      blocked.suspendedFrom = null
      blocked.requiredInput = blocked.requiredInput || '人工指定原阶段'
      blocked.reasonCode = blocked.reasonCode || 'LEGACY_BLOCKED'
      blocked.blockedAt = blocked.blockedAt || next.updatedAt || null
    }
    next.control.blocked = blocked
  }

  next.control.artifactStatus = 'NEEDS_STRUCTURED_IMPORT'

  return next
}

async function readRawStatus(featureDir) {
  const file = statusPath(featureDir)
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    throw new StoreError('MISSING_STATUS', `Cannot read status.json: ${error.message}`)
  }
  try {
    return { text, value: JSON.parse(text) }
  } catch (error) {
    throw new StoreError('INVALID_JSON', `status.json is not valid JSON: ${error.message}`)
  }
}

export async function readFeature(featureDir) {
  const { value } = await readRawStatus(featureDir)
  const version = value.schemaVersion
  if (version === undefined || version === 1) {
    throw new StoreError(
      'NEEDS_MIGRATION',
      'Feature status requires migration to schemaVersion 2. Run workflow-control migrate.',
    )
  }
  if (version !== 2) {
    throw new StoreError('UNSUPPORTED_SCHEMA', `Unsupported schemaVersion: ${version}`)
  }
  assertV2Shape(value)
  return value
}

async function writeStatusAtomic(featureDir, status) {
  const file = statusPath(featureDir)
  const tmp = path.join(
    path.resolve(featureDir),
    `status.${randomBytes(8).toString('hex')}.tmp`,
  )
  const payload = `${JSON.stringify(status, null, 2)}\n`
  await writeFile(tmp, payload)
  await rename(tmp, file)
}

async function withLock(featureDir, fn) {
  const lock = lockPath(featureDir)
  let handle
  try {
    handle = await open(lock, 'wx')
    await handle.writeFile(
      JSON.stringify(
        {
          pid: process.pid,
          at: new Date().toISOString(),
          note: 'If this lock remains after a crash, confirm the process is gone, then delete status.lock and retry.',
        },
        null,
        2,
      ),
    )
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new StoreError(
        'BUSY',
        `status.lock exists for ${featureDir}. Confirm no other writer is active; after a crash, delete status.lock manually and retry.`,
      )
    }
    throw error
  }

  try {
    return await fn()
  } finally {
    await handle.close().catch(() => {})
    await unlink(lock).catch(() => {})
  }
}

export async function migrateFeature(featureDir) {
  return withLock(featureDir, async () => {
    const { text, value } = await readRawStatus(featureDir)
    if (value.schemaVersion === 2) {
      assertV2Shape(value)
      return value
    }
    if (value.schemaVersion !== undefined && value.schemaVersion !== 1) {
      throw new StoreError('UNSUPPORTED_SCHEMA', `Unsupported schemaVersion: ${value.schemaVersion}`)
    }

    const revisionsDir = path.join(path.resolve(featureDir), 'revisions')
    await mkdir(revisionsDir, { recursive: true })
    const backupPath = path.join(revisionsDir, 'migration-v1-status.json')
    try {
      const backupHandle = await open(backupPath, 'wx')
      try {
        await backupHandle.writeFile(text)
      } finally {
        await backupHandle.close()
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      // Existing backup must not be overwritten.
    }

    const migrated = migrateStatus(value)
    migrated.updatedAt = new Date().toISOString()
    await writeStatusAtomic(featureDir, migrated)
    return migrated
  })
}

/**
 * @param {string} featureDir
 * @param {{ expectedVersion: number, event: { type: string, actor: string, data?: object } }} options
 * @param {(status: object) => void | object} mutate
 */
export async function mutateFeature(featureDir, options, mutate) {
  if (!options || !Number.isInteger(options.expectedVersion)) {
    throw new StoreError('INVALID_REQUEST', 'expectedVersion (integer) is required')
  }
  if (!options.event?.type || !options.event?.actor) {
    throw new StoreError('INVALID_REQUEST', 'event.type and event.actor are required')
  }

  return withLock(featureDir, async () => {
    const current = await readFeature(featureDir)
    if (current.control.version !== options.expectedVersion) {
      throw new StoreError(
        'VERSION_CONFLICT',
        `expectedVersion ${options.expectedVersion} does not match disk version ${current.control.version}`,
      )
    }

    const beforeVersion = current.control.version
    const draft = structuredClone(current)
    const maybeNext = mutate(draft)
    const next = maybeNext && typeof maybeNext === 'object' ? maybeNext : draft

    if (!next.control || typeof next.control !== 'object') {
      throw new StoreError('INVALID_STATUS', 'mutate must preserve control')
    }

    const afterVersion = beforeVersion + 1
    const sequence = next.control.nextEvent
    const eventRecord = {
      sequence,
      type: options.event.type,
      actor: options.event.actor,
      data: options.event.data ?? {},
      at: new Date().toISOString(),
      beforeVersion,
      afterVersion,
    }

    next.control.version = afterVersion
    next.control.nextEvent = sequence + 1
    next.control.events = [...(next.control.events || []), eventRecord]
    next.updatedAt = eventRecord.at
    assertV2Shape(next)

    await writeStatusAtomic(featureDir, next)
    return next
  })
}

export function createV2StatusFields() {
  return {
    schemaVersion: 2,
    control: defaultControl(),
    policy: defaultPolicy(),
    reviews: {},
    runtime: defaultRuntime(),
  }
}
