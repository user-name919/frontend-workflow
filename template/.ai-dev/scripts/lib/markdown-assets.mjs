/**
 * 解决什么问题：PRD Markdown 常内嵌 data:image base64，整文件进上下文会爆 token，且模型不会当图看。
 * 通过什么方式解决：抽出图片到 assets/，重写为相对路径，写出 `<原名>-clean.md` + manifest；不复制原文 base64。
 * 触发时机：读含嵌入图的 MD 之前。
 * 被谁控制触发：normalize-markdown-assets.mjs；Cursor beforeReadFile 守卫只检测不抽图。
 */

import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { StoreError } from './workspace-store.mjs'

const EMBEDDED_IMAGE_RE =
  /!\[([^\]]*)\]\(\s*(data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+))\s*\)/g

function err(code, message) {
  return new StoreError(code, message)
}

export function hasEmbeddedBase64Images(text) {
  if (typeof text !== 'string' || !text) return false
  return /data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(text)
}

export function slugifySegment(text, fallback = 'doc') {
  const cleaned = String(text || '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
  return (cleaned.slice(0, 80) || fallback).toLowerCase()
}

/** 由原文路径得到 `<basename>-clean.md`（basename 已含 -clean 则不重复追加）。 */
export function cleanMarkdownFileName(inputPath) {
  const base = path.basename(String(inputPath || ''), path.extname(String(inputPath || ''))) || 'doc'
  const safe = base.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() || 'doc'
  const stem = /-clean$/i.test(safe) ? safe.slice(0, -6) : safe
  return `${stem}-clean.md`
}

function mimeToExt(mime) {
  const base = String(mime || 'png').toLowerCase().split('+')[0]
  if (base === 'jpeg') return 'jpg'
  if (['png', 'jpg', 'gif', 'webp', 'svg', 'bmp'].includes(base)) return base
  return 'bin'
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * 解析 CLI / 调用方选项，得到绝对 outDir。
 * --feature-dir + --source-slug → features/.../artifacts/analysis/sources/<slug>
 * 否则必须 --out-dir。
 */
export function resolveOutDir(options = {}) {
  const { outDir, featureDir, sourceSlug } = options
  if (featureDir) {
    if (!sourceSlug || String(sourceSlug).includes('..') || path.isAbsolute(sourceSlug)) {
      throw err('INVALID_REQUEST', 'feature-dir requires a safe --source-slug')
    }
    return path.resolve(featureDir, 'artifacts/analysis/sources', sourceSlug)
  }
  if (!outDir) throw err('INVALID_REQUEST', 'Provide --out-dir or --feature-dir with --source-slug')
  return path.resolve(outDir)
}

function assertPathInside(root, candidate, label) {
  const rel = path.relative(root, candidate)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw err('PATH_ESCAPE', `${label} escapes sandbox: ${candidate}`)
  }
}

/**
 * 将嵌入 base64 图抽到 outDir/assets，写 `<原名>-clean.md` / manifest.json / README.md。
 * 无嵌入图时：仍写 clean（原文拷贝）与 manifest（imageCount=0），方便统一后续路径。
 * 幂等：originalSha256 相同且 manifest 已存在则跳过写盘。
 */
export async function normalizeMarkdownAssets(inputPath, options = {}) {
  const absoluteInput = path.resolve(inputPath)
  try {
    await access(absoluteInput)
  } catch {
    throw err('MISSING_INPUT', `Input markdown not found: ${absoluteInput}`)
  }

  const outDir = resolveOutDir(options)
  const projectRoot = options.projectRoot ? path.resolve(options.projectRoot) : null
  if (projectRoot) {
    assertPathInside(projectRoot, outDir, 'outDir')
  }

  const cleanFileName = cleanMarkdownFileName(absoluteInput)
  const cleanRelative = cleanFileName
  const cleanPath = path.join(outDir, cleanFileName)

  const originalBytes = await readFile(absoluteInput)
  const originalText = originalBytes.toString('utf8')
  const originalSha256 = sha256Hex(originalBytes)
  const bytesBefore = originalBytes.length

  const manifestPath = path.join(outDir, 'manifest.json')
  try {
    const existing = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (
      existing.originalSha256 === originalSha256 &&
      existing.cleanPath === cleanRelative
    ) {
      return {
        ok: true,
        skipped: true,
        outDir,
        cleanPath: path.join(outDir, existing.cleanPath),
        cleanFileName: existing.cleanPath,
        manifestPath,
        imageCount: existing.imageCount || 0,
        bytesBefore: existing.bytesBefore ?? bytesBefore,
        bytesAfter: existing.bytesAfter ?? null,
        originalPath: absoluteInput,
        originalSha256,
      }
    }
  } catch {
    // no usable manifest
  }

  const assetsDir = path.join(outDir, 'assets')
  await mkdir(assetsDir, { recursive: true })

  const images = []
  let imageIndex = 0
  const cleanText = originalText.replace(EMBEDDED_IMAGE_RE, (full, alt, _dataUrl, mime, b64) => {
    imageIndex += 1
    const ext = mimeToExt(mime)
    const fileName = `image_${String(imageIndex).padStart(3, '0')}.${ext}`
    const compact = String(b64).replace(/\s+/g, '')
    let bytes
    try {
      bytes = Buffer.from(compact, 'base64')
    } catch {
      throw err('INVALID_BASE64', `Failed to decode embedded image #${imageIndex}`)
    }
    if (!bytes.length) throw err('INVALID_BASE64', `Empty embedded image #${imageIndex}`)
    images.push({ fileName, bytes, alt: alt || '', mime: `image/${mime}` })
    const label = alt || fileName
    return `![${label}](./assets/${fileName})`
  })

  for (const image of images) {
    await writeFile(path.join(assetsDir, image.fileName), image.bytes)
  }

  await writeFile(cleanPath, cleanText, 'utf8')
  const bytesAfter = Buffer.byteLength(cleanText, 'utf8')

  const manifest = {
    schemaVersion: 1,
    originalPath: absoluteInput,
    originalSha256,
    cleanPath: cleanRelative,
    assetsDir: images.length ? 'assets' : null,
    imageCount: images.length,
    images: images.map((image) => ({
      file: `assets/${image.fileName}`,
      mime: image.mime,
      bytes: image.bytes.length,
      alt: image.alt,
    })),
    bytesBefore,
    bytesAfter,
    createdAt: new Date().toISOString(),
    note: `Analyze ${cleanRelative} only. Do not fully read originalPath when it still embeds base64.`,
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const readme = [
    '# Normalized markdown source',
    '',
    'This folder was produced by `normalize-markdown-assets.mjs`.',
    '',
    `- Original file: \`${absoluteInput}\``,
    `- Read **\`${cleanRelative}\`** for text/tables.`,
    '- Read **`assets/*`** only when you need image content.',
    '- Do **not** fully read the original file if it still contains `data:image` base64.',
    '',
    'Delete this whole folder (or the parent feature under `.ai-dev/features/<id>/`) when the requirement is done.',
    '',
  ].join('\n')
  await writeFile(path.join(outDir, 'README.md'), readme, 'utf8')

  return {
    ok: true,
    skipped: false,
    outDir,
    cleanPath,
    cleanFileName,
    manifestPath,
    imageCount: images.length,
    bytesBefore,
    bytesAfter,
    originalPath: absoluteInput,
    originalSha256,
  }
}

/**
 * 快速检测文件是否含嵌入 base64 图（守卫用）。大文件只读前/后各 256KB 可能漏检中间；
 * 守卫默认读全文件但设体积上限，超限也视为需 normalize。
 */
export async function fileNeedsNormalize(filePath, options = {}) {
  const absolute = path.resolve(filePath)
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024
  let bytes
  try {
    bytes = await readFile(absolute)
  } catch {
    return { needs: false, reason: 'missing' }
  }
  if (bytes.length > maxBytes) {
    return { needs: true, reason: 'too_large', size: bytes.length }
  }
  const text = bytes.toString('utf8')
  if (hasEmbeddedBase64Images(text)) {
    return { needs: true, reason: 'embedded_base64', size: bytes.length }
  }
  return { needs: false, reason: 'clean', size: bytes.length }
}
