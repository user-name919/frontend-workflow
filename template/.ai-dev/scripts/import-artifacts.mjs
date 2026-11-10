#!/usr/bin/env node

/**
 * 解决什么问题：旧工作区只有手写 Markdown，没有 intake/delivery JSON，后续渲染和门禁接不上。自动从 Markdown 正则“猜”业务事实会伪造决策证据，必须先结构化再等人确认。
 * 通过什么方式解决：draft 把调用方提供（或空）的 intake/delivery 写成 revisions/import-draft.json 并列出 gaps；accept 在人确认后备份旧 Markdown、写入 JSON、再 render，并作废全部 approvals。
 * 触发时机：要把遗留 Markdown 工作区迁到 schema 结构化产物、且准备让人复核草稿时。
 * 被谁控制触发：主 Agent 生成 draft；人确认后才允许 accept。脚本不会从 Markdown 发明结论。
 */

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { traceCli } from './lib/monitor-events.mjs'
import { validateIntake, emptyIntake } from './lib/intake.mjs'
import { validateDelivery, emptyDelivery } from './lib/delivery.mjs'
import { renderFeatureArtifacts } from './render-artifacts.mjs'
import { mutateFeature, readFeature, StoreError } from './lib/workspace-store.mjs'

const MARKDOWN_TO_BACKUP = [
  'artifacts/analysis/source-index.md',
  'artifacts/analysis/evidence.md',
  'artifacts/analysis/open-questions.md',
  'artifacts/analysis/scope.md',
  'artifacts/design/acceptance.md',
  'artifacts/design/tasks.md',
  'artifacts/design/traceability.md',
]

function usage() {
  return 'Usage: node .ai-dev/scripts/import-artifacts.mjs <feature-dir> <draft|accept> [--draft path] [--request request.json]'
}

async function backupMarkdown(featureDir) {
  const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '')
  const dir = path.join(featureDir, 'revisions', `import-backup-${stamp}`)
  await mkdir(dir, { recursive: true })
  for (const relative of MARKDOWN_TO_BACKUP) {
    try {
      await mkdir(path.dirname(path.join(dir, relative)), { recursive: true })
      await copyFile(path.join(featureDir, relative), path.join(dir, relative))
    } catch {
      // missing source is fine
    }
  }
  return dir
}

/**
 * 生成 import-draft.json：只序列化调用方给的（或空的）intake/delivery，并收集校验 gaps。
 * 不扫描旧 Markdown 填业务字段，避免用正则发明证据。无 sources 会记 EMPTY_SOURCES。
 * 草稿可以带 gaps 落盘；ok 仅表示当前结构已能通过校验，仍须人确认后才能 accept。
 */
export async function createImportDraft(featureDir, options = {}) {
  const resolved = path.resolve(featureDir)
  const status = await readFeature(resolved)
  const gaps = []

  // Do not invent business facts from Markdown regex.
  const intake = options.intake && typeof options.intake === 'object' ? options.intake : emptyIntake()
  const delivery = options.delivery && typeof options.delivery === 'object' ? options.delivery : emptyDelivery()

  const intakeResult = validateIntake(intake)
  if (!intakeResult.ok) {
    gaps.push(...intakeResult.errors.map((item) => ({ stage: 'intake', ...item })))
  }
  const deliveryResult = validateDelivery(intake, delivery, { phase: 'plan' })
  if (!deliveryResult.ok) {
    gaps.push(...deliveryResult.errors.map((item) => ({ stage: 'delivery', ...item })))
  }

  if (!intake.sources.length) {
    gaps.push({
      stage: 'intake',
      code: 'EMPTY_SOURCES',
      message: 'Draft has no sources; Agent must extract from originals and user must confirm',
    })
  }

  const draft = {
    schemaVersion: 1,
    featureId: status.id,
    createdAt: new Date().toISOString(),
    note: 'Review intake/delivery carefully. Accept only after human confirmation. Missing decision evidence must not be fabricated.',
    gaps,
    intake,
    delivery,
  }

  const draftPath = path.join(resolved, 'revisions/import-draft.json')
  await mkdir(path.dirname(draftPath), { recursive: true })
  await writeFile(draftPath, `${JSON.stringify(draft, null, 2)}\n`)
  return { draftPath, gaps, ok: gaps.length === 0 }
}

