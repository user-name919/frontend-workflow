#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { migrateFeature, StoreError } from './lib/workspace-store.mjs'
import {
  blockFeature,
  recordDelegation,
  recordHumanApproval,
  resumeFeature,
  transitionFeature,
} from './lib/workflow-state.mjs'
import { computeNext } from './lib/orchestrator.mjs'
import { recoverReservation } from './lib/task-runs.mjs'

function usage() {
  return 'Usage: node .ai-dev/scripts/workflow-control.mjs <feature-dir> <migrate|inspect|next|transition|block|resume|approve|delegate|recover> [--request request.json]'
}

function parseArgs(argv) {
  const [featureDir, action, ...rest] = argv
  if (!featureDir || !action) throw new StoreError('INVALID_REQUEST', usage())

  let requestPath = null
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === '--request') {
      requestPath = rest[index + 1]
      index += 1
      if (!requestPath) throw new StoreError('INVALID_REQUEST', '--request requires a path')
    } else {
      throw new StoreError('INVALID_REQUEST', usage())
    }
  }
  return { featureDir: path.resolve(featureDir), action, requestPath }
}

async function loadRequest(requestPath, required) {
  if (!required) return {}
  if (!requestPath) throw new StoreError('INVALID_REQUEST', 'This action requires --request request.json')
  try {
    return JSON.parse(await readFile(path.resolve(requestPath), 'utf8'))
  } catch (error) {
    throw new StoreError('INVALID_REQUEST', `Cannot read request JSON: ${error.message}`)
  }
}

async function inspectFeature(featureDir) {
  const statusPath = path.join(featureDir, 'status.json')
  let raw
  try {
    raw = await readFile(statusPath, 'utf8')
  } catch (error) {
    throw new StoreError('MISSING_STATUS', `Cannot read status.json: ${error.message}`)
  }

  let status
  try {
    status = JSON.parse(raw)
  } catch (error) {
    return {
      ok: false,
      featureDir,
      schemaVersion: null,
      needsMigration: false,
      invalidJson: true,
      error: error.message,
    }
  }

  const schemaVersion = status.schemaVersion === undefined ? 1 : status.schemaVersion
  const needsMigration = schemaVersion === 1 || status.schemaVersion === undefined
  return {
    ok: true,
    featureDir,
    id: status.id ?? null,
    state: status.state ?? null,
    schemaVersion,
    needsMigration,
    controlVersion: status.control?.version ?? null,
    blocked: status.control?.blocked ?? null,
    staleArtifacts: status.consistency?.staleArtifacts ?? [],
  }
}

async function dispatch(featureDir, action, requestPath) {
  switch (action) {
    case 'inspect':
      return inspectFeature(featureDir)
    case 'next': {
      const request = await loadRequest(requestPath, false)
      return computeNext(featureDir, {
        actor: request.actor || 'orchestrator',
        capabilities: request.capabilities,
        gates: request.gates,
      })
    }
    case 'migrate':
      return migrateFeature(featureDir)
    case 'transition': {
      const request = await loadRequest(requestPath, true)
      return transitionFeature(featureDir, request.to, {
        actor: request.actor,
        expectedVersion: request.expectedVersion,
        decisionRef: request.decisionRef,
      })
    }
    case 'block': {
      const request = await loadRequest(requestPath, true)
      return blockFeature(featureDir, {
        reasonCode: request.reasonCode,
        requiredInput: request.requiredInput,
        actor: request.actor,
        expectedVersion: request.expectedVersion,
      })
    }
    case 'resume': {
      const request = await loadRequest(requestPath, true)
      return resumeFeature(featureDir, {
        actor: request.actor,
        expectedVersion: request.expectedVersion,
      })
    }
    case 'approve': {
      const request = await loadRequest(requestPath, true)
      return recordHumanApproval(featureDir, {
        gate: request.gate,
        actor: request.actor,
        decisionRef: request.decisionRef,
        expectedVersion: request.expectedVersion,
      })
    }
    case 'delegate': {
      const request = await loadRequest(requestPath, true)
      return recordDelegation(featureDir, {
        actor: request.actor,
        decisionRef: request.decisionRef,
        expectedVersion: request.expectedVersion,
        gates: request.gates,
      })
    }
    case 'recover': {
      const request = await loadRequest(requestPath, true)
      return recoverReservation(featureDir, {
        actor: request.actor,
        expectedVersion: request.expectedVersion,
        confirmWorkerStopped: request.confirmWorkerStopped,
      })
    }
    default:
      throw new StoreError('UNKNOWN_ACTION', `Unknown action: ${action}`)
  }
}

async function main(argv) {
  try {
    const { featureDir, action, requestPath } = parseArgs(argv)
    const result = await dispatch(featureDir, action, requestPath)
    // migrate/transition/etc return full status — keep output JSON-serializable.
    if (action !== 'inspect' && action !== 'migrate') {
      // Still print status JSON for mutating commands.
    }
    if (action === 'migrate') {
      console.log(
        JSON.stringify(
          {
            ok: true,
            action,
            id: result.id,
            state: result.state,
            schemaVersion: result.schemaVersion,
            controlVersion: result.control.version,
          },
          null,
          2,
        ),
      )
      return
    }
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    const payload = {
      ok: false,
      code: error.code || 'ERROR',
      message: error.message,
      errors: error.errors || undefined,
    }
    console.error(JSON.stringify(payload, null, 2))
    process.exitCode = 1
  }
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2))
}

export { dispatch, inspectFeature, parseArgs }
