#!/usr/bin/env node

/**
 * 解决什么问题：实现某个任务时，执行方不能带着整份仓库和其它任务的闲聊上手。缺少裁剪过的 brief、允许文件和 before 快照，就会越权改文件或发明产品规则。
 * 通过什么方式解决：从 intake/delivery 抽出该 task 的需求、验收、spec/plan 摘录和依赖接口，写成 revisions/tasks/<id>/<attempt>/brief.md 与 request.json，并 capture 项目内容哈希到 before-files.json。
 * 触发时机：计划已批准、即将开始（或重试）某一个 taskId 之前。
 * 被谁控制触发：主 Agent 在派工或自己动手前跑本脚本；人可加 --attempt / --search。本脚本不改代码、不派 reviewer。
 */

import { createHash } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { traceCli } from './lib/monitor-events.mjs'
import { captureSnapshot } from './lib/snapshots.mjs'
import { readFeature, StoreError } from './lib/workspace-store.mjs'

const execFile = promisify(execFileCallback)

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

async function digestFile(root, relative) {
  if (!isNonEmptyString(relative) || path.isAbsolute(relative) || relative.split(path.sep).includes('..')) {
    // 快照路径必须是项目内相对路径，防止读到仓库外文件。
    throw new StoreError('PATH_ESCAPE', `Illegal path: ${relative}`)
  }
  try {
    const bytes = await readFile(path.join(root, relative))
    return { exists: true, sha256: sha256(bytes) }
  } catch {
    return { exists: false, sha256: null }
  }
}

