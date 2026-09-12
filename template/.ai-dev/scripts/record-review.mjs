#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { acceptReview, validateReview } from './lib/reviews.mjs'
import { decideReviewAction } from './lib/review-loop.mjs'
import { adaptDeliveryReview } from './lib/review-adapter.mjs'
import { readFeature, StoreError } from './lib/workspace-store.mjs'

function usage() {
  return 'Usage: node .ai-dev/scripts/record-review.mjs <feature-dir> <validate|accept|decide|adapt> --request request.json [--report report.json] [--packet packet.json]'
}

async function loadJson(filePath) {
  return JSON.parse(await readFile(path.resolve(filePath), 'utf8'))
}

async function main(argv) {
  const [featureDir, action, ...rest] = argv
  if (!featureDir || !['validate', 'accept', 'decide', 'adapt'].includes(action)) {
    throw new StoreError('INVALID_REQUEST', usage())
  }

  let requestPath = null
  let reportPath = null
  let packetPath = null
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--request') requestPath = rest[++i]
    else if (rest[i] === '--report') reportPath = rest[++i]
    else if (rest[i] === '--packet') packetPath = rest[++i]
    else throw new StoreError('INVALID_REQUEST', usage())
  }
  if (!requestPath || !reportPath) throw new StoreError('INVALID_REQUEST', usage())

  const request = await loadJson(requestPath)
  const report = await loadJson(reportPath)

  if (action === 'adapt') {
    if (!packetPath) throw new StoreError('INVALID_REQUEST', 'adapt requires --packet sealed-packet.json')
    const packet = await loadJson(packetPath)
    const status = await readFeature(featureDir)
    const adapted = await adaptDeliveryReview({
      packet,
      report,
      request,
      projectRoot: status.project?.root,
    })
    console.log(JSON.stringify({ ok: adapted.contractOk && adapted.workflowValidation.ok, ...adapted }, null, 2))
    if (!adapted.contractOk || !adapted.workflowValidation.ok) process.exitCode = 1
    return
  }

  if (action === 'validate') {
    const result = validateReview(report, { request })
    console.log(JSON.stringify({ ok: result.ok, errors: result.errors }, null, 2))
    if (!result.ok) process.exitCode = 1
    return
  }

  if (action === 'decide') {
    const decision = decideReviewAction({
      report,
      fixRound: request.fixRound || 0,
      maxFixRounds: request.maxFixRounds || 3,
    })
    console.log(JSON.stringify({ ok: true, ...decision }, null, 2))
    return
  }

  const status = await acceptReview(featureDir, report, {
    request,
    expectedVersion: request.expectedVersion,
    actor: request.actor,
  })
  console.log(
    JSON.stringify(
      {
        ok: true,
        controlVersion: status.control.version,
        reviews: status.reviews,
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
    console.error(JSON.stringify({ ok: false, code: error.code || 'ERROR', message: error.message, errors: error.errors }, null, 2))
    process.exit(1)
  }
}
