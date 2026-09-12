#!/usr/bin/env node

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

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
 * Structural feature validation.
 * @param {string} featureDir
 * @param {{ status?: object, gate?: string }} [options]
 * @returns {Promise<{ok: boolean, errors: string[], gate?: object}>}
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
    errors.push(`status.json: stale artifacts: ${status.consistency.staleArtifacts.join(', ')}`)
  }

  if (status.schemaVersion === 2) {
    if (!Number.isInteger(status.control?.version) || status.control.version < 0) {
      errors.push('status.json: control.version must be a non-negative integer')
    }
    if (!status.policy?.mode) errors.push('status.json: policy.mode is required')
  }

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
  if (!rawFeatureDir) {
    console.error('Usage: node .ai-dev/scripts/validate-change.mjs <feature-dir> [--gate scope|spec|plan|final] [--json]')
    process.exit(1)
  }

  const featureDir = path.resolve(rawFeatureDir)
  const result = await validateFeature(featureDir, { gate })
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
  await main(process.argv.slice(2))
}
