#!/usr/bin/env node

/**
 * 解决什么问题：过门或交付前需要确认 feature 目录结构、status 字段和审批是否齐全。只看“文件在不在”不够，但本脚本也不判断需求语义对不对，避免把结构检查当成产品正确。
 * 通过什么方式解决：检查必填文件/目录、state、id 与目录名、consistency、schema v2 的 control/policy，以及按状态要求的 approvals。可选 --gate 再跑 evaluateGate。ok 只表示结构（和可选 gate）通过。
 * 触发时机：呈现 scope / spec / plan / final 门之前，或主 Agent 自检工作区是否可继续时。
 * 被谁控制触发：主 Agent 按工作流规则跑；人可在终端加 --json / --gate 复查。
 */

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { traceCli } from './lib/monitor-events.mjs'
import { evaluateGate } from './lib/gates.mjs'

const requiredFiles = [
  'status.json',
  'artifacts/analysis/intake.json',
  'artifacts/analysis/source-index.md',
  'artifacts/analysis/scope.md',
  'artifacts/analysis/evidence.md',
  'artifacts/analysis/open-questions.md',
  'artifacts/design/delivery.json',
  'artifacts/design/frontend-spec.md',
  'artifacts/design/implementation-plan.md',
  'artifacts/design/tasks.md',
  'artifacts/design/acceptance.md',
  'artifacts/design/traceability.md',
  'artifacts/coding-changes/changed-files.json',
  'artifacts/coding-changes/changes.patch',
  'artifacts/verification/verification.md',
]

const requiredDirectories = ['artifacts/coding-changes/coding', 'revisions']

const states = new Set([
  'INGEST',
  'SCOPE_REVIEW',
  'SPEC_REVIEW',
  'PLAN_REVIEW',
  'IMPLEMENTING',
  'VERIFYING',
  'FINAL_REVIEW',
  'COMPLETE',
  'BLOCKED',
])

const approvalRequirements = {
  SPEC_REVIEW: ['scope'],
  PLAN_REVIEW: ['scope', 'spec'],
  IMPLEMENTING: ['scope', 'spec', 'plan'],
  VERIFYING: ['scope', 'spec', 'plan'],
  FINAL_REVIEW: ['scope', 'spec', 'plan'],
  COMPLETE: ['scope', 'spec', 'plan', 'final'],
}

/**
 * 结构校验：必填产物、status 形状、过期产物和按状态要求的审批。
 * 可选 gate 会再跑 evaluateGate，但 ok 仍不等于语义正确或实现正确。
 * 已有 staleArtifacts 即失败，必须先 update-consistency resolve 再过门。
 */
export async function validateFeature(featureDir, options = {}) {
  const resolved = path.resolve(featureDir)
  const errors = []

  for (const file of requiredFiles) {
    try {
      const fileStat = await stat(path.join(resolved, file))
      if (!fileStat.isFile()) errors.push(`${file}: not a file`)
    } catch {
      errors.push(`${file}: missing`)
    }
  }
  for (const directory of requiredDirectories) {
    try {
      const directoryStat = await stat(path.join(resolved, directory))
      if (!directoryStat.isDirectory()) errors.push(`${directory}: not a directory`)
    } catch {
      errors.push(`${directory}: missing`)
    }
  }

  let status = options.status
  if (!status) {
    try {
      status = JSON.parse(await readFile(path.join(resolved, 'status.json'), 'utf8'))
    } catch (error) {
      errors.push(`status.json: invalid JSON (${error.message})`)
      return { ok: false, errors }
    }
  }

  if (!states.has(status.state)) errors.push(`status.json: invalid state ${status.state}`)
  if (!status.id || !status.title) errors.push('status.json: id and title are required')
  if (status.id && path.basename(resolved) !== status.id) {
    errors.push('status.json: id must match the feature directory')
  }
  if (!['document', 'user', 'generated'].includes(status.idSource)) {
    errors.push('status.json: invalid idSource')
  }
  if (!Array.isArray(status.externalIds)) errors.push('status.json: externalIds must be an array')
  if (!status.project?.root || !status.project?.baseCommit || !Array.isArray(status.project?.initialChanges)) {
    errors.push('status.json: project root, baseCommit, and initialChanges are required')
  }
  if (!Number.isInteger(status.consistency?.revision) || status.consistency.revision < 0) {
    errors.push('status.json: consistency.revision must be a non-negative integer')
  }
  if (!Array.isArray(status.consistency?.staleArtifacts)) {
    errors.push('status.json: consistency.staleArtifacts must be an array')
  } else if (status.consistency.staleArtifacts.length) {
    // 有过期产物时结构校验失败，防止拿旧 Markdown 过门。
    errors.push(`status.json: stale artifacts: ${status.consistency.staleArtifacts.join(', ')}`)
  }

  // schema v2 才强制 control.version 与 policy.mode；旧文档需先 migrate。
  if (status.schemaVersion === 2) {
    if (!Number.isInteger(status.control?.version) || status.control.version < 0) {
      errors.push('status.json: control.version must be a non-negative integer')
    }
    if (!status.policy?.mode) errors.push('status.json: policy.mode is required')
  }

  // 高状态要求对应审批已落盘；缺 approvedBy/approvedAt 不能当已过门。
  for (const gate of approvalRequirements[status.state] || []) {
    const approval = status.approvals?.[gate]
    if (!approval?.approvedBy || !approval?.approvedAt) {
      errors.push(`status.json: ${gate} approval is required for ${status.state}`)
    }
  }

  let gateResult
  if (options.gate) {
    gateResult = await evaluateGate(resolved, options.gate)
    if (!gateResult.ok) {
      for (const item of gateResult.errors) {
        errors.push(`${item.code}: ${item.message}`)
      }
    }
  }

  return { ok: errors.length === 0, errors, gate: gateResult }
}

function parseCliArgs(argv) {
  const positional = []
  let gate = null
  let json = false
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--gate') {
      gate = argv[++i]
    } else if (argv[i] === '--json') {
      json = true
    } else {
      positional.push(argv[i])
    }
  }
  return { featureDir: positional[0], gate, json }
}

async function main(argv) {
  const { featureDir: rawFeatureDir, gate, json } = parseCliArgs(argv)
  // CLI：缺 feature-dir 直接退出；--gate 把结构检查和门禁绑在一次运行里。
  if (!rawFeatureDir) {
    console.error('Usage: node .ai-dev/scripts/validate-change.mjs <feature-dir> [--gate scope|spec|plan|final] [--json]')
    process.exit(1)
  }

  const featureDir = path.resolve(rawFeatureDir)
  const result = await validateFeature(featureDir, { gate })
  // --json 给编排脚本机读；默认文本给人或主 Agent 快速扫错误列表。
  if (json) {
    if (!result.ok) {
      console.log(JSON.stringify({ ok: false, errors: result.errors, gate: result.gate }, null, 2))
      process.exitCode = 1
      return
    }
    const status = JSON.parse(await readFile(path.join(featureDir, 'status.json'), 'utf8'))
    console.log(JSON.stringify({
      ok: true,
      featureDir: path.relative(process.cwd(), featureDir),
      state: status.state,
      gate: result.gate || null,
    }, null, 2))
    return
  }

  if (!result.ok) {
    console.error(result.errors.map((error) => `- ${error}`).join('\n'))
    process.exit(1)
  }

  const status = JSON.parse(await readFile(path.join(featureDir, 'status.json'), 'utf8'))
  console.log(`Valid feature: ${path.relative(process.cwd(), featureDir)} (${status.state})`)
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  traceCli('validate-change.mjs')
  await main(process.argv.slice(2))
}