/**
 * 在人确认后把草稿写入 intake.json / delivery.json，备份旧 Markdown 并重新渲染派生文件。
 * 必须带 actor；校验失败分别抛 INVALID_INTAKE / INVALID_DELIVERY，不会部分接受。
 * 接受后清空全部 approvals，因为结构化导入可能改了范围和任务，旧门禁不再有效。
 */
export async function acceptImportDraft(featureDir, draftPath, options = {}) {
  const resolved = path.resolve(featureDir)
  const status = await readFeature(resolved)
  const expectedVersion = Number.isInteger(options.expectedVersion)
    ? options.expectedVersion
    : status.control.version
  if (!options.actor) throw new StoreError('INVALID_REQUEST', 'actor is required to accept import')

  const draft = JSON.parse(await readFile(path.resolve(draftPath), 'utf8'))
  const intakeResult = validateIntake(draft.intake)
  if (!intakeResult.ok) {
    throw new StoreError('INVALID_INTAKE', intakeResult.errors.map((item) => item.message).join('; '))
  }
  const deliveryResult = validateDelivery(draft.intake, draft.delivery, { phase: 'plan' })
  if (!deliveryResult.ok) {
    throw new StoreError('INVALID_DELIVERY', deliveryResult.errors.map((item) => item.message).join('; '))
  }

  const backupDir = await backupMarkdown(resolved)
  await writeFile(path.join(resolved, 'artifacts/analysis/intake.json'), `${JSON.stringify(draft.intake, null, 2)}\n`)
  await writeFile(path.join(resolved, 'artifacts/design/delivery.json'), `${JSON.stringify(draft.delivery, null, 2)}\n`)
  await renderFeatureArtifacts(resolved)

  return mutateFeature(
    resolved,
    {
      expectedVersion,
      event: {
        type: 'artifacts.import.accept',
        actor: options.actor,
        data: { draftPath: path.relative(resolved, path.resolve(draftPath)), backupDir },
      },
    },
    (next) => {
      next.control.artifactStatus = null
      // Invalidate all approvals after structured import.
      next.approvals = {
        scope: null,
        spec: null,
        plan: null,
        final: null,
      }
    },
  )
}

async function main(argv) {
  const [featureDir, action, ...rest] = argv
  if (!featureDir || !['draft', 'accept'].includes(action)) {
    throw new StoreError('INVALID_REQUEST', usage())
  }

  let draftPath = null
  let requestPath = null
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--draft') {
      draftPath = rest[++i]
    } else if (rest[i] === '--request') {
      requestPath = rest[++i]
    } else {
      throw new StoreError('INVALID_REQUEST', usage())
    }
  }

  // draft：可选 --request 提供 intake/delivery；缺省写空结构并标 gaps。
  if (action === 'draft') {
    let intake
    let delivery
    if (requestPath) {
      const request = JSON.parse(await readFile(path.resolve(requestPath), 'utf8'))
      intake = request.intake
      delivery = request.delivery
    }
    const result = await createImportDraft(featureDir, { intake, delivery })
    console.log(JSON.stringify({ ok: true, ...result }, null, 2))
    return
  }

  // accept：必须同时给 --draft 与含 actor/expectedVersion 的 --request，防止无人确认就落盘。
  if (!draftPath) throw new StoreError('INVALID_REQUEST', 'accept requires --draft <path>')
  if (!requestPath) throw new StoreError('INVALID_REQUEST', 'accept requires --request with actor and expectedVersion')
  const request = JSON.parse(await readFile(path.resolve(requestPath), 'utf8'))
  const status = await acceptImportDraft(featureDir, draftPath, {
    actor: request.actor,
    expectedVersion: request.expectedVersion,
  })
  console.log(JSON.stringify({
    ok: true,
    id: status.id,
    artifactStatus: status.control.artifactStatus,
    controlVersion: status.control.version,
  }, null, 2))
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  traceCli('import-artifacts.mjs')
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error.code || 'ERROR', message: error.message }, null, 2))
    process.exit(1)
  }
}
