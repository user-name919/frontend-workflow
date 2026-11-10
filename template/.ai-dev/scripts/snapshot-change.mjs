#!/usr/bin/env node

/**
 * 解决什么问题：过门、准备任务或验收时需要证明“当时读到的内容是什么”。只记路径不够，文件事后会被改。没有校验入口就无法发现快照与现状漂移。
 * 通过什么方式解决：capture 按 request 对指定空间做内容哈希并落盘快照；verify 按 snapshot-id 重算哈希对比。底层委托 lib/snapshots.mjs，本文件只做 CLI 分发。
 * 触发时机：过门前固化输入、prepare-task 记 before 快照、或事后核对快照是否仍匹配。
 * 被谁控制触发：主 Agent 或 prepare-task 等脚本下令 capture；人/主 Agent 可用 verify 复查。
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { traceCli } from './lib/monitor-events.mjs'
import { captureSnapshot, readSnapshot, verifySnapshot } from './lib/snapshots.mjs'
import { StoreError } from './lib/workspace-store.mjs'

function usage() {
  return 'Usage: node .ai-dev/scripts/snapshot-change.mjs <feature-dir> <capture|verify> [--request request.json] [--snapshot-id id]'
}

async function main(argv) {
  const [featureDir, action, ...rest] = argv
  if (!featureDir || !['capture', 'verify'].includes(action)) {
    // 只接受 capture/verify，其它动词一律 INVALID_REQUEST。
    throw new StoreError('INVALID_REQUEST', usage())
  }

  let requestPath = null
  let snapshotId = null
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--request') requestPath = rest[++i]
    else if (rest[i] === '--snapshot-id') snapshotId = rest[++i]
    else throw new StoreError('INVALID_REQUEST', usage())
  }

  // capture：必须带 --request，把 gate/路径/新鲜度写成一份可复核的内容哈希快照。
  if (action === 'capture') {
    if (!requestPath) throw new StoreError('INVALID_REQUEST', 'capture requires --request')
    const request = JSON.parse(await readFile(path.resolve(requestPath), 'utf8'))
    const snapshot = await captureSnapshot(featureDir, request)
    console.log(JSON.stringify({ ok: true, snapshot }, null, 2))
    return
  }

  // verify：按 --snapshot-id 重读并比对哈希，只报告是否仍匹配，不改业务状态。
  if (!snapshotId) throw new StoreError('INVALID_REQUEST', 'verify requires --snapshot-id')
  const snapshot = await readSnapshot(featureDir, snapshotId)
  const result = await verifySnapshot(featureDir, snapshot)
  console.log(JSON.stringify({ ok: true, snapshotId, ...result }, null, 2))
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  traceCli('snapshot-change.mjs')
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error.code || 'ERROR', message: error.message }, null, 2))
    process.exit(1)
  }
}
