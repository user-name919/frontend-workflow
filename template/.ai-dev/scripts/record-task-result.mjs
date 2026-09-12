#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  acceptTaskResult,
  inspectInterruptedTask,
  recoverReservation,
  startTask,
} from './lib/task-runs.mjs'
import { StoreError } from './lib/workspace-store.mjs'

function usage() {
  return 'Usage: node .ai-dev/scripts/record-task-result.mjs <feature-dir> <start|accept|inspect|recover> [--request request.json] [--report report.json]'
}

async function loadJson(filePath) {
  return JSON.parse(await readFile(path.resolve(filePath), 'utf8'))
}

async function main(argv) {
  const [featureDir, action, ...rest] = argv
  if (!featureDir || !['start', 'accept', 'inspect', 'recover'].includes(action)) {
    throw new StoreError('INVALID_REQUEST', usage())
  }

  let requestPath = null
  let reportPath = null
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === '--request') requestPath = rest[++index]
    else if (rest[index] === '--report') reportPath = rest[++index]
    else throw new StoreError('INVALID_REQUEST', usage())
  }

  if (action === 'inspect') {
    console.log(JSON.stringify({ ok: true, ...(await inspectInterruptedTask(featureDir)) }, null, 2))
    return
  }

  if (!requestPath) throw new StoreError('INVALID_REQUEST', usage())
  const request = await loadJson(requestPath)

  if (action === 'start') {
    const result = await startTask(featureDir, request)
    console.log(
      JSON.stringify(
        {
          ok: true,
          controlVersion: result.status.control.version,
          reservation: result.reservation,
          duplicate: result.duplicate,
        },
        null,
        2,
      ),
    )
    return
  }

  if (action === 'recover') {
    const status = await recoverReservation(featureDir, request)
    console.log(JSON.stringify({ ok: true, controlVersion: status.control.version, state: status.state }, null, 2))
    return
  }

  if (!reportPath) throw new StoreError('INVALID_REQUEST', usage())
  const report = await loadJson(reportPath)
  const accepted = await acceptTaskResult(featureDir, report, {
    expectedVersion: request.expectedVersion,
    actor: request.actor,
  })
  console.log(
    JSON.stringify(
      {
        ok: true,
        controlVersion: accepted.status.control.version,
        runStatus: accepted.runStatus,
        idempotent: accepted.idempotent,
      },
      null,
      2,
    ),
  )
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(
      JSON.stringify(
        { ok: false, code: error.code || 'ERROR', message: error.message, errors: error.errors, violations: error.violations },
        null,
        2,
      ),
    )
    process.exitCode = 1
  }
}
