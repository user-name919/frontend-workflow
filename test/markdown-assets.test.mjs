import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  cleanMarkdownFileName,
  fileNeedsNormalize,
  hasEmbeddedBase64Images,
  normalizeMarkdownAssets,
  resolveOutDir,
} from '../template/.ai-dev/scripts/lib/markdown-assets.mjs'
import { StoreError } from '../template/.ai-dev/scripts/lib/workspace-store.mjs'

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

async function tmpRoot() {
  return mkdtemp(path.join(os.tmpdir(), 'md-assets-'))
}

test('cleanMarkdownFileName appends -clean before extension', () => {
  assert.equal(cleanMarkdownFileName('/tmp/考点地图.md'), '考点地图-clean.md')
  assert.equal(cleanMarkdownFileName('/tmp/foo-clean.md'), 'foo-clean.md')
  assert.equal(cleanMarkdownFileName('/tmp/a b.md'), 'a b-clean.md')
})

test('hasEmbeddedBase64Images detects data-image marks', () => {
  assert.equal(hasEmbeddedBase64Images('no images here'), false)
  assert.equal(
    hasEmbeddedBase64Images(`![x](data:image/png;base64,${TINY_PNG_B64})`),
    true,
  )
})

test('normalize extracts images and rewrites relative paths', async () => {
  const root = await tmpRoot()
  const input = path.join(root, 'raw.md')
  const outDir = path.join(root, '.ai-dev/inbox/sample')
  await writeFile(
    input,
    `# Title\n\nHello\n\n![diagram](data:image/png;base64,${TINY_PNG_B64})\n\nMore text\n`,
    'utf8',
  )

  const result = await normalizeMarkdownAssets(input, { outDir })
  assert.equal(result.ok, true)
  assert.equal(result.skipped, false)
  assert.equal(result.imageCount, 1)
  assert.equal(result.cleanFileName, 'raw-clean.md')

  const clean = await readFile(path.join(outDir, 'raw-clean.md'), 'utf8')
  assert.match(clean, /!\[diagram\]\(\.\/assets\/image_001\.png\)/)
  assert.doesNotMatch(clean, /data:image/)
  assert.equal(clean.includes('Hello'), true)

  const png = await readFile(path.join(outDir, 'assets/image_001.png'))
  assert.ok(png.length > 10)

  const manifest = JSON.parse(await readFile(path.join(outDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.imageCount, 1)
  assert.equal(manifest.cleanPath, 'raw-clean.md')
  assert.equal(manifest.originalPath, path.resolve(input))
  assert.ok(manifest.bytesAfter < manifest.bytesBefore)

  const readme = await readFile(path.join(outDir, 'README.md'), 'utf8')
  assert.match(readme, /raw-clean\.md/)
})

test('normalize is idempotent for same originalSha256', async () => {
  const root = await tmpRoot()
  const input = path.join(root, 'raw.md')
  const outDir = path.join(root, 'out')
  await writeFile(input, `![a](data:image/png;base64,${TINY_PNG_B64})\n`, 'utf8')

  const first = await normalizeMarkdownAssets(input, { outDir })
  const second = await normalizeMarkdownAssets(input, { outDir })
  assert.equal(first.skipped, false)
  assert.equal(second.skipped, true)
  assert.equal(second.originalSha256, first.originalSha256)
  assert.equal(path.basename(second.cleanPath), 'raw-clean.md')
})

test('markdown without base64 still writes *-clean.md', async () => {
  const root = await tmpRoot()
  const input = path.join(root, 'plain.md')
  const outDir = path.join(root, 'out')
  await writeFile(input, '# Only text\n\nNo images.\n', 'utf8')

  const result = await normalizeMarkdownAssets(input, { outDir })
  assert.equal(result.imageCount, 0)
  const clean = await readFile(path.join(outDir, 'plain-clean.md'), 'utf8')
  assert.equal(clean, '# Only text\n\nNo images.\n')
})

test('feature-dir output lands under analysis/sources', async () => {
  const root = await tmpRoot()
  const featureDir = path.join(root, '.ai-dev/features/REQ-1')
  await mkdir(featureDir, { recursive: true })
  const input = path.join(root, 'prd.md')
  await writeFile(input, `![x](data:image/png;base64,${TINY_PNG_B64})\n`, 'utf8')

  const result = await normalizeMarkdownAssets(input, {
    featureDir,
    sourceSlug: 'prd-1103',
  })
  assert.ok(result.outDir.endsWith(path.join('artifacts', 'analysis', 'sources', 'prd-1103')))
  await readFile(path.join(result.outDir, 'prd-clean.md'), 'utf8')
})

test('resolveOutDir rejects unsafe source-slug', () => {
  assert.throws(
    () => resolveOutDir({ featureDir: '/tmp/f', sourceSlug: '../x' }),
    (error) => error instanceof StoreError && error.code === 'INVALID_REQUEST',
  )
})

test('projectRoot sandbox rejects escaping outDir', async () => {
  const root = await tmpRoot()
  const input = path.join(root, 'a.md')
  await writeFile(input, 'hi\n', 'utf8')
  await assert.rejects(
    () =>
      normalizeMarkdownAssets(input, {
        outDir: path.join(root, '..', 'outside'),
        projectRoot: root,
      }),
    (error) => error instanceof StoreError && error.code === 'PATH_ESCAPE',
  )
})

test('fileNeedsNormalize flags embedded base64', async () => {
  const root = await tmpRoot()
  const dirty = path.join(root, 'dirty.md')
  const clean = path.join(root, 'ok.md')
  await writeFile(dirty, `![x](data:image/png;base64,${TINY_PNG_B64})\n`, 'utf8')
  await writeFile(clean, '# ok\n', 'utf8')
  assert.equal((await fileNeedsNormalize(dirty)).needs, true)
  assert.equal((await fileNeedsNormalize(clean)).needs, false)
})
