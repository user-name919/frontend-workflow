/**
 * Run approved delivery.verify commands with execFile only. Never invent passed.
 */

import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { captureSnapshot, verifySnapshot, readSnapshot } from './snapshots.mjs'
import { mutateFeature, readFeature, StoreError } from './workspace-store.mjs'

const execFile = promisify(execFileCallback)
const DEFAULT_TIMEOUT_MS = 120000

function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
}

async function readJson(featureDir, relative) {
  return JSON.parse(await readFile(path.join(featureDir, relative), 'utf8'))
}

function resolveCommand(command, projectRoot) {
  if (!command || typeof command !== 'string') {
    throw new StoreError('INVALID_COMMAND', 'verify command must be a string')
  }
  if (command.includes(' ') || command.includes('|') || command.includes('&&') || command.includes(';')) {
    throw new StoreError('SHELL_FORBIDDEN', 'Do not pass a shell string; use command + args')
  }
  if (path.isAbsolute(command)) return command
  return command
}

export function renderVerificationMarkdown(records) {
  const rows = records.length
    ? records.map((item) => `| \`${item.command} ${(item.args || []).join(' ')}\` | ${item.status} | exit=${item.exitCode}; ${item.id} |`)
    : ['| (none recorded) | unverified | run-verification.mjs has not produced records |']
  return [
    '# Verification',
    '',
    '## Automated checks',
    '',
    '| Command | Result | Evidence/notes |',
    '| --- | --- | --- |',
    ...rows,
    '',
    '## Manual checks',
    '',
    '- Recorded only when a human actually confirmed them.',
    '',
    '## Unverified items',
    '',
    ...records.filter((item) => item.status === 'unverified').map((item) => `- ${item.id}: ${item.summary || 'environment or script missing'}`),
    records.some((item) => item.status === 'unverified') ? '' : '- none recorded',
    '',
  ].join('\n')
}

/**
 * @param {string} featureDir
 * @param {{taskId:string,commandIndex:number,expectedSnapshotId?:string,timeoutMs?:number,actor?:string}} input
 */
