#!/usr/bin/env node

/**
 * 解决什么问题：主 Agent 已把任务落到 review_pending，却停下来没派审核子 Agent，当前会话不会出现独立审核。
 * 通过什么方式解决：扫描待审任务，仅当该键还没催过时向 stdout 写 followup_message；本进程不 spawn、不点 Task。
 * 触发时机：Cursor stop hook，主 Agent 本轮结束时。
 * 被谁控制触发：Cursor 宿主按 hooks 配置调用本脚本；催过的键记在 .ai-dev/runtime/review-followup.json。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { followupMessage, scanReviewPendingFeatures, shouldInjectReviewFollowup } from '../../.ai-dev/scripts/lib/review-followup.mjs'

async function readStdinJson() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function projectRootFrom(input) {
  return (
    input.workspaceRoot ||
    input.workspace_root ||
    input.cwd ||
    (Array.isArray(input.workspace_roots) ? input.workspace_roots[0] : null) ||
    process.cwd()
  )
}

async function readStamp(projectRoot) {
  try {
    return JSON.parse(await readFile(path.join(projectRoot, '.ai-dev/runtime/review-followup.json'), 'utf8'))
  } catch {
    return { requested: [] }
  }
}

async function writeStamp(projectRoot, requested) {
  const file = path.join(projectRoot, '.ai-dev/runtime/review-followup.json')
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify({ requested, updatedAt: new Date().toISOString() }, null, 2)}\n`)
}

// 读 stdin 定位项目根，扫 review_pending，对照 stamp 找第一个该催的键。
// Node 不能自己弹出子 Agent 卡片，只能把 follow-up 交给宿主注入。
// 没有目标就输出空对象退出；有目标则记下该键再写 followup_message。
const input = await readStdinJson()
const projectRoot = projectRootFrom(input)
const stamp = await readStamp(projectRoot)
const pending = await scanReviewPendingFeatures(projectRoot)
const target = pending
  .map((item) => ({ ...item, ...shouldInjectReviewFollowup(item.status, stamp.requested) }))
  .find((item) => item.inject)

if (!target) {
  process.stdout.write('{}\n')
  process.exit(0)
}

await writeStamp(projectRoot, [...stamp.requested, target.key])
process.stdout.write(
  `${JSON.stringify({ followup_message: followupMessage(target.taskId || target.status.runtime?.activeTaskId) })}\n`,
)
