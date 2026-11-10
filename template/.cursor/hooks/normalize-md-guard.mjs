#!/usr/bin/env node

/**
 * 解决什么问题：Agent 可能整份 Read 含 data:image base64 的 Markdown，撑爆上下文。
 * 通过什么方式解决：beforeReadFile 检测到嵌入 base64（或超大 md）则 deny，提示先跑 normalize。
 * 触发时机：Cursor beforeReadFile。
 * 被谁控制触发：.cursor/hooks.json；本脚本不抽图、不改磁盘。
 */

import path from 'node:path'
import process from 'node:process'

import { fileNeedsNormalize } from '../../.ai-dev/scripts/lib/markdown-assets.mjs'
import { startActivity } from '../../.ai-dev/scripts/lib/monitor-events.mjs'

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

function filePathFrom(input) {
  return (
    input.filePath ||
    input.file_path ||
    input.path ||
    input.uri ||
    (typeof input.file === 'string' ? input.file : null) ||
    null
  )
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

function suggestOutDir(projectRoot, filePath) {
  const base = path.basename(filePath, path.extname(filePath)) || 'source'
  const slug = base.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 60) || 'source'
  return path.join(projectRoot, '.ai-dev', 'inbox', slug)
}

const input = await readStdinJson()
const trace = startActivity({ kind: 'hook', component: 'normalize-md-guard.mjs', projectRoot: projectRootFrom(input) })
process.once('exit', (code) => trace.finish(code))
const filePath = filePathFrom(input)

if (!filePath || !/\.md$/i.test(filePath)) {
  process.stdout.write(`${JSON.stringify({ permission: 'allow' })}\n`)
  process.exit(0)
}

// Already-normalized `*-clean.md` under .ai-dev inbox/sources is always readable.
const normalized = filePath.replace(/\\/g, '/')
if (
  normalized.includes('/.ai-dev/') &&
  /\/(inbox|sources)\//.test(normalized) &&
  /\/[^/]+-clean\.md$/i.test(normalized)
) {
  process.stdout.write(`${JSON.stringify({ permission: 'allow' })}\n`)
  process.exit(0)
}

const check = await fileNeedsNormalize(filePath)
if (!check.needs) {
  process.stdout.write(`${JSON.stringify({ permission: 'allow' })}\n`)
  process.exit(0)
}

const projectRoot = projectRootFrom(input)
const outDir = suggestOutDir(projectRoot, filePath)
const message = [
  `Blocked reading Markdown with embedded base64 images (or oversized file): ${filePath}`,
  'Normalize first, then read the produced `<原名>-clean.md` only:',
  `node .ai-dev/scripts/normalize-markdown-assets.mjs --input ${JSON.stringify(filePath)} --out-dir ${JSON.stringify(outDir)}`,
  `Then analyze the *-clean.md under ${outDir} and assets/ on demand. Do not fully re-read the original.`,
].join('\n')

process.stdout.write(
  `${JSON.stringify({
    permission: 'deny',
    user_message: message,
    agent_message: message,
  })}\n`,
)
process.exit(0)
