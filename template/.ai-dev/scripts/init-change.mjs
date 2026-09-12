#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access, cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
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

async function gitStatus(cwd) {
  const result = await execFile('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd })
  return result.stdout.trimEnd()
}

async function writeCodeBaseline(featureDir, projectRoot, initialChanges, baseCommit) {
  const { createHash } = await import('node:crypto')
  const entries = []
  for (const change of initialChanges) {
    const absolute = path.join(projectRoot, change.path)
    let digest = null
    let missing = false
    try {
      const bytes = await readFile(absolute)
      digest = createHash('sha256').update(bytes).digest('hex')
    } catch {
      missing = true
    }
    entries.push({
      path: change.path,
      status: change.status,
      sha256: digest,
      missing,
    })
  }
  const baseline = {
    createdAt: new Date().toISOString(),
    baseCommit,
    note: 'Content digests of paths dirty/untracked at init. preExisting cannot precisely split later co-owned edits.',
    files: entries,
  }
  await writeFile(
    path.join(featureDir, 'revisions/code-baseline.json'),
    `${JSON.stringify(baseline, null, 2)}\n`,
  )
}

function datePart(date) {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((value, index) => index === 0 ? String(value) : String(value).padStart(2, '0'))
    .join('')
}

function normalizeRequirementId(rawId) {
  const normalized = rawId.trim().toUpperCase()
  if (!/^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(normalized)) {
    throw new Error('Requirement id must contain only letters, numbers, dots, underscores, or hyphens')
  }
  return normalized
}

function parseInitialChanges(output) {
  if (!output) return []
  return output.split('\n').map(line => ({
    status: line.slice(0, 2).trim(),
    path: line.slice(3)
  }))
}

export async function createFeatureWorkspace(rawProjectRoot, options) {
  if (!options?.title?.trim()) throw new Error('Requirement title is required')
  const projectRoot = await realpath(await git(path.resolve(rawProjectRoot), 'rev-parse', '--show-toplevel'))
  const aiDir = path.join(projectRoot, '.ai-dev')
  const templateDir = path.join(aiDir, 'templates')
  if (!await exists(templateDir)) throw new Error(`Template directory not found: ${templateDir}`)

  const now = options.now || new Date()
  const id = options.id
    ? normalizeRequirementId(options.id)
    : `REQ-${datePart(now)}-${(options.randomSuffix || randomBytes(3).toString('hex')).toUpperCase()}`
  const idSource = options.id ? (options.idSource || 'user') : 'generated'
  if (!['document', 'user', 'generated'].includes(idSource)) {
    throw new Error('id-source must be document, user, or generated')
  }

  const featureDir = path.join(aiDir, 'features', id)
  if (await exists(featureDir)) throw new Error(`Feature already exists: ${featureDir}`)

  const [branch, baseCommit, initialStatus] = await Promise.all([
    git(projectRoot, 'branch', '--show-current'),
    git(projectRoot, 'rev-parse', 'HEAD'),
    gitStatus(projectRoot)
  ])

  await mkdir(path.dirname(featureDir), { recursive: true })
  await cp(templateDir, featureDir, { recursive: true })
  await Promise.all([
    mkdir(path.join(featureDir, 'artifacts/coding-changes/coding'), { recursive: true }),
    mkdir(path.join(featureDir, 'revisions'), { recursive: true }),
    writeFile(path.join(featureDir, 'artifacts/coding-changes/changes.patch'), '')
  ])

  const statusPath = path.join(featureDir, 'status.json')
  const status = JSON.parse(await readFile(statusPath, 'utf8'))
  const timestamp = now.toISOString()
  Object.assign(status, {
    id,
    title: options.title.trim(),
    idSource,
    externalIds: [],
    schemaVersion: 2,
    createdAt: timestamp,
    updatedAt: timestamp,
    project: {
      root: projectRoot,
      branch: branch || null,
      baseCommit,
      initialChanges: parseInitialChanges(initialStatus)
    },
    control: status.control || {
      version: 0,
      nextEvent: 1,
      events: [],
      blocked: null,
      artifactStatus: null
    },
    policy: status.policy || {
      mode: 'strict',
      delegation: null,
      maxFixRounds: 3
    },
    reviews: status.reviews || {},
    runtime: status.runtime || {
      activeTaskId: null,
      attempts: {},
      taskResults: {}
    }
  })
  await writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`)
  await writeCodeBaseline(
    featureDir,
    projectRoot,
    status.project.initialChanges,
    baseCommit,
  )
  return featureDir
}

function parseArgs(args) {
  const values = {}
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (!['--title', '--id', '--id-source'].includes(flag) || value === undefined) {
      throw new Error('Usage: node .ai-dev/scripts/init-change.mjs --title <name> [--id <requirement-id>] [--id-source document|user]')
    }
    values[flag.slice(2)] = value
  }
  if (!values.title) {
    throw new Error('Usage: node .ai-dev/scripts/init-change.mjs --title <name> [--id <requirement-id>] [--id-source document|user]')
  }
  return values
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2))
    const featureDir = await createFeatureWorkspace(process.cwd(), {
      title: options.title,
      id: options.id,
      idSource: options['id-source']
    })
    console.log(path.relative(process.cwd(), featureDir))
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
