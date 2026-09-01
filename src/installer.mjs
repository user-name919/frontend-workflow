import { constants } from 'node:fs'
import { access, copyFile, lstat, mkdir, readdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export class ConflictError extends Error {
  constructor(paths) {
    super(`Existing files differ:\n${paths.map(file => `- ${file}`).join('\n')}`)
    this.name = 'ConflictError'
    this.paths = paths
  }
}

async function exists(target) {
  try {
    await access(target, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function listFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true })
  const files = []

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(current, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, absolute))
    } else if (entry.isFile()) {
      files.push(path.relative(root, absolute))
    } else {
      throw new Error(`Unsupported asset type: ${absolute}`)
    }
  }

  return files
}

function timestamp(date) {
  return date.toISOString().replaceAll('-', '').replaceAll(':', '').replace('.000', '')
}

async function buildPlan(sourceRoot, destinationRoot, reportRoot) {
  const files = await listFiles(sourceRoot)
  return files.map(relative => ({
    source: path.join(sourceRoot, relative),
    destination: path.join(destinationRoot, relative),
    reportPath: path.relative(reportRoot, path.join(destinationRoot, relative))
  }))
}

async function classifyPlan(plan) {
  const result = { copied: [], skipped: [], conflicts: [], blocked: [] }

  for (const item of plan) {
    if (!await exists(item.destination)) {
      result.copied.push(item)
      continue
    }

    const destinationStat = await lstat(item.destination)
    if (!destinationStat.isFile()) {
      result.blocked.push(item)
      continue
    }

    const [source, destination] = await Promise.all([
      readFile(item.source),
      readFile(item.destination)
    ])
    if (source.equals(destination)) result.skipped.push(item)
    else result.conflicts.push(item)
  }

  return result
}

async function applyPlan(plan, { force, backupRoot }) {
  const classified = await classifyPlan(plan)
  if (classified.blocked.length) {
    throw new ConflictError(classified.blocked.map(item => item.reportPath))
  }
  if (classified.conflicts.length && !force) {
    throw new ConflictError(classified.conflicts.map(item => item.reportPath))
  }

  const backups = []
  if (classified.conflicts.length) {
    for (const item of classified.conflicts) {
      const backup = path.join(backupRoot, item.reportPath)
      await mkdir(path.dirname(backup), { recursive: true })
      await copyFile(item.destination, backup)
      backups.push(item.reportPath)
    }
  }

  const toCopy = [...classified.copied, ...classified.conflicts]
  for (const item of toCopy) {
    await mkdir(path.dirname(item.destination), { recursive: true })
    await copyFile(item.source, item.destination)
  }

  return {
    copied: toCopy.map(item => item.reportPath),
    skipped: classified.skipped.map(item => item.reportPath),
    backups
  }
}

function parseArgs(argv) {
  const force = argv.includes('--force')
  const positional = argv.filter(arg => arg !== '--force')
  return { command: positional[0] || 'help', target: positional[1], force }
}

function helpText() {
  return `Frontend PRD-to-Code workflow

Requires Node.js 18 or later.

Commands:
  frontend-work-flow install            Install the shared Codex/Cursor skill
  frontend-work-flow setup [project]    Add workflow assets to a frontend project
  frontend-work-flow doctor             Check runtime and packaged assets
  frontend-work-flow help               Show this help

Options:
  --force  Back up and replace different destination files

GitHub usage:
  npx --yes github:bi554lecex/frontend-work-flow install
  npx --yes github:bi554lecex/frontend-work-flow setup .`
}

export async function runCli(argv, options = {}) {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  const packageRoot = options.packageRoot || path.resolve(moduleDir, '..')
  const homeDir = options.homeDir || os.homedir()
  const stdout = options.stdout || console.log
  const now = options.now || (() => new Date())
  const { command, target, force } = parseArgs(argv)

  if (command === 'help' || command === '--help' || command === '-h') {
    stdout(helpText())
    return { copied: [], skipped: [], backups: [] }
  }

  if (command === 'doctor') {
    const globalAssets = path.join(packageRoot, '.agents/skills/prd-to-code')
    const projectAssets = path.join(packageRoot, 'template')
    const globalOk = await exists(globalAssets)
    const projectOk = await exists(projectAssets)
    stdout(`Node.js ${process.versions.node}: OK`)
    stdout(`global skill assets: ${globalOk ? 'OK' : 'MISSING'}`)
    stdout(`project template assets: ${projectOk ? 'OK' : 'MISSING'}`)
    return { ok: globalOk && projectOk, copied: [], skipped: [], backups: [] }
  }

  let plan
  let reportRoot

  if (command === 'install') {
    const sourceRoot = path.join(packageRoot, '.agents/skills/prd-to-code')
    const destinationRoot = path.join(homeDir, '.agents/skills/prd-to-code')
    reportRoot = homeDir
    if (!await exists(sourceRoot)) throw new Error(`Packaged assets not found: ${sourceRoot}`)
    plan = await buildPlan(sourceRoot, destinationRoot, reportRoot)
  } else if (command === 'setup') {
    const templateRoot = path.join(packageRoot, 'template')
    const skillRoot = path.join(packageRoot, '.agents/skills/prd-to-code')
    reportRoot = path.resolve(target || process.cwd())
    if (!await exists(templateRoot)) throw new Error(`Packaged assets not found: ${templateRoot}`)
    if (!await exists(skillRoot)) throw new Error(`Packaged assets not found: ${skillRoot}`)
    plan = [
      ...await buildPlan(templateRoot, reportRoot, reportRoot),
      ...await buildPlan(
        skillRoot,
        path.join(reportRoot, '.agents/skills/prd-to-code'),
        reportRoot
      )
    ]
  } else {
    throw new Error(`Unknown command: ${command}\n\n${helpText()}`)
  }

  const backupRoot = path.join(
    reportRoot,
    '.frontend-work-flow-backups',
    timestamp(now())
  )
  const result = await applyPlan(plan, { force, backupRoot })
  stdout(`Copied ${result.copied.length}, skipped ${result.skipped.length}, backed up ${result.backups.length}.`)
  return result
}
