#!/usr/bin/env node

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
