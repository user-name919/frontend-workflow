/**
 * Task run lifecycle: exclusive project writer, result accept, interrupted inspect.
 * Does not spawn models. Reservation survives short-lived CLI exits.
 */

import { createHash } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { nextAction } from './orchestrator.mjs'
import { mutateFeature, readFeature, StoreError } from './workspace-store.mjs'

const execFile = promisify(execFileCallback)
const RESULT_STATUSES = new Set(['DONE', 'DONE_WITH_CONCERNS', 'NEEDS_CONTEXT', 'BLOCKED'])
const BUSINESS_CONCERN = /conflict|ownership|契约|合同|产品未决|ambiguity|职责/i

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function reservationPath(projectRoot) {
  return path.join(projectRoot, '.ai-dev/runtime/active-implementation.json')
}

async function digestFile(root, relative) {
  try {
    const bytes = await readFile(path.join(root, relative))
    return { exists: true, sha256: sha256(bytes) }
  } catch {
    return { exists: false, sha256: null }
  }
}

async function listProjectFiles(projectRoot) {
  try {
    await execFile('git', ['rev-parse', '--is-inside-work-tree'], { cwd: projectRoot })
  } catch {
    return []
  }
  const tracked = (
    await execFile('git', ['ls-files', '-z'], { cwd: projectRoot, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
  ).stdout
    .split('\0')
    .filter(Boolean)
  const untracked = (
    await execFile('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
      cwd: projectRoot,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    })
  ).stdout
    .split('\0')
    .filter(Boolean)
  return [...new Set([...tracked, ...untracked])].filter((file) => !file.startsWith('.ai-dev/')).sort()
}

export async function readReservation(projectRoot) {
  try {
    return JSON.parse(await readFile(reservationPath(projectRoot), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/**
 * Project lock first, then feature writes. File stays until accept or confirmed recover.
 */
export async function acquireProjectLock(projectRoot, reservation) {
  const file = reservationPath(projectRoot)
  await mkdir(path.dirname(file), { recursive: true })
  const payload = `${JSON.stringify({ ...reservation, acquiredAt: new Date().toISOString() }, null, 2)}\n`
  try {
    const handle = await open(file, 'wx')
    try {
      await handle.writeFile(payload)
    } finally {
      await handle.close()
    }
    return { created: true, reservation }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const existing = await readReservation(projectRoot)
    if (
      existing &&
      existing.featureId === reservation.featureId &&
      existing.taskId === reservation.taskId &&
      existing.attemptId === reservation.attemptId &&
      existing.hostRunId === reservation.hostRunId
    ) {
      return { created: false, reservation: existing, duplicate: true }
    }
    throw new StoreError(
      'PROJECT_BUSY',
      `Project already has an active implementer (${existing?.featureId}/${existing?.taskId})`,
    )
  }
}

export async function releaseProjectLock(projectRoot, reservation) {
  const existing = await readReservation(projectRoot)
  if (!existing) return false
  if (
    reservation &&
    (existing.featureId !== reservation.featureId ||
      existing.taskId !== reservation.taskId ||
      existing.attemptId !== reservation.attemptId)
  ) {
    throw new StoreError('LOCK_MISMATCH', 'Reservation does not match the active implementation')
  }
  await unlink(reservationPath(projectRoot))
  return true
}

async function loadAttemptFiles(featureDir, taskId, attemptId) {
  const dir = path.join(featureDir, 'revisions/tasks', taskId, attemptId)
  const request = JSON.parse(await readFile(path.join(dir, 'request.json'), 'utf8'))
  let beforeFiles = null
  try {
    beforeFiles = JSON.parse(await readFile(path.join(dir, 'before-files.json'), 'utf8'))
  } catch {
    beforeFiles = { allowed: {}, others: {} }
  }
  let storedResult = null
  try {
    storedResult = JSON.parse(await readFile(path.join(dir, 'result.json'), 'utf8'))
  } catch {
    storedResult = null
  }
  return { dir, request, beforeFiles, storedResult }
}

export async function detectScopeChange(projectRoot, request, beforeFiles) {
  const allowed = new Set((request.allowedFiles || []).map((file) => file.path))
  const violations = []
  const currentFiles = await listProjectFiles(projectRoot)
  const seen = new Set(currentFiles)

  for (const file of currentFiles) {
    if (allowed.has(file)) continue
    const now = await digestFile(projectRoot, file)
    const before = beforeFiles.others?.[file]
    if (!before) {
      violations.push({ path: file, reason: 'new-undeclared-file' })
      continue
    }
    if (before.sha256 !== now.sha256) {
      violations.push({ path: file, reason: 'undeclared-file-changed' })
    }
  }

  for (const [file, before] of Object.entries(beforeFiles.others || {})) {
    if (allowed.has(file) || seen.has(file)) continue
    if (before.exists) {
      violations.push({ path: file, reason: 'undeclared-file-removed' })
    }
  }

  return { changed: violations.length > 0, violations }
}

function mapResultStatus(report) {
  if (report.status === 'DONE' || report.status === 'DONE_WITH_CONCERNS') return 'review_pending'
  if (report.status === 'NEEDS_CONTEXT') return 'needs_context'
  if (report.status === 'BLOCKED') return 'blocked'
  throw new StoreError('INVALID_REPORT', `Unknown report.status ${report.status}`)
}

function concernsNeedHuman(report) {
  const concerns = report.concerns || []
  return concerns.some((item) => {
    const text = typeof item === 'string' ? item : item.message || ''
    return item?.requiresHuman === true || BUSINESS_CONCERN.test(text)
  })
}

function sameReport(left, right) {
  return sha256(Buffer.from(JSON.stringify(left))) === sha256(Buffer.from(JSON.stringify(right)))
}

/**
 * @param {string} featureDir
 * @param {{taskId:string,attemptId:string,expectedVersion:number,hostRunId:string,actor?:string}} input
 */
export async function startTask(featureDir, input = {}) {
  const resolved = path.resolve(featureDir)
  const { taskId, attemptId, expectedVersion, hostRunId, actor = 'coordinator' } = input
  if (!taskId || !attemptId || !hostRunId || !Number.isInteger(expectedVersion)) {
    throw new StoreError('INVALID_REQUEST', 'taskId, attemptId, hostRunId, and expectedVersion are required')
  }

  const status = await readFeature(resolved)
  const projectRoot = status.project?.root
  if (!projectRoot) throw new StoreError('MISSING_PROJECT', 'status.project.root is required')
  if (status.control.version !== expectedVersion) {
    throw new StoreError(
      'VERSION_CONFLICT',
      `expectedVersion ${expectedVersion} does not match disk version ${status.control.version}`,
    )
  }

  const current = status.runtime?.taskResults?.[taskId]
  if (current?.status === 'blocked' && current.attemptId === attemptId) {
    throw new StoreError('RETRY_BLOCKED', 'BLOCKED tasks cannot be retried with the same input/attempt')
  }

  await loadAttemptFiles(resolved, taskId, attemptId)

  const reservation = {
    featureId: status.id,
    taskId,
    attemptId,
    hostRunId,
  }

  const lock = await acquireProjectLock(projectRoot, reservation)
  try {
    const next = await mutateFeature(
      resolved,
      {
        expectedVersion,
        event: {
          type: 'task.start',
          actor,
          data: reservation,
        },
      },
      (draft) => {
        draft.runtime = draft.runtime || { activeTaskId: null, attempts: {}, taskResults: {} }
        const attempts = draft.runtime.attempts[taskId] || { count: 0 }
        const already = draft.runtime.taskResults[taskId]
        if (already?.status === 'running' && already.attemptId === attemptId && already.hostRunId === hostRunId) {
          return
        }
        draft.runtime.activeTaskId = taskId
        draft.runtime.attempts[taskId] = {
          count: Math.max(attempts.count || 0, Number(String(attemptId).replace(/\D/g, '')) || attempts.count || 0),
          current: attemptId,
        }
        draft.runtime.taskResults[taskId] = {
          ...(already || {}),
          status: 'running',
          attemptId,
          hostRunId,
        }
      },
    )
    return { status: next, reservation: lock.reservation, duplicate: Boolean(lock.duplicate) }
  } catch (error) {
    if (lock.created) await releaseProjectLock(projectRoot, reservation).catch(() => {})
    throw error
  }
}

/**
 * @param {string} featureDir
 * @param {object} report
 * @param {{expectedVersion:number,actor?:string}} options
 */
export async function acceptTaskResult(featureDir, report, options = {}) {
  const resolved = path.resolve(featureDir)
  const expectedVersion = options.expectedVersion
  if (!Number.isInteger(expectedVersion)) throw new StoreError('INVALID_REQUEST', 'expectedVersion is required')
  if (!report || !RESULT_STATUSES.has(report.status)) {
    throw new StoreError('INVALID_REPORT', 'report.status must be DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED')
  }
  for (const field of ['taskId', 'attemptId', 'hostRunId', 'summary']) {
    if (typeof report[field] !== 'string' || !report[field].trim()) {
      throw new StoreError('INVALID_REPORT', `report.${field} is required`)
    }
  }
  if (!Array.isArray(report.changedFiles) || !Array.isArray(report.verificationIds) || !Array.isArray(report.concerns)) {
    throw new StoreError('INVALID_REPORT', 'changedFiles, verificationIds, and concerns must be arrays')
  }

  const status = await readFeature(resolved)
  if (status.control.version !== expectedVersion) {
    throw new StoreError(
      'VERSION_CONFLICT',
      `expectedVersion ${expectedVersion} does not match disk version ${status.control.version}`,
    )
  }

  const { dir, request, beforeFiles, storedResult } = await loadAttemptFiles(
    resolved,
    report.taskId,
    report.attemptId,
  )
  const current = status.runtime?.attempts?.[report.taskId]?.current
  if (current && current !== report.attemptId) {
    throw new StoreError('STALE_ATTEMPT', `Attempt ${report.attemptId} is not current (${current})`)
  }
  if (storedResult && sameReport(storedResult, report)) {
    return { status, idempotent: true }
  }
  if (storedResult && !sameReport(storedResult, report)) {
    throw new StoreError('RESULT_CONFLICT', 'A different result is already stored for this attempt')
  }

  const scope = await detectScopeChange(status.project.root, request, beforeFiles)
  let runStatus = mapResultStatus(report)
  let reasonCode = null
  if (scope.changed) {
    runStatus = 'blocked'
    reasonCode = 'SCOPE_CHANGED'
  } else if (report.status === 'DONE_WITH_CONCERNS' && concernsNeedHuman(report)) {
    runStatus = 'blocked'
    reasonCode = 'BUSINESS_CONFLICT'
  }

  await writeFile(path.join(dir, 'result.json'), `${JSON.stringify(report, null, 2)}\n`)

  const next = await mutateFeature(
    resolved,
    {
      expectedVersion,
      event: {
        type: 'task.accept',
        actor: options.actor || report.hostRunId,
        data: {
          taskId: report.taskId,
          attemptId: report.attemptId,
          status: runStatus,
          reasonCode,
        },
      },
    },
    (draft) => {
      draft.runtime = draft.runtime || { activeTaskId: null, attempts: {}, taskResults: {} }
      draft.runtime.activeTaskId = null
      draft.runtime.taskResults[report.taskId] = {
        status: runStatus,
        attemptId: report.attemptId,
        hostRunId: report.hostRunId,
        summary: report.summary,
        changedFiles: report.changedFiles,
        verificationIds: report.verificationIds,
        concerns: report.concerns,
        requiredContext: report.requiredContext || [],
        exportedInterfaces: report.exportedInterfaces || [],
        resultRef: path.relative(resolved, path.join(dir, 'result.json')),
        reasonCode,
      }
    },
  )

  await releaseProjectLock(status.project.root, {
    featureId: status.id,
    taskId: report.taskId,
    attemptId: report.attemptId,
  }).catch(() => {})

  if (reasonCode === 'SCOPE_CHANGED') {
    const error = new StoreError(
      'SCOPE_CHANGED',
      `Non-allowed files changed: ${scope.violations.map((item) => item.path).join(', ')}`,
    )
    error.violations = scope.violations
    error.status = next
    throw error
  }

  return { status: next, idempotent: false, runStatus, reasonCode }
}

export async function inspectInterruptedTask(featureDir) {
  const resolved = path.resolve(featureDir)
  const status = await readFeature(resolved)
  const reservation = status.project?.root ? await readReservation(status.project.root) : null
  const taskId = reservation?.taskId || status.runtime?.activeTaskId
  if (!taskId) {
    return {
      taskId: null,
      attemptId: null,
      workspaceChanged: false,
      nextAction: nextAction({ status }),
      pending: [],
    }
  }
  const attemptId = reservation?.attemptId || status.runtime?.attempts?.[taskId]?.current
  let storedResult = null
  let beforeFiles = { allowed: {}, others: {} }
  let request = { allowedFiles: [] }
  if (attemptId) {
    try {
      const loaded = await loadAttemptFiles(resolved, taskId, attemptId)
      storedResult = loaded.storedResult
      beforeFiles = loaded.beforeFiles
      request = loaded.request
    } catch {
      // attempt files may be missing after a crash before prepare
    }
  }

  let workspaceChanged = false
  const pending = []
  if (status.project?.root) {
    const scope = await detectScopeChange(status.project.root, request, beforeFiles)
    workspaceChanged = scope.changed
    if (scope.changed) pending.push(`undeclared changes: ${scope.violations.map((item) => item.path).join(', ')}`)
  }
  if (reservation && !storedResult) pending.push('reservation exists without accepted result; confirm worker stopped before recover')
  if (storedResult && status.runtime?.taskResults?.[taskId]?.status === 'running') {
    pending.push('result file exists; accept it instead of replaying commands')
  }

  return {
    taskId,
    attemptId,
    workspaceChanged,
    reservation,
    hasResult: Boolean(storedResult),
    nextAction: nextAction({ status }),
    pending,
  }
}

export async function recoverReservation(featureDir, options = {}) {
  const { expectedVersion, actor, confirmWorkerStopped } = options
  if (!actor || !Number.isInteger(expectedVersion)) {
    throw new StoreError('INVALID_REQUEST', 'actor and expectedVersion are required')
  }
  if (confirmWorkerStopped !== true) {
    throw new StoreError(
      'CONFIRM_WORKER_STOPPED',
      'Set confirmWorkerStopped=true only after the host worker is known to be stopped',
    )
  }

  const resolved = path.resolve(featureDir)
  const status = await readFeature(resolved)
  const reservation = status.project?.root ? await readReservation(status.project.root) : null
  if (!reservation) throw new StoreError('NO_RESERVATION', 'No active implementation reservation')
  if (reservation.featureId !== status.id) {
    throw new StoreError('LOCK_MISMATCH', `Reservation belongs to ${reservation.featureId}`)
  }

  const next = await mutateFeature(
    resolved,
    {
      expectedVersion,
      event: {
        type: 'task.recover',
        actor,
        data: { taskId: reservation.taskId, attemptId: reservation.attemptId },
      },
    },
    (draft) => {
      draft.runtime.activeTaskId = null
      const current = draft.runtime.taskResults?.[reservation.taskId]
      if (current?.status === 'running' && !current.resultRef) {
        draft.runtime.taskResults[reservation.taskId] = {
          ...current,
          status: 'pending',
          recovered: true,
        }
      }
    },
  )
  await releaseProjectLock(status.project.root, reservation)
  return next
}