async function listProjectFiles(projectRoot) {
  try {
    await execFile('git', ['rev-parse', '--is-inside-work-tree'], { cwd: projectRoot })
  } catch {
    return { files: [], note: 'project is not a git work tree; only allowed files were snapshotted' }
  }
  const tracked = (
    await execFile('git', ['ls-files', '-z'], { cwd: projectRoot, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
  ).stdout
    .split('\0')
    .filter(Boolean)
  const untracked = (
    await execFile('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
      cwd: projectRoot,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    })
  ).stdout
    .split('\0')
    .filter(Boolean)
  const files = [...new Set([...tracked, ...untracked])].filter((file) => !file.startsWith('.ai-dev/')).sort()
  return { files, note: null }
}

function excerptByIds(markdown, ids) {
  if (!markdown || !ids.length) return []
  const blocks = markdown.split(/\n(?=#{1,3}\s)/)
  return blocks
    .filter((block) => ids.some((id) => block.includes(id)))
    .map((block) => block.trim())
    .filter(Boolean)
}

function renderBrief({ task, requirements, acceptance, specExcerpts, planExcerpts, constraints, depInterfaces, searchRecords }) {
  const reqLines = requirements.map((req) => `- ${req.id}: ${req.statement || req.text || ''}`)
  const acLines = acceptance.map(
    (item) => `- ${item.id}: Given ${item.given}; When ${item.when}; Then ${item.then}`,
  )
  const depLines = depInterfaces.length
    ? depInterfaces.map((item) => `- ${item.taskId}: ${item.contract}`)
    : ['- none']
  const searchLines = searchRecords.length
    ? searchRecords.map(
        (item) =>
          `- query=${item.query}; method=${item.method}; paths=${(item.selectedPaths || []).join(', ')}; loc=${(item.sourceLocations || []).join(', ')}`,
      )
    : ['- none recorded']
  return [
    `# Task ${task.id}`,
    '',
    task.title ? `${task.title}` : '',
    '',
    '## Requirements',
    ...reqLines,
    '',
    '## Acceptance',
    ...acLines,
    '',
    '## Spec excerpts',
    specExcerpts.length ? specExcerpts.join('\n\n') : '- none',
    '',
    '## Plan excerpts',
    planExcerpts.length ? planExcerpts.join('\n\n') : '- none',
    '',
    '## Global constraints',
    ...constraints.map((line) => `- ${line}`),
    '',
    '## Dependency interfaces',
    ...depLines,
    '',
    '## Allowed files',
    ...(task.files || []).map((file) => `- ${file.operation}: ${file.path}`),
    '',
    '## Verify',
    ...(task.verify || []).map((cmd) => `- ${cmd.command} ${(cmd.args || []).join(' ')}`.trim()),
    '',
    '## Search records',
    ...searchLines,
    '',
    'Do not include other tasks’ debug chats. Do not invent product rules.',
    '',
  ]
    .filter((line, index, all) => !(line === '' && all[index - 1] === ''))
    .join('\n')
}

/**
 * 为单个 taskId 生成可交给执行方的 brief / request / before 快照，不修改业务代码。
 * 任务必须已在 delivery.json；attemptId 默认按已有 attempts 递增。searchRecords 缺 query/method 会 INVALID_REQUEST。
 * 只摘与该任务相关的需求和依赖接口，并写明只许改 allowedFiles、不得派审、不得发明产品决策。
 */
export async function prepareTask(featureDir, taskId, options = {}) {
  const resolved = path.resolve(featureDir)
  if (!isNonEmptyString(taskId)) throw new StoreError('INVALID_REQUEST', 'taskId is required')

  const status = await readFeature(resolved)
  const projectRoot = status.project?.root
  // 没有真实项目根就无法做 before 哈希，不能生成可执行 brief。
  if (!isNonEmptyString(projectRoot)) throw new StoreError('MISSING_PROJECT', 'status.project.root is required')

  const intake = await readJson(path.join(resolved, 'artifacts/analysis/intake.json'))
  const delivery = await readJson(path.join(resolved, 'artifacts/design/delivery.json'))
  const task = (delivery.tasks || []).find((item) => item.id === taskId)
  // 未知 taskId 直接失败，避免为计划外工作生成 brief。
  if (!task) throw new StoreError('UNKNOWN_TASK', `Task ${taskId} is not in delivery.json`)

  const attemptCount = Number(status.runtime?.attempts?.[taskId]?.count || 0)
  const attemptId = options.attemptId || `A${attemptCount + 1}`
  const searchRecords = Array.isArray(options.searchRecords) ? options.searchRecords : []
  for (const record of searchRecords) {
    if (!isNonEmptyString(record.query) || !isNonEmptyString(record.method)) {
      throw new StoreError('INVALID_REQUEST', 'searchRecords need query and method')
    }
  }

  const requirements = (intake.requirements || []).filter((req) => (task.requirementIds || []).includes(req.id))
  const acceptance = (delivery.acceptance || []).filter((item) => (task.acceptanceIds || []).includes(item.id))
  const specText = await readFile(path.join(resolved, 'artifacts/design/frontend-spec.md'), 'utf8').catch(() => '')
  const planText = await readFile(path.join(resolved, 'artifacts/design/implementation-plan.md'), 'utf8').catch(() => '')
  const ids = [...(task.requirementIds || []), ...(task.acceptanceIds || []), task.id]
  const specExcerpts = excerptByIds(specText, ids)
  const planExcerpts = excerptByIds(planText, ids)

  const depInterfaces = []
  for (const dep of task.dependsOn || []) {
    const prior = status.runtime?.taskResults?.[dep]
    for (const item of prior?.exportedInterfaces || []) {
      depInterfaces.push({ taskId: dep, contract: item.contract || item, source: 'taskResult' })
    }
  }

  const allowed = {}
  for (const file of task.files || []) {
    allowed[file.path] = await digestFile(projectRoot, file.path)
  }
  const listing = await listProjectFiles(projectRoot)
  const others = {}
  for (const file of listing.files) {
    if (allowed[file]) continue
    others[file] = await digestFile(projectRoot, file)
  }

  const snapshot = await captureSnapshot(resolved, {
    gate: 'task',
    taskId,
    inputs: (task.files || []).map((file) => ({ space: 'project', path: file.path, freshness: 'live' })),
    includeProjectDigest: true,
  })

  const request = {
    projectRoot,
    featureId: status.id,
    taskId,
    attemptId,
    approvedPlanSnapshotId: status.approvals?.plan?.snapshotId || null,
    beforeSnapshotId: snapshot.id,
    allowedFiles: task.files || [],
    commands: task.verify || [],
    searchRecords,
    exportedInterfacesFromDeps: depInterfaces,
  }

  if (
    !request.projectRoot ||
    !request.taskId ||
    !request.attemptId ||
    !request.beforeSnapshotId ||
    !Array.isArray(request.allowedFiles)
  ) {
    throw new StoreError('INVALID_REQUEST', 'Task request is incomplete')
  }

  const dir = path.join(resolved, 'revisions/tasks', taskId, attemptId)
  await mkdir(dir, { recursive: true })
  const requestPath = path.join(dir, 'request.json')
  const briefPath = path.join(dir, 'brief.md')
  const beforePath = path.join(dir, 'before-files.json')
  const brief = renderBrief({
    task,
    requirements,
    acceptance,
    specExcerpts,
    planExcerpts,
    constraints: [
      'Only edit allowedFiles',
      'Do not dispatch a reviewer',
      'Do not invent product decisions',
      'Keep unrelated dirty files unchanged',
    ],
    depInterfaces,
    searchRecords,
  })

  await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`)
  await writeFile(briefPath, `${brief}\n`)
  await writeFile(
    beforePath,
    `${JSON.stringify({ allowed, others, listingNote: listing.note, capturedAt: new Date().toISOString() }, null, 2)}\n`,
  )

  return {
    briefPath: path.relative(resolved, briefPath),
    requestPath: path.relative(resolved, requestPath),
    beforeSnapshotId: snapshot.id,
    attemptId,
    beforeFilesPath: path.relative(resolved, beforePath),
  }
}

async function main(argv) {
  const [featureDir, taskId, ...rest] = argv
  // CLI：一次只准备一个 taskId；--attempt 指定轮次，--search 追加检索记录。
  if (!featureDir || !taskId) {
    throw new StoreError('INVALID_REQUEST', 'Usage: node prepare-task.mjs <feature-dir> <taskId> [--attempt A1]')
  }
  let attemptId
  const searchRecords = []
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === '--attempt') {
      attemptId = rest[++index]
    } else if (rest[index] === '--search') {
      searchRecords.push(JSON.parse(rest[++index]))
    } else {
      throw new StoreError('INVALID_REQUEST', `Unknown argument: ${rest[index]}`)
    }
  }
  const result = await prepareTask(featureDir, taskId, { attemptId, searchRecords })
  console.log(JSON.stringify({ ok: true, ...result }, null, 2))
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  traceCli('prepare-task.mjs')
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error.code || 'ERROR', message: error.message }, null, 2))
    process.exitCode = 1
  }
}
