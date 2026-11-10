#!/usr/bin/env node

/**
 * 解决什么问题：验证步骤必须在真实项目里跑命令，不能由 Agent 口头声称 passed。缺少统一入口时，伪造结果或漏跑都会让 FINAL_REVIEW 失去依据。
 * 通过什么方式解决：读取 --request 后调用 lib/verification.mjs 的 runVerification，内部用 execFile 真执行。本文件不改报告、不把失败改写成通过。
 * 触发时机：任务或最终验证清单已就绪、需要把命令跑完并留下真实退出码/输出时。
 * 被谁控制触发：主 Agent 在 VERIFYING 或任务 verify 列表上下令；人也可对同一 request 复跑。
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { traceCli, updateCurrentTrace } from './lib/monitor-events.mjs'
import { runVerification } from './lib/verification.mjs'
import { StoreError } from './lib/workspace-store.mjs'

async function main(argv) {
  const [featureDir, ...rest] = argv
  // CLI：必须带 --request；真正执行在 runVerification 内，失败原样抛出，不伪造 passed。
  if (!featureDir) {
    throw new StoreError('INVALID_REQUEST', 'Usage: node run-verification.mjs <feature-dir> --request request.json')
  }
  let requestPath = null
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === '--request') requestPath = rest[++index]
    else throw new StoreError('INVALID_REQUEST', `Unknown argument: ${rest[index]}`)
  }
  if (!requestPath) throw new StoreError('INVALID_REQUEST', '--request is required')
  const request = JSON.parse(await readFile(path.resolve(requestPath), 'utf8'))
  updateCurrentTrace({ taskId: request.taskId })
  const result = await runVerification(featureDir, request)
  console.log(JSON.stringify({ ok: true, result }, null, 2))
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  traceCli('run-verification.mjs')
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error.code || 'ERROR', message: error.message }, null, 2))
    process.exitCode = 1
  }
}
