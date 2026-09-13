/**
 * 解决什么问题：共享 skills 和项目 template 需要可重复装到 ~/.agents/skills 或业务仓库。目标已存在且内容不同时，默认覆盖会毁掉用户改过的文件；目录或软链也不能当普通文件覆盖。
 * 通过什么方式解决：install 把包内 .agents/skills 拷到用户家目录；setup 把 template 与 skills 一并拷进项目。classifyPlan 区分 copied / skipped / conflicts / blocked。无 --force 遇内容冲突抛 ConflictError 且不写盘；--force 先备份到 .frontend-work-flow-backups/<时间戳> 再覆盖。doctor 只体检不写盘。
 * 触发时机：首次安装 skills、把工作流落到某个前端项目、或检查本机 Node 与打包资源是否完整时。
 * 被谁控制触发：人通过 bin/frontend-work-flow.mjs（npx/CLI）下令；测试或其它脚本也可注入 packageRoot / homeDir 后直接调 runCli。
 */

import { constants } from 'node:fs'
import { access, copyFile, lstat, mkdir, readdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 目标已是非普通文件，或内容与源不同且未加 --force 时抛出。
 * 抛出即表示本次未写盘；bin 入口会据此提示用户复查或改用 --force。
 */
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

async function inspectSkills(skillsRoot) {
  if (!await exists(skillsRoot)) {
    return { count: 0, issues: ['skill root: MISSING'] }
  }

  const entries = await readdir(skillsRoot, { withFileTypes: true })
  const directories = entries
    .filter(entry => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
  const issues = entries
    .filter(entry => !entry.isDirectory())
    .map(entry => `${entry.name}: expected a skill directory`)

  for (const entry of directories) {
    const skillFile = path.join(skillsRoot, entry.name, 'SKILL.md')
    if (!await exists(skillFile)) issues.push(`${entry.name}: MISSING SKILL.md`)
  }

  if (!directories.length) issues.push('skill root: no skills found')
  return { count: directories.length, issues }
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
    // 目录/软链等非普通文件单独记为 blocked，--force 也不能当文件覆盖。
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
  // 内容冲突必须显式 --force；否则整次安装失败，避免只覆盖一部分。
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
  frontend-work-flow install            Install all shared Codex/Cursor skills
  frontend-work-flow setup [project]    Add workflow assets to a frontend project
  frontend-work-flow doctor             Check runtime and packaged assets
  frontend-work-flow help               Show this help

Options:
  --force  Back up and replace different destination files

GitHub usage:
  npx --yes github:bi554lecex/frontend-work-flow install
  npx --yes github:bi554lecex/frontend-work-flow setup .`
}

/**
 * CLI 总入口：解析 install / setup / doctor / help，组装拷贝计划并套用冲突策略。
 * options 可注入 packageRoot、homeDir、stdout、now，供测试替身，不影响命令语义。
 * 未知命令抛错并附帮助文本；doctor 的返回值带 ok，供 bin 映射退出码。
 */
export async function runCli(argv, options = {}) {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  const packageRoot = options.packageRoot || path.resolve(moduleDir, '..')
  const homeDir = options.homeDir || os.homedir()
  const stdout = options.stdout || console.log
  const now = options.now || (() => new Date())
  const { command, target, force } = parseArgs(argv)

  // help：只打印用法，不访问磁盘、不改任何目标。
  if (command === 'help' || command === '--help' || command === '-h') {
    stdout(helpText())
    return { copied: [], skipped: [], backups: [] }
  }

  // doctor：检查 Node、打包 skills 目录和 template，只报告不写盘。
  if (command === 'doctor') {
    const skillsRoot = path.join(packageRoot, '.agents/skills')
    const projectAssets = path.join(packageRoot, 'template')
    const skills = await inspectSkills(skillsRoot)
    const projectOk = await exists(projectAssets)
    stdout(`Node.js ${process.versions.node}: OK`)
    stdout(`packaged skills: ${skills.count} ${skills.issues.length ? 'INVALID' : 'OK'}`)
    for (const issue of skills.issues) stdout(`- ${issue}`)
    stdout(`project template assets: ${projectOk ? 'OK' : 'MISSING'}`)
    return { ok: !skills.issues.length && projectOk, copied: [], skipped: [], backups: [] }
  }

  let plan
  let reportRoot

  // install：把包内 skills 装到 ~/.agents/skills，供本机 Codex/Cursor 共用。
  if (command === 'install') {
    const sourceRoot = path.join(packageRoot, '.agents/skills')
    const destinationRoot = path.join(homeDir, '.agents/skills')
    reportRoot = homeDir
    if (!await exists(sourceRoot)) throw new Error(`Packaged assets not found: ${sourceRoot}`)
    plan = await buildPlan(sourceRoot, destinationRoot, reportRoot)
  // setup：把 template 落到项目根，并把 skills 拷进项目 .agents/skills。
  } else if (command === 'setup') {
    const templateRoot = path.join(packageRoot, 'template')
    const skillRoot = path.join(packageRoot, '.agents/skills')
    reportRoot = path.resolve(target || process.cwd())
    if (!await exists(templateRoot)) throw new Error(`Packaged assets not found: ${templateRoot}`)
    if (!await exists(skillRoot)) throw new Error(`Packaged assets not found: ${skillRoot}`)
    plan = [
      ...await buildPlan(templateRoot, reportRoot, reportRoot),
      ...await buildPlan(
        skillRoot,
        path.join(reportRoot, '.agents/skills'),
        reportRoot
      )
    ]
  } else {
    // 未识别命令直接失败并附帮助，避免误当成 install/setup 写盘。
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
