/**
 * 解决什么问题：任务尝试要能开始、验收、中断恢复，且不锁整个项目、也不因范围变化回滚代码。
 * 通过什么方式解决：只锁 feature status；结果按 attempt 落盘；无 PROJECT 锁；无 SCOPE_CHANGED 回滚。
 * 触发时机：派实施、收实施结果、崩溃后 inspect/recover。
 * 被谁控制触发：任务脚本 / 协调器。不 spawn 模型。
 */

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { nextAction } from './orchestrator.mjs'
import { mutateFeature, readFeature, StoreError } from './workspace-store.mjs'

const RESULT_STATUSES = new Set(['DONE', 'DONE_WITH_CONCERNS', 'NEEDS_CONTEXT', 'BLOCKED'])
const BUSINESS_CONCERN = /conflict|ownership|契约|合同|产品未决|ambiguity|职责/i

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
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

function runningAttempt(status) {
  const taskId = status.runtime?.activeTaskId
  const result = taskId ? status.runtime?.taskResults?.[taskId] : null
  if (!taskId || result?.status !== 'running') return null
  return {
    taskId,
    attemptId: result.attemptId || status.runtime?.attempts?.[taskId]?.current || null,
    hostRunId: result.hostRunId || null,
  }
}

/**
 * 把指定 attempt 标成 running。不锁项目目录，其他写者仍可改业务代码。
 * 同 attempt+hostRunId 重复 start 视为幂等。BLOCKED 同 attempt 禁止重试。
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
  const duplicate =
    status.runtime?.taskResults?.[taskId]?.status === 'running' &&
    status.runtime?.taskResults?.[taskId]?.attemptId === attemptId &&
    status.runtime?.taskResults?.[taskId]?.hostRunId === hostRunId
  return { status: next, reservation, duplicate }
}

/**
 * 验收实施报告。DONE/DONE_WITH_CONCERNS → review_pending；业务冲突则 blocked。
 * 同内容幂等，不同内容冲突。不因范围变化回滚工作区（无 SCOPE_CHANGED 回滚）。
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

  const { dir, storedResult } = await loadAttemptFiles(resolved, report.taskId, report.attemptId)
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

  let runStatus = mapResultStatus(report)
  let reasonCode = null
  if (report.status === 'DONE_WITH_CONCERNS' && concernsNeedHuman(report)) {
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

  return { status: next, idempotent: false, runStatus, reasonCode }
}

/**
 * 查看中断的 running 尝试，给出待办提示。不改状态。
 * 项目级锁已删除，workspaceChanged 恒为 false。
 */
export async function inspectInterruptedTask(featureDir) {
  const resolved = path.resolve(featureDir)
  const status = await readFeature(resolved)
  const active = runningAttempt(status)
  const taskId = active?.taskId || status.runtime?.activeTaskId || null
  if (!taskId) {
    return {
      taskId: null,
      attemptId: null,
      // PROJECT 锁已删除：不再对比工作区指纹，也不因 SCOPE_CHANGED 回滚。
      workspaceChanged: false,
      nextAction: nextAction({ status }),
      pending: [],
    }
  }
  const attemptId = active?.attemptId || status.runtime?.attempts?.[taskId]?.current
  let storedResult = null
  if (attemptId) {
    try {
      const loaded = await loadAttemptFiles(resolved, taskId, attemptId)
      storedResult = loaded.storedResult
    } catch {
      // attempt files may be missing after a crash before prepare
    }
  }

  const pending = []
  if (!storedResult) pending.push('running without accepted result; recover if the implementer sub-agent has stopped')
  if (storedResult && status.runtime?.taskResults?.[taskId]?.status === 'running') {
    pending.push('result file exists; accept it instead of replaying commands')
  }

  return {
    taskId,
    attemptId,
    workspaceChanged: false,
    reservation: active,
    hasResult: Boolean(storedResult),
    nextAction: nextAction({ status }),
    pending,
  }
}

/**
 * 仅在确认实施子 Agent 已停后，把无结果的 running 放回 pending。
 * 不回滚文件，也不持有项目锁。
 */
export async function recoverReservation(featureDir, options = {}) {
  const { expectedVersion, actor, confirmWorkerStopped } = options
  if (!actor || !Number.isInteger(expectedVersion)) {
    throw new StoreError('INVALID_REQUEST', 'actor and expectedVersion are required')
  }
  if (confirmWorkerStopped !== true) {
    throw new StoreError(
      'CONFIRM_WORKER_STOPPED',
      'Set confirmWorkerStopped=true only after the implementer sub-agent is known to be stopped',
    )
  }

  const resolved = path.resolve(featureDir)
  const status = await readFeature(resolved)
  const active = runningAttempt(status)
  if (!active) throw new StoreError('NO_ACTIVE_RUN', 'No running implementer to recover')

  return mutateFeature(
    resolved,
    {
      expectedVersion,
      event: {
        type: 'task.recover',
        actor,
        data: { taskId: active.taskId, attemptId: active.attemptId },
      },
    },
    (draft) => {
      draft.runtime.activeTaskId = null
      const current = draft.runtime.taskResults?.[active.taskId]
      if (current?.status === 'running' && !current.resultRef) {
        draft.runtime.taskResults[active.taskId] = {
          ...current,
          status: 'pending',
          recovered: true,
        }
      }
    },
  )
}
