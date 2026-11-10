#!/usr/bin/env node

/**
 * 解决什么问题：审核报告必须先校验形状、再决定修/过/升级给人，最后才写入 status.reviews。主 Agent 不能自己验收自己。独立 reviewer 的交付物还要先适配成工作流认识的结构。
 * 通过什么方式解决：validate 只查报告合同；decide 按轮次与 maxFixRounds 给出下一步；accept 落盘审核结果；adapt 把 sealed packet + 报告转成工作流校验结果。均委托 reviews / review-loop / review-adapter。
 * 触发时机：子 Agent 交出报告后、主 Agent 决定是否再修或过门、以及需要把外部审核包适配进来时。
 * 被谁控制触发：主 Agent 在收到 reviewer 产物后下令；人可直接跑 validate/decide。本脚本不代替人批 scope/final。
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { traceCli, updateCurrentTrace } from './lib/monitor-events.mjs'
import { acceptReview, validateReview } from './lib/reviews.mjs'
import { decideReviewAction } from './lib/review-loop.mjs'
import { adaptDeliveryReview } from './lib/review-adapter.mjs'
import { readFeature, StoreError } from './lib/workspace-store.mjs'

function usage() {
  return 'Usage: node .ai-dev/scripts/record-review.mjs <feature-dir> <validate|accept|decide|adapt> --request request.json [--report report.json] [--packet packet.json]'
}

async function loadJson(filePath) {
  return JSON.parse(await readFile(path.resolve(filePath), 'utf8'))
}

async function main(argv) {
  const [featureDir, action, ...rest] = argv
  if (!featureDir || !['validate', 'accept', 'decide', 'adapt'].includes(action)) {
    throw new StoreError('INVALID_REQUEST', usage())
  }

  let requestPath = null
  let reportPath = null
  let packetPath = null
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--request') requestPath = rest[++i]
    else if (rest[i] === '--report') reportPath = rest[++i]
    else if (rest[i] === '--packet') packetPath = rest[++i]
    else throw new StoreError('INVALID_REQUEST', usage())
  }
  // 四个子命令都要 request+report；adapt 另外强制 sealed packet。
  if (!requestPath || !reportPath) throw new StoreError('INVALID_REQUEST', usage())

  const request = await loadJson(requestPath)
  const report = await loadJson(reportPath)
  updateCurrentTrace({ taskId: request.taskId || report.taskId, attemptId: request.attemptId || report.attemptId })

  // adapt：必须带 sealed packet；合同或工作流校验失败则退出码 1，但不擅自 accept。
  if (action === 'adapt') {
    if (!packetPath) throw new StoreError('INVALID_REQUEST', 'adapt requires --packet sealed-packet.json')
    const packet = await loadJson(packetPath)
    const status = await readFeature(featureDir)
    const adapted = await adaptDeliveryReview({
      packet,
      report,
      request,
      projectRoot: status.project?.root,
    })
    console.log(JSON.stringify({ ok: adapted.contractOk && adapted.workflowValidation.ok, ...adapted }, null, 2))
    if (!adapted.contractOk || !adapted.workflowValidation.ok) process.exitCode = 1
    return
  }

  // validate：只检查报告相对 request 是否完整合法，ok 不表示产品通过。
  if (action === 'validate') {
    const result = validateReview(report, { request })
    console.log(JSON.stringify({ ok: result.ok, errors: result.errors }, null, 2))
    if (!result.ok) process.exitCode = 1
    return
  }

  // decide：按 fixRound 与 maxFixRounds 建议再修、升级给人还是可接受，不写 status。
  if (action === 'decide') {
    const decision = decideReviewAction({
      report,
      fixRound: request.fixRound || 0,
      maxFixRounds: request.maxFixRounds || 3,
    })
    console.log(JSON.stringify({ ok: true, ...decision }, null, 2))
    return
  }

  // accept：通过校验的报告写入 status.reviews，并推进 control.version。
  const status = await acceptReview(featureDir, report, {
    request,
    expectedVersion: request.expectedVersion,
    actor: request.actor,
  })
  console.log(
    JSON.stringify(
      {
        ok: true,
        controlVersion: status.control.version,
        reviews: status.reviews,
      },
      null,
      2,
    ),
  )
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  traceCli('record-review.mjs')
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error.code || 'ERROR', message: error.message, errors: error.errors }, null, 2))
    process.exit(1)
  }
}
