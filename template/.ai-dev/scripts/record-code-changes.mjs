#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process'
import { access, lstat, mkdir, readFile, readlink, realpath, symlink, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

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
    if (error.code === 1) return true
    throw error
  }
}

async function newFilePatch(projectRoot, relative) {
  try {
    await execFile('git', ['diff', '--no-index', '--binary', '--', '/dev/null', relative], { cwd: projectRoot })
    return ''
  } catch (error) {
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

export async function recordCodeChanges(rawFeatureDir, rawPaths, options = {}) {
  if (!rawPaths?.length) throw new Error('At least one changed file path is required')
  const featureDir = await realpath(path.resolve(rawFeatureDir))
  const statusPath = path.join(featureDir, 'status.json')
  const status = JSON.parse(await readFile(statusPath, 'utf8'))
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
  const manifest = {
    projectRoot,
    branch: branch || null,
    baseCommit: status.project.baseCommit,
    recordedAt: now.toISOString(),
    files: manifestFiles
  }
  await Promise.all([
    writeFile(path.join(codingChangesDir, 'changed-files.json'), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(path.join(codingChangesDir, 'changes.patch'), patches.length ? `${patches.join('\n')}\n` : '')
  ])
  status.updatedAt = manifest.recordedAt
  await writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`)
  return manifest
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [, , featureDir, ...files] = process.argv
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
