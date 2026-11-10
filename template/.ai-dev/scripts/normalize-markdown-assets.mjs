#!/usr/bin/env node

/**
 * 解决什么问题：含 data:image base64 的 Markdown 不能整份进 Agent 上下文。
 * 通过什么方式解决：调用 markdown-assets.normalizeMarkdownAssets，写出 `<原名>-clean.md` + assets + manifest。
 * 触发时机：读 PRD / 来源 MD 之前。
 * 被谁控制触发：主 Agent（Skill 要求）或人手工执行。
 */

import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { traceCli } from './lib/monitor-events.mjs'
import { normalizeMarkdownAssets, slugifySegment } from './lib/markdown-assets.mjs'
import { StoreError } from './lib/workspace-store.mjs'

function usage() {
  return [
    'Usage:',
    '  node .ai-dev/scripts/normalize-markdown-assets.mjs --input <raw.md> --out-dir <dir>',
    '  node .ai-dev/scripts/normalize-markdown-assets.mjs --input <raw.md> --feature-dir <feature> --source-slug <slug>',
    '',
    'Options:',
    '  --project-root <dir>  Optional sandbox root; outDir must stay inside it',
  ].join('\n')
}

function parseArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--input') options.input = argv[++i]
    else if (arg === '--out-dir') options.outDir = argv[++i]
    else if (arg === '--feature-dir') options.featureDir = argv[++i]
    else if (arg === '--source-slug') options.sourceSlug = argv[++i]
    else if (arg === '--project-root') options.projectRoot = argv[++i]
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new StoreError('INVALID_REQUEST', usage())
  }
  return options
}

export async function main(argv) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log(usage())
    return { ok: true, help: true }
  }
  if (!options.input) throw new StoreError('INVALID_REQUEST', usage())

  if (options.featureDir && !options.sourceSlug) {
    const base = path.basename(options.input, path.extname(options.input))
    options.sourceSlug = slugifySegment(base, 'source')
  }

  const result = await normalizeMarkdownAssets(options.input, {
    outDir: options.outDir,
    featureDir: options.featureDir,
    sourceSlug: options.sourceSlug,
    projectRoot: options.projectRoot,
  })
  console.log(JSON.stringify({ ok: true, ...result }, null, 2))
  return result
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  traceCli('normalize-markdown-assets.mjs')
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(
      JSON.stringify({ ok: false, code: error.code || 'ERROR', message: error.message }, null, 2),
    )
    process.exit(1)
  }
}
