#!/usr/bin/env node

/**
 * 解决什么问题：status.json 的状态、阻塞、审批、委托和任务预约不能被各脚本各改一遍，否则会出现版本冲突和非法跳转。需要唯一入口做迁移、查询、推进和人工决策。
 * 通过什么方式解决：子命令 migrate / inspect / next / transition / block / resume / approve / delegate / recover。写操作走 workspace-store 与 workflow-state，并用 expectedVersion 防并发覆盖。inspect 只读；next 调 orchestrator.computeNext；recover 清任务预约。
 * 触发时机：主 Agent 问“下一步”、过门、阻塞/恢复、记录人批或委托、以及旧 schema 需要迁移时。
 * 被谁控制触发：主 Agent 是主要下令方；人可通过 --request JSON 批准或委托。其它脚本不应绕过本入口直接改 status。
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { traceCli } from './lib/monitor-events.mjs'
import { migrateFeature, StoreError } from './lib/workspace-store.mjs'
import {
  blockFeature,
  recordDelegation,
  recordHumanApproval,
  resumeFeature,
  transitionFeature,
} from './lib/workflow-state.mjs'
import { computeNext } from './lib/orchestrator.mjs'
import { recoverReservation } from './lib/task-runs.mjs'

function usage() {
  return 'Usage: node .ai-dev/scripts/workflow-control.mjs <feature-dir> <migrate|inspect|next|transition|block|resume|approve|delegate|recover> [--request request.json]'
}

/**
 * 解析 <feature-dir> <action> [--request path]。缺参数或多余参数一律 INVALID_REQUEST。
 * 只认 --request，避免把未知开关吞掉后误跑写操作。
 */
function parseArgs(argv) {
  const [featureDir, action, ...rest] = argv
  if (!featureDir || !action) throw new StoreError('INVALID_REQUEST', usage())

  let requestPath = null
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === '--request') {
      requestPath = rest[index + 1]
      index += 1
      if (!requestPath) throw new StoreError('INVALID_REQUEST', '--request requires a path')
    } else {
      throw new StoreError('INVALID_REQUEST', usage())
    }
  }
  return { featureDir: path.resolve(featureDir), action, requestPath }
}

async function loadRequest(requestPath, required) {
  if (!required) return {}
  if (!requestPath) throw new StoreError('INVALID_REQUEST', 'This action requires --request request.json')
  try {
    return JSON.parse(await readFile(path.resolve(requestPath), 'utf8'))
  } catch (error) {
    throw new StoreError('INVALID_REQUEST', `Cannot read request JSON: ${error.message}`)
  }
}

/**
 * 只读查看 status.json：schema 版本、是否待迁移、阻塞和过期产物。
 * 文件缺失抛 MISSING_STATUS；JSON 坏了则返回 ok:false 而不抛，方便调用方先诊断再 migrate。
 */
async function inspectFeature(featureDir) {
  const statusPath = path.join(featureDir, 'status.json')
  let raw
  try {
    raw = await readFile(statusPath, 'utf8')
  } catch (error) {
    throw new StoreError('MISSING_STATUS', `Cannot read status.json: ${error.message}`)
  }

  let status
  try {
    status = JSON.parse(raw)
  } catch (error) {
    return {
      ok: false,
      featureDir,
      schemaVersion: null,
      needsMigration: false,
      invalidJson: true,
      error: error.message,
    }
  }

  const schemaVersion = status.schemaVersion === undefined ? 1 : status.schemaVersion
  // 缺 schemaVersion 视为 v1，必须先 migrate 才能走 v2 控制面。
  const needsMigration = schemaVersion === 1 || status.schemaVersion === undefined
  return {
    ok: true,
    featureDir,
    id: status.id ?? null,
    state: status.state ?? null,
    schemaVersion,
    needsMigration,
    controlVersion: status.control?.version ?? null,
    blocked: status.control?.blocked ?? null,
    staleArtifacts: status.consistency?.staleArtifacts ?? [],
  }
}

