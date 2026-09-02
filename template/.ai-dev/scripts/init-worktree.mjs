#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process'
import { access, lstat, mkdir, readFile, readlink, realpath, symlink, writeFile } from 'node:fs/promises'
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
  return result.stdout.trim()
}

function assertInside(parent, target, label) {
  const relative = path.relative(parent, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must be inside ${parent}`)
  }
}

export async function createChangeWorktree(rawChangeDir, options = {}) {
  const changeDir = await realpath(path.resolve(rawChangeDir))
  const sourceRepository = await git(changeDir, 'rev-parse', '--show-toplevel')
  const changesRoot = path.join(sourceRepository, '.ai-dev', 'changes')
  assertInside(changesRoot, changeDir, 'Change workspace')

  const status = JSON.parse(await readFile(path.join(changeDir, 'status.json'), 'utf8'))
  if (!status.id) throw new Error('status.json: id is required')
  if (path.basename(changeDir) !== status.id) {
    throw new Error(`status.json: id must match workspace directory (${path.basename(changeDir)})`)
  }
  if (!status.approvals?.plan?.approvedBy || !status.approvals?.plan?.approvedAt) {
    throw new Error('status.json: plan approval is required before creating a Worktree')
  }

  const worktreePath = path.join(sourceRepository, '.ai-dev', 'worktrees', status.id)
  const projectLink = path.join(changeDir, 'project')
  const metadataPath = path.join(changeDir, 'worktree.json')
  const linkTarget = path.relative(changeDir, worktreePath)
  const worktreeExists = await exists(worktreePath)
  const linkExists = await exists(projectLink)

  if (worktreeExists && linkExists) {
    const [linkStat, existingTarget] = await Promise.all([
      lstat(projectLink),
      readlink(projectLink)
    ])
    if (!linkStat.isSymbolicLink() || existingTarget !== linkTarget) {
      throw new Error(`Workspace project link does not target ${worktreePath}`)
    }
    return { created: false, worktreePath }
  }
  if (worktreeExists || linkExists) {
    throw new Error('Partial Worktree state exists; inspect the workspace before retrying')
  }

  const relativeWorktree = path.relative(sourceRepository, worktreePath)
  try {
    await git(sourceRepository, 'check-ignore', '-q', '--', relativeWorktree)
  } catch {
    throw new Error(`${relativeWorktree} must be ignored before creating the Worktree`)
  }

  const baseBranch = await git(sourceRepository, 'branch', '--show-current')
  const baseCommit = await git(sourceRepository, 'rev-parse', 'HEAD')
  const branch = options.branch || `sdd/${status.id}`
  const now = options.now || (() => new Date())

  await mkdir(path.dirname(worktreePath), { recursive: true })
  await git(sourceRepository, 'worktree', 'add', worktreePath, '-b', branch)
  await symlink(linkTarget, projectLink, 'dir')

  const metadata = {
    sourceRepository,
    worktreePath,
    branch,
    baseBranch,
    baseCommit,
    createdAt: now().toISOString()
  }
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`)

  return { created: true, worktreePath }
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [, , rawChangeDir, branch] = process.argv
  if (!rawChangeDir) {
    console.error('Usage: node .ai-dev/scripts/init-worktree.mjs <change-dir> [branch]')
    process.exit(1)
  }

  try {
    const result = await createChangeWorktree(rawChangeDir, { branch })
    console.log(`${result.created ? 'Created' : 'Using'} Worktree: ${result.worktreePath}`)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
