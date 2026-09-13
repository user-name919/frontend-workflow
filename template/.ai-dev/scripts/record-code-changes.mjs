#!/usr/bin/env node

/**
 * 解决什么问题：实现完成后需要可审查的改动清单、指向真实文件的链接和可保存的 patch。不能自动 commit / merge / push。路径若逃出项目或走进 .ai-dev，会把工作流账本和业务代码搅在一起。
 * 通过什么方式解决：对照 status.project.baseCommit 分类 added/modified/deleted，在 coding/ 建软链，写 changed-files.json 与 changes.patch。未声明的脏路径只进 undeclaredChanges 警告，不静默丢弃。mutateFeature 只记 coding.record 事件。
 * 触发时机：某个已批准任务改完业务代码、准备进入任务结果或验证之前。
 * 被谁控制触发：主 Agent 按规则跑本脚本并列出文件；人也可补跑。本脚本从不 git commit。
 */

import { execFile as execFileCallback } from 'node:child_process'
import { access, lstat, mkdir, readFile, readlink, realpath, symlink, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { mutateFeature, readFeature } from './lib/workspace-store.mjs'

const execFile = promisify(execFileCallback)

async function exists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

async function git(cwd, ...args) {
  const result = await execFile('git', args, { cwd })
  return result.stdout.trimEnd()
}

function projectPath(projectRoot, rawPath) {
  if (!rawPath || path.isAbsolute(rawPath)) throw new Error(`${rawPath || 'Empty path'} must stay inside the project`)
  const normalized = path.normalize(rawPath)
  const absolute = path.resolve(projectRoot, normalized)
  const relative = path.relative(projectRoot, absolute)
  // 业务改动必须落在仓库内且不能写进 .ai-dev，避免把账本路径当实现文件。
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative === '.ai-dev' || relative.startsWith(`.ai-dev${path.sep}`)) {
    throw new Error(`${rawPath} must stay inside the project and outside .ai-dev`)
  }
  return { absolute, relative: relative.split(path.sep).join('/') }
}

async function existedAtBase(projectRoot, baseCommit, relative) {
  try {
    await execFile('git', ['cat-file', '-e', `${baseCommit}:${relative}`], { cwd: projectRoot })
    return true
  } catch {
    return false
  }
}

async function differsFromBase(projectRoot, baseCommit, relative) {
  try {
    await execFile('git', ['diff', '--quiet', baseCommit, '--', relative], { cwd: projectRoot })
    return false
  } catch (error) {
    // git diff --quiet：退出码 1 表示相对基线有差异，不是命令失败。
    if (error.code === 1) return true
    throw error
  }
}

async function newFilePatch(projectRoot, relative) {
  try {
    await execFile('git', ['diff', '--no-index', '--binary', '--', '/dev/null', relative], { cwd: projectRoot })
    return ''
  } catch (error) {
    // --no-index 对新文件同样用退出码 1 带回 patch 正文。
    if (error.code === 1) return error.stdout.trimEnd()
    throw error
  }
}