export async function runVerification(featureDir, input = {}) {
  const resolved = path.resolve(featureDir)
  const { taskId, commandIndex, expectedSnapshotId, actor = 'coordinator' } = input
  const timeoutMs = Number.isInteger(input.timeoutMs) ? input.timeoutMs : DEFAULT_TIMEOUT_MS
  if (!taskId || !Number.isInteger(commandIndex)) {
    throw new StoreError('INVALID_REQUEST', 'taskId and commandIndex are required')
  }

  const status = await readFeature(resolved)
  const projectRoot = status.project?.root
  if (!projectRoot) throw new StoreError('MISSING_PROJECT', 'status.project.root is required')

  const delivery = await readJson(resolved, 'artifacts/design/delivery.json')
  const task = (delivery.tasks || []).find((item) => item.id === taskId)
  if (!task) throw new StoreError('UNKNOWN_TASK', `Unknown task ${taskId}`)
  const spec = task.verify?.[commandIndex]
  if (!spec) throw new StoreError('UNKNOWN_COMMAND', `No verify[${commandIndex}] on ${taskId}`)

  if (expectedSnapshotId) {
    const snapshot = await readSnapshot(resolved, expectedSnapshotId)
    const freshness = await verifySnapshot(resolved, snapshot)
    if (!freshness.fresh) {
      throw new StoreError('STALE_SNAPSHOT', 'expectedSnapshotId is no longer fresh')
    }
  }

  const command = resolveCommand(spec.command, projectRoot)
  const args = Array.isArray(spec.args) ? spec.args : []
  const cwd = spec.cwd && spec.cwd !== '.' ? path.resolve(projectRoot, spec.cwd) : projectRoot
  if (!isInside(projectRoot, cwd) && path.resolve(cwd) !== path.resolve(projectRoot)) {
    throw new StoreError('PATH_ESCAPE', 'verify cwd must stay inside the project')
  }

  const startedAt = new Date().toISOString()
  const startedMs = Date.now()
  const id = `ver-${taskId}-${commandIndex}-${startedMs}`
  const outDir = path.join(resolved, 'revisions/verifications', id)
  await mkdir(outDir, { recursive: true })

  let exitCode = null
  let timedOut = false
  let stdout = ''
  let stderr = ''
  let statusLabel = 'failed'
  let summary = ''
  let missingHost = false

  try {
    const result = await execFile(command, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      encoding: 'utf8',
    })
    stdout = result.stdout || ''
    stderr = result.stderr || ''
    exitCode = 0
  } catch (error) {
    stdout = error.stdout || ''
    stderr = error.stderr || error.message || ''
    timedOut = Boolean(error.killed) || /ETIMEOUT|timed out/i.test(error.message || '')
    if (error.code === 'ENOENT') {
      missingHost = true
      summary = 'command or host environment missing'
      exitCode = null
    } else {
      exitCode = typeof error.code === 'number' ? error.code : 1
      summary = timedOut ? 'timed out' : 'non-zero exit'
    }
  }

  const endedAt = new Date().toISOString()
  const stdoutPath = path.join(outDir, 'stdout.log')
  const stderrPath = path.join(outDir, 'stderr.log')
  await writeFile(stdoutPath, stdout)
  await writeFile(stderrPath, stderr)

  let outputSnapshot = null
  let sourceChanged = false
  if (expectedSnapshotId) {
    const snapshot = await readSnapshot(resolved, expectedSnapshotId)
    const after = await verifySnapshot(resolved, snapshot)
    sourceChanged = !after.fresh
    outputSnapshot = { id: snapshot.id, fresh: after.fresh, changes: after.changes }
  } else {
    outputSnapshot = await captureSnapshot(resolved, {
      gate: 'task',
      taskId,
      inputs: (task.files || []).map((file) => ({ space: 'project', path: file.path, freshness: 'live' })),
      includeProjectDigest: true,
    })
  }

  if (missingHost) statusLabel = 'unverified'
  else if (timedOut || exitCode !== 0 || sourceChanged) statusLabel = 'failed'
  else statusLabel = 'passed'

  const record = {
    id,
    taskId,
    command,
    args,
    cwd,
    startedAt,
    endedAt,
    exitCode,
    timedOut,
    stdoutPath: path.relative(resolved, stdoutPath),
    stderrPath: path.relative(resolved, stderrPath),
    inputSnapshotId: expectedSnapshotId || null,
    outputSnapshotId: outputSnapshot?.id || expectedSnapshotId || null,
    status: statusLabel,
    summary: summary || (sourceChanged ? 'source changed during verification' : ''),
  }

  const next = await mutateFeature(
    resolved,
    {
      expectedVersion: status.control.version,
      event: {
        type: 'verification.run',
        actor,
        data: { id, taskId, status: record.status, exitCode },
      },
    },
    (draft) => {
      draft.runtime = draft.runtime || { activeTaskId: null, attempts: {}, taskResults: {}, verifications: {} }
      draft.runtime.verifications = {
        ...(draft.runtime.verifications || {}),
        [id]: {
          id,
          taskId,
          status: record.status,
          exitCode,
          recordRef: path.relative(resolved, path.join(outDir, 'record.json')),
        },
      }
      if (draft.runtime.taskResults?.[taskId]) {
        const ids = new Set(draft.runtime.taskResults[taskId].verificationIds || [])
        ids.add(id)
        draft.runtime.taskResults[taskId].verificationIds = [...ids]
      } else {
        draft.runtime.taskResults = {
          ...(draft.runtime.taskResults || {}),
          [taskId]: { status: 'pending', verificationIds: [id] },
        }
      }
    },
  )

  await writeFile(path.join(outDir, 'record.json'), `${JSON.stringify(record, null, 2)}\n`)
  const records = Object.values(next.runtime.verifications || {})
  const detailed = []
  for (const item of records) {
    try {
      detailed.push(JSON.parse(await readFile(path.join(resolved, item.recordRef), 'utf8')))
    } catch {
      detailed.push({ ...item, command: '(missing record)', args: [] })
    }
  }
  await writeFile(path.join(resolved, 'artifacts/verification/verification.md'), renderVerificationMarkdown(detailed))

  return record
}
