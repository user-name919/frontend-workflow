import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'

import { createFeatureWorkspace } from '../template/.ai-dev/scripts/init-change.mjs'
import { prepareTask } from '../template/.ai-dev/scripts/prepare-task.mjs'
import {
  acceptTaskResult,
  inspectInterruptedTask,
  recoverReservation,
  startTask,
} from '../template/.ai-dev/scripts/lib/task-runs.mjs'
import { readFeature } from '../template/.ai-dev/scripts/lib/workspace-store.mjs'

const execFile = promisify(execFileCallback)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function git(cwd, ...args) {
  return execFile('git', args, { cwd })
}

function intake() {
  return {
    schemaVersion: 1,
    sources: [{ id: 'SRC-1', kind: 'prd', locator: 'prd.md', version: '1', contentHash: null, availability: 'available' }],
    evidence: [{ id: 'EV-1', claim: 'retry', label: 'CONFIRMED', sourceId: 'SRC-1', location: '§1' }],
    requirements: [
      { id: 'FR-1', statement: '失败可重试', evidenceIds: ['EV-1'], ownership: 'FRONTEND_BEHAVIOR', disposition: 'included' },
    ],
    questions: [],
  }
}

function delivery() {
  return {
    schemaVersion: 1,
    acceptance: [
      { id: 'AC-1', requirementIds: ['FR-1'], given: '失败', when: '重试', then: '再请求', verification: 'test' },
    ],
    tasks: [
      {
        id: 'T1',
        title: '重试',
        requirementIds: ['FR-1'],
        acceptanceIds: ['AC-1'],
        dependsOn: [],
        files: [{ path: 'src/retry.js', operation: 'modify' }],
        steps: ['add retry'],
        verify: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }],
      },
    ],
    links: [{ requirementId: 'FR-1', acceptanceId: 'AC-1', taskId: 'T1' }],
  }
}

async function makeFeature(id = 'REQ-RUN') {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'frontend-work-flow-run-'))
  await cp(path.join(repositoryRoot, 'template/.ai-dev'), path.join(projectRoot, '.ai-dev'), { recursive: true })
  await mkdir(path.join(projectRoot, 'src'), { recursive: true })
  await writeFile(path.join(projectRoot, 'src/retry.js'), 'export function retry() {}\n')
  await writeFile(path.join(projectRoot, 'src/preexisting.js'), 'export const leftover = true\n')
  await git(projectRoot, 'init', '-b', 'main')
  await git(projectRoot, 'config', 'user.name', 'Test')
  await git(projectRoot, 'config', 'user.email', 't@example.com')
  await git(projectRoot, 'add', '.')
  await git(projectRoot, 'commit', '-m', 'init')
  const featureDir = await createFeatureWorkspace(projectRoot, { id, idSource: 'user', title: id })
  await writeFile(path.join(featureDir, 'artifacts/analysis/intake.json'), `${JSON.stringify(intake(), null, 2)}\n`)
  await writeFile(path.join(featureDir, 'artifacts/design/delivery.json'), `${JSON.stringify(delivery(), null, 2)}\n`)
  return { projectRoot, featureDir }
}

function doneReport(overrides = {}) {
  return {
    taskId: 'T1',
    attemptId: 'A1',
    hostRunId: 'HOST-1',
    status: 'DONE',
    summary: 'added retry',
    changedFiles: ['src/retry.js'],
    verificationIds: [],
    concerns: [],
    requiredContext: [],
    exportedInterfaces: [{ contract: 'retry(fn)' }],
    ...overrides,
  }
}

test('DONE becomes review_pending; replay is idempotent; late old attempt is rejected', async () => {
  const { featureDir } = await makeFeature('REQ-RUN-1')
  await prepareTask(featureDir, 'T1', { attemptId: 'A1' })
  let status = await readFeature(featureDir)
  await startTask(featureDir, {
    taskId: 'T1',
    attemptId: 'A1',
    hostRunId: 'HOST-1',
    expectedVersion: status.control.version,
  })
  status = await readFeature(featureDir)
  const accepted = await acceptTaskResult(featureDir, doneReport(), { expectedVersion: status.control.version })
  assert.equal(accepted.runStatus, 'review_pending')
  assert.notEqual(accepted.runStatus, 'passed')
  assert.equal(accepted.status.runtime.taskResults.T1.status, 'review_pending')

  const replay = await acceptTaskResult(featureDir, doneReport(), {
    expectedVersion: accepted.status.control.version,
  })
  assert.equal(replay.idempotent, true)

  await prepareTask(featureDir, 'T1', { attemptId: 'A2' })
  status = await readFeature(featureDir)
  await startTask(featureDir, {
    taskId: 'T1',
    attemptId: 'A2',
    hostRunId: 'HOST-2',
    expectedVersion: status.control.version,
  })
  status = await readFeature(featureDir)
  await assert.rejects(
    () => acceptTaskResult(featureDir, doneReport({ hostRunId: 'HOST-1' }), { expectedVersion: status.control.version }),
    (error) => error.code === 'STALE_ATTEMPT',
  )
})

