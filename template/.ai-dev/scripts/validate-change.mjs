#!/usr/bin/env node

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const [, , rawFeatureDir] = process.argv
if (!rawFeatureDir) {
  console.error('Usage: node .ai-dev/scripts/validate-change.mjs <feature-dir>')
  process.exit(1)
}

const featureDir = path.resolve(rawFeatureDir)
const requiredFiles = [
  'status.json',
  'artifacts/analysis/source-index.md',
  'artifacts/analysis/scope.md',
  'artifacts/analysis/evidence.md',
  'artifacts/analysis/open-questions.md',
  'artifacts/design/frontend-spec.md',
  'artifacts/design/implementation-plan.md',
  'artifacts/design/tasks.md',
  'artifacts/design/acceptance.md',
  'artifacts/design/traceability.md',
  'artifacts/coding-changes/changed-files.json',
  'artifacts/coding-changes/changes.patch',
  'artifacts/verification/verification.md'
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
  'BLOCKED'
])

const errors = []
for (const file of requiredFiles) {
  try {
    const fileStat = await stat(path.join(featureDir, file))
    if (!fileStat.isFile()) errors.push(`${file}: not a file`)
  } catch {
    errors.push(`${file}: missing`)
  }
}
for (const directory of requiredDirectories) {
  try {
    const directoryStat = await stat(path.join(featureDir, directory))
    if (!directoryStat.isDirectory()) errors.push(`${directory}: not a directory`)
  } catch {
    errors.push(`${directory}: missing`)
  }
}

let status
try {
  status = JSON.parse(await readFile(path.join(featureDir, 'status.json'), 'utf8'))
  if (!states.has(status.state)) errors.push(`status.json: invalid state ${status.state}`)
  if (!status.id || !status.title) errors.push('status.json: id and title are required')
  if (status.id && path.basename(featureDir) !== status.id) errors.push('status.json: id must match the feature directory')
  if (!['document', 'user', 'generated'].includes(status.idSource)) errors.push('status.json: invalid idSource')
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
    errors.push(`status.json: stale artifacts: ${status.consistency.staleArtifacts.join(', ')}`)
  }
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

console.log(`Valid feature: ${path.relative(process.cwd(), featureDir)} (${status.state})`)
