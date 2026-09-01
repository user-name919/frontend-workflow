#!/usr/bin/env node

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const [, , rawChangeDir] = process.argv
if (!rawChangeDir) {
  console.error('Usage: node .ai-dev/scripts/validate-change.mjs <change-dir>')
  process.exit(1)
}

const changeDir = path.resolve(rawChangeDir)
const requiredFiles = [
  'status.json',
  'source-index.md',
  'scope.md',
  'evidence.md',
  'open-questions.md',
  'frontend-spec.md',
  'implementation-plan.md',
  'tasks.md',
  'acceptance.md',
  'traceability.md',
  'verification.md'
]
const states = new Set([
  'INGEST',
  'SCOPE_REVIEW',
  'SPEC_REVIEW',
  'PLAN_REVIEW',
  'IMPLEMENTING',
  'VERIFYING',
  'FINAL_REVIEW',
  'COMPLETE',
  'BLOCKED'
])

const errors = []
for (const file of requiredFiles) {
  try {
    const fileStat = await stat(path.join(changeDir, file))
    if (!fileStat.isFile()) errors.push(`${file}: not a file`)
  } catch {
    errors.push(`${file}: missing`)
  }
}

let status
try {
  status = JSON.parse(await readFile(path.join(changeDir, 'status.json'), 'utf8'))
  if (!states.has(status.state)) errors.push(`status.json: invalid state ${status.state}`)
  if (!status.id || !status.title) errors.push('status.json: id and title are required')
} catch (error) {
  errors.push(`status.json: invalid JSON (${error.message})`)
}

const approvalRequirements = {
  SPEC_REVIEW: ['scope'],
  PLAN_REVIEW: ['scope', 'spec'],
  IMPLEMENTING: ['scope', 'spec', 'plan'],
  VERIFYING: ['scope', 'spec', 'plan'],
  FINAL_REVIEW: ['scope', 'spec', 'plan'],
  COMPLETE: ['scope', 'spec', 'plan', 'final']
}

for (const gate of approvalRequirements[status?.state] || []) {
  const approval = status?.approvals?.[gate]
  if (!approval?.approvedBy || !approval?.approvedAt) {
    errors.push(`status.json: ${gate} approval is required for ${status.state}`)
  }
}

if (errors.length) {
  console.error(errors.map(error => `- ${error}`).join('\n'))
  process.exit(1)
}

console.log(`Valid change: ${path.relative(process.cwd(), changeDir)} (${status.state})`)
