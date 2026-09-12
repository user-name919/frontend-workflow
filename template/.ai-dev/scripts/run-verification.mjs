#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { runVerification } from './lib/verification.mjs'
import { StoreError } from './lib/workspace-store.mjs'

async function main(argv) {
  const [featureDir, ...rest] = argv
  if (!featureDir) {
    throw new StoreError('INVALID_REQUEST', 'Usage: node run-verification.mjs <feature-dir> --request request.json')
  }
  let requestPath = null
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === '--request') requestPath = rest[++index]
    else throw new StoreError('INVALID_REQUEST', `Unknown argument: ${rest[index]}`)
  }
  if (!requestPath) throw new StoreError('INVALID_REQUEST', '--request is required')
  const request = JSON.parse(await readFile(path.resolve(requestPath), 'utf8'))
  const result = await runVerification(featureDir, request)
  console.log(JSON.stringify({ ok: true, result }, null, 2))
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error.code || 'ERROR', message: error.message }, null, 2))
    process.exitCode = 1
  }
}
