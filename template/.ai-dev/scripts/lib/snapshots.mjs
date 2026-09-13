/**
 * 解决什么问题：审核/批准必须钉住当时输入字节，不能靠 mtime。
 * 通过什么方式解决：对输入文件和可选项目 digest 算 SHA-256，落不可变 snap-*.json；校验时 live 必须一致，baseline 只作对照。
 * 触发时机：批准、建审核包、验收审核、跑验证。
 * 被谁控制触发：workflow-state / review-package / reviews / verification。
 */

import { createHash, randomBytes } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { access, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { readFeature, StoreError } from './workspace-store.mjs'

const GATE_INPUTS = {
  scope: [
    'artifacts/analysis/intake.json',
    'artifacts/analysis/scope.md',
    'artifacts/analysis/source-index.md',
    'artifacts/analysis/evidence.md',
    'artifacts/analysis/open-questions.md',
  ],
  spec: [
    'artifacts/analysis/intake.json',
    'artifacts/design/delivery.json',
    'artifacts/design/frontend-spec.md',
    'artifacts/design/acceptance.md',
  ],
  plan: [
    'artifacts/analysis/intake.json',
    'artifacts/design/delivery.json',
    'artifacts/design/implementation-plan.md',
    'artifacts/design/tasks.md',
    'artifacts/design/traceability.md',
  ],
  final: [
    'artifacts/analysis/intake.json',
    'artifacts/design/delivery.json',
    'artifacts/coding-changes/changed-files.json',
    'artifacts/coding-changes/changes.patch',
    'artifacts/verification/verification.md',
  ],
}

const execFile = promisify(execFileCallback)

function sha256Bytes(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function err(code, message) {
  return new StoreError(code, message)
}

async function resolveInputPath(featureDir, projectRoot, input) {
  const { space, path: relative } = input
  if (!relative || path.isAbsolute(relative) || relative.split(path.sep).includes('..')) {
    throw err('PATH_ESCAPE', `Snapshot input path escapes sandbox: ${relative}`)
  }

  const root = space === 'project' ? projectRoot : featureDir
  if (!root) throw err('MISSING_PROJECT', 'project root required for project-space inputs')
  const absolute = path.resolve(root, relative)
  const rel = path.relative(root, absolute)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw err('PATH_ESCAPE', `Snapshot input resolves outside ${space}: ${relative}`)
  }
  if (space === 'project' && (rel === '.ai-dev' || rel.startsWith(`.ai-dev${path.sep}`))) {
    throw err('PATH_ESCAPE', `Project snapshot inputs must exclude .ai-dev: ${relative}`)
  }

  try {
    await access(absolute)
    const real = await realpath(absolute)
    const realRoot = await realpath(root)
    const realRel = path.relative(realRoot, real)
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
      throw err('PATH_ESCAPE', `Snapshot input escapes via symlink: ${relative}`)
    }
    const bytes = await readFile(real)
    return { exists: true, sha256: sha256Bytes(bytes), absolute: real }
  } catch (error) {
    if (error instanceof StoreError) throw error
    if (error.code === 'ENOENT') {
      return { exists: false, sha256: null, absolute }
    }
    throw err('READ_FAILED', `Cannot read snapshot input ${relative}: ${error.message}`)
  }
}

async function git(cwd, ...args) {
  const result = await execFile('git', args, { cwd, maxBuffer: 20 * 1024 * 1024, encoding: 'buffer' })
  return result.stdout
}

/**
 * 项目侧 digest：HEAD + tracked/staged binary diff + 非忽略未跟踪文件哈希。
 * 排除 .ai-dev，不把文件原文嵌进返回值。非 git 仓库返回 null。
 */
export async function computeProjectDigest(projectRoot) {
  if (!projectRoot) return null
  try {
    await execFile('git', ['rev-parse', '--is-inside-work-tree'], { cwd: projectRoot })
  } catch {
    return null
  }

  const head = (await git(projectRoot, 'rev-parse', 'HEAD')).toString('utf8').trim()
  const trackedDiff = await git(projectRoot, 'diff', '--binary', '--no-ext-diff', 'HEAD')
  const stagedDiff = await git(projectRoot, 'diff', '--binary', '--cached', '--no-ext-diff')

  const untrackedList = (
    await execFile('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
      cwd: projectRoot,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    })
  ).stdout
  const untracked = untrackedList.split('\0').filter(Boolean).filter((file) => !file.startsWith('.ai-dev/'))
  const untrackedHashes = []
  for (const file of untracked.sort()) {
    try {
      const bytes = await readFile(path.join(projectRoot, file))
      untrackedHashes.push(`${file}:${sha256Bytes(bytes)}`)
    } catch (error) {
      throw err('READ_FAILED', `Cannot digest untracked file ${file}: ${error.message}`)
    }
  }

  const material = [
    `head:${head}`,
    `tracked:${sha256Bytes(trackedDiff)}`,
    `staged:${sha256Bytes(stagedDiff)}`,
    `untracked:${sha256Bytes(Buffer.from(untrackedHashes.join('\n'), 'utf8'))}`,
  ].join('\n')

  return {
    algorithm: 'sha256',
    digest: sha256Bytes(Buffer.from(material, 'utf8')),
    head,
    untrackedCount: untracked.length,
  }
}

/**
 * 按闸列出默认 feature 输入。plan 上的项目源文件标 baseline，实现后改代码不因此判旧。
 * 其余默认 live，必须与当前字节一致。
 */
