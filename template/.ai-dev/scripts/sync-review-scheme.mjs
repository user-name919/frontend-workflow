#!/usr/bin/env node
import { readFile, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { REVIEW_SYNC, reviewSchemeDigests, validateReviewScheme } from './lib/review-scheme.mjs'

// The Agent writes both documents and supplies its comparison evidence.
// This command binds that evidence to current bytes; it does not rewrite prose or approve a gate.
try {
  const [featureDir, action, flag, request, ...extra] = process.argv.slice(2)
  if (!featureDir || !['seal', 'check'].includes(action) || extra.length ||
      (action === 'seal' ? flag !== '--request' || !request : flag !== undefined)) {
    throw new Error('Usage: node sync-review-scheme.mjs <feature-dir> seal --request comparison.json | check')
  }
  let record
  if (action === 'seal') {
    record = JSON.parse(await readFile(request, 'utf8'))
    record.digests = await reviewSchemeDigests(featureDir)
  }
  const result = await validateReviewScheme(featureDir, record)
  if (result.ok && action === 'seal') {
    const target = path.join(featureDir, REVIEW_SYNC)
    const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' })
    await rename(temporary, target)
  }
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
} catch (error) {
  console.error(JSON.stringify({ ok: false, message: error.message }))
  process.exitCode = 1
}