test('business-conflict concerns escalate; two features in one project cannot both start', async () => {
  const { projectRoot, featureDir } = await makeFeature('REQ-RUN-A')
  const otherDir = await createFeatureWorkspace(projectRoot, {
    id: 'REQ-RUN-B',
    idSource: 'user',
    title: 'Other',
  })
  await writeFile(path.join(otherDir, 'artifacts/analysis/intake.json'), `${JSON.stringify(intake(), null, 2)}\n`)
  await writeFile(path.join(otherDir, 'artifacts/design/delivery.json'), `${JSON.stringify(delivery(), null, 2)}\n`)

  await prepareTask(featureDir, 'T1', { attemptId: 'A1' })
  let status = await readFeature(featureDir)
  await startTask(featureDir, {
    taskId: 'T1',
    attemptId: 'A1',
    hostRunId: 'HOST-A',
    expectedVersion: status.control.version,
  })

  await prepareTask(otherDir, 'T1', { attemptId: 'A1' })
  const other = await readFeature(otherDir)
  await assert.rejects(
    () =>
      startTask(otherDir, {
        taskId: 'T1',
        attemptId: 'A1',
        hostRunId: 'HOST-B',
        expectedVersion: other.control.version,
      }),
    (error) => error.code === 'PROJECT_BUSY',
  )

  status = await readFeature(featureDir)
  const conflict = await acceptTaskResult(
    featureDir,
    doneReport({
      status: 'DONE_WITH_CONCERNS',
      concerns: ['接口契约冲突：重试次数产品未决'],
    }),
    { expectedVersion: status.control.version },
  )
  assert.equal(conflict.runStatus, 'blocked')
  assert.equal(conflict.reasonCode, 'BUSINESS_CONFLICT')
})

test('pre-existing undeclared file with unchanged digest is not a new scope change', async () => {
  const { projectRoot, featureDir } = await makeFeature('REQ-RUN-2')
  await writeFile(path.join(projectRoot, 'src/preexisting.js'), 'export const leftover = true\n')
  await prepareTask(featureDir, 'T1', { attemptId: 'A1' })
  let status = await readFeature(featureDir)
  await startTask(featureDir, {
    taskId: 'T1',
    attemptId: 'A1',
    hostRunId: 'HOST-1',
    expectedVersion: status.control.version,
  })
  await writeFile(path.join(projectRoot, 'src/retry.js'), 'export function retry() { return 1 }\n')
  status = await readFeature(featureDir)
  const accepted = await acceptTaskResult(featureDir, doneReport(), { expectedVersion: status.control.version })
  assert.equal(accepted.runStatus, 'review_pending')
})

test('new change outside allowed files is SCOPE_CHANGED and is not reverted', async () => {
  const { projectRoot, featureDir } = await makeFeature('REQ-RUN-3')
  await prepareTask(featureDir, 'T1', { attemptId: 'A1' })
  let status = await readFeature(featureDir)
  await startTask(featureDir, {
    taskId: 'T1',
    attemptId: 'A1',
    hostRunId: 'HOST-1',
    expectedVersion: status.control.version,
  })
  await writeFile(path.join(projectRoot, 'src/extra.js'), 'export const leaked = true\n')
  status = await readFeature(featureDir)
  await assert.rejects(
    () => acceptTaskResult(featureDir, doneReport({ changedFiles: ['src/retry.js', 'src/extra.js'] }), { expectedVersion: status.control.version }),
    (error) => error.code === 'SCOPE_CHANGED',
  )
  assert.equal(await readFile(path.join(projectRoot, 'src/extra.js'), 'utf8'), 'export const leaked = true\n')
  const after = await readFeature(featureDir)
  assert.equal(after.runtime.taskResults.T1.reasonCode, 'SCOPE_CHANGED')
})

test('inspect does not replay commands; recover requires worker stopped confirmation', async () => {
  const { featureDir } = await makeFeature('REQ-RUN-4')
  await prepareTask(featureDir, 'T1', { attemptId: 'A1' })
  let status = await readFeature(featureDir)
  await startTask(featureDir, {
    taskId: 'T1',
    attemptId: 'A1',
    hostRunId: 'HOST-1',
    expectedVersion: status.control.version,
  })
  const inspected = await inspectInterruptedTask(featureDir)
  assert.equal(inspected.taskId, 'T1')
  assert.equal(inspected.hasResult, false)
  assert.ok(inspected.pending.some((item) => /reservation/.test(item)))

  status = await readFeature(featureDir)
  await assert.rejects(
    () => recoverReservation(featureDir, { expectedVersion: status.control.version, actor: 'human' }),
    (error) => error.code === 'CONFIRM_WORKER_STOPPED',
  )
  status = await recoverReservation(featureDir, {
    expectedVersion: status.control.version,
    actor: 'human',
    confirmWorkerStopped: true,
  })
  assert.equal(status.runtime.taskResults.T1.status, 'pending')
  assert.equal(status.runtime.activeTaskId, null)
})
