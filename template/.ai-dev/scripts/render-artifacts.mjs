#!/usr/bin/env node

/**
 * 解决什么问题：intake.json / delivery.json 是结构化源，Markdown 是给人看的投影。手改 Markdown 会和 JSON 分叉。渲染必须原子写入，且不能覆盖人手维护的 frontend-spec.md。
 * 通过什么方式解决：校验 intake（必选）和 delivery（若存在），调用 renderIntake / renderDelivery 生成分析与验收/任务/追溯 Markdown，经临时目录 rename 一次性落盘。不写 frontend-spec.md 或 implementation-plan.md。
 * 触发时机：结构化 JSON 更新后、import accept 之后，需要刷新派生 Markdown 时。
 * 被谁控制触发：主 Agent 在改完 JSON 后跑；import-artifacts accept 会间接调用本脚本的导出函数。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

import { traceCli } from './lib/monitor-events.mjs'
import { validateIntake, renderIntake } from './lib/intake.mjs'
import { validateDelivery, renderDelivery } from './lib/delivery.mjs'
import { readFeature } from './lib/workspace-store.mjs'

async function writeAllOrNothing(featureDir, files) {
  const staging = path.join(featureDir, `.render-staging-${randomBytes(4).toString('hex')}`)
  await mkdir(staging, { recursive: true })
  try {
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(staging, relative)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, content)
    }
    for (const relative of Object.keys(files)) {
      const from = path.join(staging, relative)
      const to = path.join(featureDir, relative)
      await mkdir(path.dirname(to), { recursive: true })
      await rename(from, to)
    }
  } finally {
    // best-effort cleanup of staging leftovers
    try {
      const { rm } = await import('node:fs/promises')
      await rm(staging, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}

/**
 * 把 intake/delivery JSON 投影成派生 Markdown，全程先写 staging 再 rename，失败不留半成品。
 * delivery.json 缺失只渲染 intake 侧；校验失败分别抛 INVALID_INTAKE / INVALID_DELIVERY。
 * 任务结果仅用于追溯表展示，不会回头改 JSON，也不会碰 frontend-spec.md。
 */
export async function renderFeatureArtifacts(featureDir, options = {}) {
  const resolved = path.resolve(featureDir)
  const intake = JSON.parse(await readFile(path.join(resolved, 'artifacts/analysis/intake.json'), 'utf8'))
  const intakeCheck = validateIntake(intake)
  if (!intakeCheck.ok) {
    const error = new Error(intakeCheck.errors.map((item) => item.message).join('; '))
    error.code = 'INVALID_INTAKE'
    error.errors = intakeCheck.errors
    throw error
  }

  const files = { ...renderIntake(intake) }

  const deliveryPath = path.join(resolved, 'artifacts/design/delivery.json')
  let delivery
  try {
    delivery = JSON.parse(await readFile(deliveryPath, 'utf8'))
  } catch {
    delivery = null
  }

  if (delivery) {
    const deliveryCheck = validateDelivery(intake, delivery, { phase: options.phase || 'plan' })
    if (!deliveryCheck.ok) {
      const error = new Error(deliveryCheck.errors.map((item) => item.message).join('; '))
      error.code = 'INVALID_DELIVERY'
      error.errors = deliveryCheck.errors
      throw error
    }
    let taskResults = {}
    try {
      const status = await readFeature(resolved)
      taskResults = status.runtime?.taskResults || {}
    } catch {
      taskResults = {}
    }
    Object.assign(files, renderDelivery(intake, delivery, taskResults))
  }

  await writeAllOrNothing(resolved, files)
  return Object.keys(files).sort()
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1])
// CLI：对单个 feature-dir 全量渲染，成功打印 written 列表，失败带错误码退出。
if (invokedPath === fileURLToPath(import.meta.url)) {
  traceCli('render-artifacts.mjs')
  const featureDir = process.argv[2]
  if (!featureDir) {
    console.error('Usage: node .ai-dev/scripts/render-artifacts.mjs <feature-dir>')
    process.exit(1)
  }
  try {
    const written = await renderFeatureArtifacts(featureDir)
    console.log(JSON.stringify({ ok: true, written }, null, 2))
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error.code || 'ERROR', message: error.message, errors: error.errors }, null, 2))
    process.exit(1)
  }
}