async function ensureCodeLink(codingRoot, projectRoot, file) {
  const linkPath = path.join(codingRoot, file.relative)
  const linkRelative = `coding/${file.relative}`
  if (!file.currentExists) {
    try {
      const current = await lstat(linkPath)
      if (!current.isSymbolicLink()) throw new Error(`${linkRelative} exists and is not a symbolic link`)
      await unlink(linkPath)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    return null
  }

  await mkdir(path.dirname(linkPath), { recursive: true })
  const target = path.relative(path.dirname(linkPath), file.absolute)
  try {
    const current = await lstat(linkPath)
    if (!current.isSymbolicLink() || await readlink(linkPath) !== target) {
      throw new Error(`${linkRelative} already exists with a different target`)
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await symlink(target, linkPath)
  }
  return linkRelative
}

/**
 * 把声明过的项目内文件做成清单、软链和相对 baseCommit 的 patch，并写入 coding.record。
 * 与 base 无差异的路径会被跳过；init 时已脏的路径标 preExisting，便于 final 区分历史改动。
 * 不创建 git commit。未列入参数但工作区已脏的路径只警告，避免 final 漏收。
 */
export async function recordCodeChanges(rawFeatureDir, rawPaths, options = {}) {
  if (!rawPaths?.length) throw new Error('At least one changed file path is required')
  const featureDir = await realpath(path.resolve(rawFeatureDir))
  const status = await readFeature(featureDir)
  const expectedVersion = Number.isInteger(options.expectedVersion)
    ? options.expectedVersion
    : status.control.version
  const projectRoot = await realpath(status.project?.root)
  const gitRoot = await realpath(await git(projectRoot, 'rev-parse', '--show-toplevel'))
  if (projectRoot !== gitRoot) throw new Error('status.json project root does not match the Git repository')

  const uniquePaths = [...new Set(rawPaths)].map(rawPath => projectPath(projectRoot, rawPath))
  const initialPaths = new Set((status.project.initialChanges || []).map(change => change.path))
  const files = []
  for (const file of uniquePaths) {
    const baseExists = await existedAtBase(projectRoot, status.project.baseCommit, file.relative)
    let currentExists = await exists(file.absolute)
    if (currentExists && !(await lstat(file.absolute)).isFile()) {
      throw new Error(`${file.relative} must be a file`)
    }
    const changed = baseExists
      ? (!currentExists || await differsFromBase(projectRoot, status.project.baseCommit, file.relative))
      : currentExists
    if (!changed) continue
    files.push({
      ...file,
      currentExists,
      status: !baseExists ? 'added' : currentExists ? 'modified' : 'deleted',
      preExisting: initialPaths.has(file.relative)
    })
  }
  files.sort((left, right) => left.relative.localeCompare(right.relative))

  const codingChangesDir = path.join(featureDir, 'artifacts/coding-changes')
  const codingRoot = path.join(codingChangesDir, 'coding')
  const manifestFiles = []
  for (const file of files) {
    manifestFiles.push({
      path: file.relative,
      status: file.status,
      preExisting: file.preExisting,
      link: await ensureCodeLink(codingRoot, projectRoot, file)
    })
  }

  const tracked = files.filter(file => file.status !== 'added').map(file => file.relative)
  const patches = []
  if (tracked.length) {
    const trackedPatch = await git(projectRoot, 'diff', '--binary', '--no-ext-diff', status.project.baseCommit, '--', ...tracked)
    if (trackedPatch) patches.push(trackedPatch)
  }
  for (const file of files.filter(file => file.status === 'added')) {
    const patch = await newFilePatch(projectRoot, file.relative)
    if (patch) patches.push(patch)
  }

  const now = options.now || new Date()
  const branch = await git(projectRoot, 'branch', '--show-current')

  // Detect dirty paths vs base that were not declared in rawPaths (final must not silently drop them).
  const declared = new Set(uniquePaths.map((file) => file.relative))
  const porcelain = await git(projectRoot, 'status', '--porcelain=v1', '--untracked-files=all')
  const undeclaredChanges = []
  for (const line of porcelain.split('\n').filter(Boolean)) {
    const relative = line.slice(3).split(path.sep).join('/')
    if (!relative || relative.startsWith('.ai-dev/') || declared.has(relative)) continue
    if (initialPaths.has(relative)) continue
    undeclaredChanges.push(relative)
  }

  const manifest = {
    projectRoot,
    branch: branch || null,
    baseCommit: status.project.baseCommit,
    recordedAt: now.toISOString(),
    files: manifestFiles,
    undeclaredChanges,
    warnings: undeclaredChanges.length
      ? ['Undeclared dirty paths detected; include them in record-code-changes or confirm they are out of scope for final']
      : [],
  }
  await Promise.all([
    writeFile(path.join(codingChangesDir, 'changed-files.json'), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(path.join(codingChangesDir, 'changes.patch'), patches.length ? `${patches.join('\n')}\n` : '')
  ])

  await mutateFeature(
    featureDir,
    {
      expectedVersion,
      event: {
        type: 'coding.record',
        actor: options.actor || 'system',
        data: { fileCount: manifest.files.length },
      },
    },
    () => {},
  )
  return manifest
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [, , featureDir, ...files] = process.argv
  // CLI：必须显式列出要入账的相对路径，防止把整个工作区脏文件默认收进去。
  if (!featureDir || !files.length) {
    console.error('Usage: node .ai-dev/scripts/record-code-changes.mjs <feature-dir> <file...>')
    process.exit(1)
  }
  try {
    const manifest = await recordCodeChanges(featureDir, files)
    console.log(`Recorded ${manifest.files.length} changed file(s)`)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
