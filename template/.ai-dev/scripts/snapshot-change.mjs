#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { captureSnapshot, readSnapshot, verifySnapshot } from './lib/snapshots.mjs'
import { StoreError } from './lib/workspace-store.mjs'

function usage() {
  return 'Usage: node .ai-dev/scripts/snapshot-change.mjs <feature-dir> <capture|verify> [--request request.json] [--snapshot-id id]'
}

async function main(argv) {
  const [featureDir, action, ...rest] = argv
  if (!featureDir || !['capture', 'verify'].includes(action)) {
    throw new StoreError('INVALID_REQUEST', usage())
  }

  let requestPath = null
  let snapshotId = null
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--request') requestPath = rest[++i]
    else if (rest[i] === '--snapshot-id') snapshotId = rest[++i]
    else throw new StoreError('INVALID_REQUEST', usage())
  }

  if (action === 'capture') {
    if (!requestPath) throw new StoreError('INVALID_REQUEST', 'capture requires --request')
    const request = JSON.parse(await readFile(path.resolve(requestPath), 'utf8'))
    const snapshot = await captureSnapshot(featureDir, request)
    console.log(JSON.stringify({ ok: true, snapshot }, null, 2))
    return
  }

  if (!snapshotId) throw new StoreError('INVALID_REQUEST', 'verify requires --snapshot-id')
  const snapshot = await readSnapshot(featureDir, snapshotId)
  const result = await verifySnapshot(featureDir, snapshot)
  console.log(JSON.stringify({ ok: true, snapshotId, ...result }, null, 2))
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error.code || 'ERROR', message: error.message }, null, 2))
    process.exit(1)
  }
}
