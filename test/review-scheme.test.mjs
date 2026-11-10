import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { REVIEW_SCHEME, REVIEW_SYNC, REVIEW_SOURCES, validateReviewScheme } from '../template/.ai-dev/scripts/lib/review-scheme.mjs'
import { writeReviewScheme, readableScheme } from './helpers/review-scheme.mjs'

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'review-scheme-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(path.join(dir, 'artifacts/design'), { recursive: true })
  await mkdir(path.join(dir, 'artifacts/analysis'), { recursive: true })
  await writeFile(path.join(dir, REVIEW_SOURCES[0]), '# FR-1 重试\nAC-1 失败后可以重试')
  await writeFile(path.join(dir, REVIEW_SOURCES[1]), JSON.stringify({ requirements: [{ id: 'FR-1', disposition: 'included' }] }))
  await writeFile(path.join(dir, REVIEW_SOURCES[2]), JSON.stringify({ acceptance: [{ id: 'AC-1' }] }))
  const record = await writeReviewScheme(dir)
  return { dir, record }
}

test('readable scheme needs no inline IDs; comparison must cover all FR/AC and actual sections', async t => {
  const { dir, record } = await fixture(t)
  assert.ok(!/FR-|AC-/.test(readableScheme))
  assert.equal((await validateReviewScheme(dir)).ok, true)
  delete record.coverage['AC-1']
  assert.ok((await validateReviewScheme(dir, record)).errors.some(e => e.code === 'REVIEW_SYNC_COVERAGE'))
  record.coverage['AC-1'] = { section: '不存在的章节', evidence: 'claimed' }
  assert.equal((await validateReviewScheme(dir, record)).ok, false)
})

test('every source or readable edit invalidates comparison until refreshed', async t => {
  const { dir } = await fixture(t)
  for (const file of REVIEW_SOURCES) {
    const old = await readFile(path.join(dir, file), 'utf8')
    await writeFile(path.join(dir, file), old + '\n')
    assert.ok((await validateReviewScheme(dir)).errors.some(e => e.code === 'REVIEW_SYNC_STALE'))
    await writeFile(path.join(dir, file), old)
    assert.equal((await validateReviewScheme(dir)).ok, true)
  }
})

test('missing diagrams, unresolved semantic checks and missing records cannot pass', async t => {
  const { dir, record } = await fixture(t)
  record.checks.contracts.result = 'fail'
  assert.ok((await validateReviewScheme(dir, record)).errors.some(e => e.code === 'REVIEW_SYNC_CHECK'))
  await writeFile(path.join(dir, REVIEW_SCHEME), '# 目标\n正文')
  assert.ok((await validateReviewScheme(dir)).errors.some(e => e.code === 'REVIEW_SCHEME_DIAGRAM'))
  await rm(path.join(dir, REVIEW_SYNC))
  assert.equal((await validateReviewScheme(dir)).ok, false)
})

test('CLI seals current evidence, detects subsequent edits, and never rewrites either scheme', async t => {
  const { dir, record } = await fixture(t)
  const request = path.join(dir, 'comparison.json')
  await writeFile(request, JSON.stringify({ ...record, digests: {} }))
  const script = path.resolve('template/.ai-dev/scripts/sync-review-scheme.mjs')
  const original = await readFile(path.join(dir, REVIEW_SOURCES[0]), 'utf8')
  execFileSync(process.execPath, [script, dir, 'seal', '--request', request])
  execFileSync(process.execPath, [script, dir, 'check'])
  assert.equal(await readFile(path.join(dir, REVIEW_SOURCES[0]), 'utf8'), original)
  assert.equal(await readFile(path.join(dir, REVIEW_SCHEME), 'utf8'), readableScheme)
  await writeFile(path.join(dir, REVIEW_SCHEME), readableScheme + '\n修改')
  assert.throws(() => execFileSync(process.execPath, [script, dir, 'check'], { stdio: 'pipe' }))
})