export function defaultInputsForGate(gate, options = {}) {
  const required = GATE_INPUTS[gate] || []
  const inputs = required.map((pathName) => ({
    space: 'feature',
    path: pathName,
    freshness: 'live',
  }))

  // Plan: located source files are baseline evidence (implementation may change them later).
  for (const file of options.projectFiles || []) {
    inputs.push({
      space: 'project',
      path: file.path,
      freshness: gate === 'plan' ? 'baseline' : 'live',
    })
  }

  const seen = new Set()
  return inputs
    .filter((item) => {
      const key = `${item.space}:${item.path}:${item.freshness || 'live'}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => `${a.space}:${a.path}`.localeCompare(`${b.space}:${b.path}`))
}

/**
 * 按输入抓字节 SHA-256，wx 写入 revisions/snapshots，同 id 不覆盖。
 * final、带 taskId、或含 live 项目输入时强制 projectDigest，算不出则失败。
 */
export async function captureSnapshot(featureDir, options = {}) {
  const resolved = path.resolve(featureDir)
  const { gate, taskId = null } = options
  if (!gate) throw err('INVALID_REQUEST', 'gate is required')

  const status = await readFeature(resolved)
  const projectRoot = status.project?.root
  const inputs = (options.inputs?.length ? options.inputs : defaultInputsForGate(gate)).map((item) => ({
    space: item.space || 'feature',
    path: item.path,
    freshness: item.freshness || 'live',
  }))

  const captured = []
  for (const input of inputs) {
    const resolvedInput = await resolveInputPath(resolved, projectRoot, input)
    captured.push({
      space: input.space,
      path: input.path,
      sha256: resolvedInput.sha256,
      exists: resolvedInput.exists,
      freshness: input.freshness,
    })
  }

  const needsProjectDigest =
    options.includeProjectDigest === true ||
    gate === 'final' ||
    Boolean(taskId) ||
    inputs.some((item) => item.space === 'project' && item.freshness === 'live')

  let projectDigest = null
  if (needsProjectDigest) {
    projectDigest = await computeProjectDigest(projectRoot)
    if (!projectDigest && needsProjectDigest && (gate === 'final' || taskId)) {
      throw err('PROJECT_DIGEST_UNAVAILABLE', 'Unable to compute projectDigest for code review gate')
    }
  }

  const bodyForId = JSON.stringify({
    gate,
    taskId,
    consistencyRevision: status.consistency?.revision ?? 0,
    inputs: captured,
    projectDigest: projectDigest?.digest ?? null,
  })
  const contentDigest = sha256Bytes(Buffer.from(bodyForId, 'utf8'))
  const nonce = randomBytes(4).toString('hex')
  const id = `snap-${contentDigest.slice(0, 16)}-${nonce}`

  const snapshot = {
    id,
    gate,
    taskId,
    createdAt: new Date().toISOString(),
    consistencyRevision: status.consistency?.revision ?? 0,
    inputs: captured,
    projectDigest,
  }

  const dir = path.join(resolved, 'revisions/snapshots')
  await mkdir(dir, { recursive: true })
  const filePath = path.join(dir, `${id}.json`)
  try {
    const handle = await open(filePath, 'wx')
    try {
      await handle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`)
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw err('SNAPSHOT_EXISTS', `Snapshot already exists: ${id}`)
    }
    throw error
  }

  return snapshot
}

/**
 * 按 id 读已落盘快照。拒绝路径逃逸；找不到则 MISSING_SNAPSHOT。
 */
export async function readSnapshot(featureDir, snapshotId) {
  const resolved = path.resolve(featureDir)
  if (!snapshotId || snapshotId.includes('..') || path.isAbsolute(snapshotId)) {
    throw err('INVALID_SNAPSHOT', `Invalid snapshot id: ${snapshotId}`)
  }
  const filePath = path.join(resolved, 'revisions/snapshots', `${snapshotId}.json`)
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    throw err('MISSING_SNAPSHOT', `Snapshot not found: ${snapshotId}`)
  }
}

/**
 * 核对快照是否仍新鲜。live 输入必须与当前字节一致。
 * baseline 只作对照，plan 批准后改代码不因此失败。
 * final/task 或含 live 项目输入时还要比对 projectDigest。
 */
export async function verifySnapshot(featureDir, snapshot) {
  const resolved = path.resolve(featureDir)
  const status = await readFeature(resolved)
  const projectRoot = status.project?.root
  const changes = []

  for (const input of snapshot.inputs || []) {
    // live 必须与当前字节一致；baseline 只作对照，实现后改代码不因此失败。
    if (input.freshness === 'baseline') continue
    const current = await resolveInputPath(resolved, projectRoot, input)
    if (current.exists !== input.exists || current.sha256 !== input.sha256) {
      changes.push({
        space: input.space,
        path: input.path,
        before: { exists: input.exists, sha256: input.sha256 },
        after: { exists: current.exists, sha256: current.sha256 },
      })
    }
  }

  if (snapshot.projectDigest?.digest) {
    const liveProjectInputs = (snapshot.inputs || []).some(
      (item) => item.space === 'project' && item.freshness === 'live',
    )
    if (liveProjectInputs || snapshot.gate === 'final' || snapshot.taskId) {
      const currentDigest = await computeProjectDigest(projectRoot)
      if (!currentDigest) {
        changes.push({ space: 'project', path: '.', reason: 'projectDigest unavailable' })
      } else if (currentDigest.digest !== snapshot.projectDigest.digest) {
        changes.push({
          space: 'project',
          path: '.',
          before: snapshot.projectDigest.digest,
          after: currentDigest.digest,
        })
      }
    }
  }

  return { fresh: changes.length === 0, changes }
}

/** CLI 入口，行为同 captureSnapshot。 */
export async function captureSnapshotCli(featureDir, request) {
  return captureSnapshot(featureDir, request)
}