/**
 * 按 action 分发到只读查询或带版本号的状态变更，是改 status 的唯一脚本入口。
 * 需要请求体的命令缺 --request 会 INVALID_REQUEST；未知 action 为 UNKNOWN_ACTION。
 */
async function dispatch(featureDir, action, requestPath) {
  switch (action) {
    // inspect：不改盘，供主 Agent 判断要不要 migrate 或能否 next。
    case 'inspect':
      return inspectFeature(featureDir)
    // next：计算下一步动作与门禁，不直接改 state；request 可选。
    case 'next': {
      const request = await loadRequest(requestPath, false)
      return computeNext(featureDir, {
        actor: request.actor || 'orchestrator',
        capabilities: request.capabilities,
        gates: request.gates,
      })
    }
    // migrate：把 v1 / 缺版本的 status 升到 schema v2，补齐 control/policy/runtime。
    case 'migrate':
      return migrateFeature(featureDir)
    // transition：在合法边上推进 state，必须带 to / actor / expectedVersion。
    case 'transition': {
      const request = await loadRequest(requestPath, true)
      return transitionFeature(featureDir, request.to, {
        actor: request.actor,
        expectedVersion: request.expectedVersion,
        decisionRef: request.decisionRef,
      })
    }
    // block：记下 reasonCode 与 requiredInput，把工作流挂起等人或证据。
    case 'block': {
      const request = await loadRequest(requestPath, true)
      return blockFeature(featureDir, {
        reasonCode: request.reasonCode,
        requiredInput: request.requiredInput,
        actor: request.actor,
        expectedVersion: request.expectedVersion,
      })
    }
    // resume：清除 blocked，回到可 next 的状态；仍校验 expectedVersion。
    case 'resume': {
      const request = await loadRequest(requestPath, true)
      return resumeFeature(featureDir, {
        actor: request.actor,
        expectedVersion: request.expectedVersion,
      })
    }
    // approve：记录人在某 gate 的批准，脚本本身不代替人做产品决策。
    case 'approve': {
      const request = await loadRequest(requestPath, true)
      return recordHumanApproval(featureDir, {
        gate: request.gate,
        actor: request.actor,
        decisionRef: request.decisionRef,
        expectedVersion: request.expectedVersion,
      })
    }
    // delegate：记下人把哪些 gate 委托给 Agent，后续 next 会按委托放行。
    case 'delegate': {
      const request = await loadRequest(requestPath, true)
      return recordDelegation(featureDir, {
        actor: request.actor,
        decisionRef: request.decisionRef,
        expectedVersion: request.expectedVersion,
        gates: request.gates,
      })
    }
    // recover：在确认 worker 已停后释放任务预约，避免死锁在 IMPLEMENTING。
    case 'recover': {
      const request = await loadRequest(requestPath, true)
      return recoverReservation(featureDir, {
        actor: request.actor,
        expectedVersion: request.expectedVersion,
        confirmWorkerStopped: request.confirmWorkerStopped,
      })
    }
    default:
      // 未知子命令不落盘，避免把拼写错误当成状态变更。
      throw new StoreError('UNKNOWN_ACTION', `Unknown action: ${action}`)
  }
}

async function main(argv) {
  try {
    const { featureDir, action, requestPath } = parseArgs(argv)
    const result = await dispatch(featureDir, action, requestPath)
    // migrate/transition/etc return full status — keep output JSON-serializable.
    if (action !== 'inspect' && action !== 'migrate') {
      // Still print status JSON for mutating commands.
    }
    if (action === 'migrate') {
      console.log(
        JSON.stringify(
          {
            ok: true,
            action,
            id: result.id,
            state: result.state,
            schemaVersion: result.schemaVersion,
            controlVersion: result.control.version,
          },
          null,
          2,
        ),
      )
      return
    }
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    const payload = {
      ok: false,
      code: error.code || 'ERROR',
      message: error.message,
      errors: error.errors || undefined,
    }
    console.error(JSON.stringify(payload, null, 2))
    process.exitCode = 1
  }
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  traceCli('workflow-control.mjs')
  await main(process.argv.slice(2))
}

export { dispatch, inspectFeature, parseArgs }
