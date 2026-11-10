#!/usr/bin/env node

/**
 * 解决什么问题：任务执行需要预约、落结果、处理中断和回收，不能各写一份 runtime。DONE 若直接当“已完成”，就会跳过独立审核。中断残留的 reservation 也会把 IMPLEMENTING 锁死。
 * 通过什么方式解决：start 预约当前任务；accept 写入报告（DONE / DONE_WITH_CONCERNS 会变成 review_pending）；inspect 查看中断现场；recover 在确认 worker 已停后释放预约。写操作都走 lib/task-runs.mjs。
 * 触发时机：动手前 start、交出结果时 accept、发现中断时 inspect、确认进程已死后 recover。
 * 被谁控制触发：主 Agent 按编排下令；人可提供 --request / --report。本脚本不自己判定产品是否做对。
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { traceCli, updateCurrentTrace } from './lib/monitor-events.mjs'
import {
  acceptTaskResult,
  inspectInterruptedTask,
  recoverReservation,
  startTask,
} from './lib/task-runs.mjs'
import { StoreError } from './lib/workspace-store.mjs'

function usage() {
  return 'Usage: node .ai-dev/scripts/record-task-result.mjs <feature-dir> <start|accept|inspect|recover> [--request request.json] [--report report.json]'
}

async function loadJson(filePath) {
  return JSON.parse(await readFile(path.resolve(filePath), 'utf8'))
}

async function main(argv) {
  const [featureDir, action, ...rest] = argv
  if (!featureDir || !['start', 'accept', 'inspect', 'recover'].includes(action)) {
    throw new StoreError('INVALID_REQUEST', usage())
  }

  let requestPath = null
  let reportPath = null
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === '--request') requestPath = rest[++index]
    else if (rest[index] === '--report') reportPath = rest[++index]
    else throw new StoreError('INVALID_REQUEST', usage())
  }

  // inspect：只读中断/预约现场，不改 status，供决定是 recover 还是继续。
  if (action === 'inspect') {
    console.log(JSON.stringify({ ok: true, ...(await inspectInterruptedTask(featureDir)) }, null, 2))
    return
  }

  if (!requestPath) throw new StoreError('INVALID_REQUEST', usage())
  const request = await loadJson(requestPath)
  updateCurrentTrace({ taskId: request.taskId, attemptId: request.attemptId })

  // start：登记 reservation；重复提交时 duplicate 为真，避免双工人同时改同一任务。
  if (action === 'start') {
    const result = await startTask(featureDir, request)
    console.log(
      JSON.stringify(
        {
          ok: true,
          controlVersion: result.status.control.version,
          reservation: result.reservation,
          duplicate: result.duplicate,
        },
        null,
        2,
      ),
    )
    return
  }

  // recover：确认 worker 已停后释放预约；未确认不得清锁，以免活进程与新工人打架。
  if (action === 'recover') {
    const status = await recoverReservation(featureDir, request)
    console.log(JSON.stringify({ ok: true, controlVersion: status.control.version, state: status.state }, null, 2))
    return
  }

  // accept：写入任务报告。DONE / DONE_WITH_CONCERNS 会落到 review_pending，不能当成已终审。
  if (!reportPath) throw new StoreError('INVALID_REQUEST', usage())
  const report = await loadJson(reportPath)
  updateCurrentTrace({ taskId: report.taskId, attemptId: report.attemptId })
  const accepted = await acceptTaskResult(featureDir, report, {
    expectedVersion: request.expectedVersion,
    actor: request.actor,
  })
  console.log(
    JSON.stringify(
      {
        ok: true,
        controlVersion: accepted.status.control.version,
        runStatus: accepted.runStatus,
        idempotent: accepted.idempotent,
      },
      null,
      2,
    ),
  )
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  traceCli('record-task-result.mjs')
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(
      JSON.stringify(
        { ok: false, code: error.code || 'ERROR', message: error.message, errors: error.errors, violations: error.violations },
        null,
        2,
      ),
    )
    process.exitCode = 1
  }
}
