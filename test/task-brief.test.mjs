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
import { mutateFeature } from '../template/.ai-dev/scripts/lib/workspace-store.mjs'

const execFile = promisify(execFileCallback)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function git(cwd, ...args) {
  return execFile('git', args, { cwd })
}

async function makeFeature() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'frontend-work-flow-brief-'))
  await cp(path.join(repositoryRoot, 'template/.ai-dev'), path.join(projectRoot, '.ai-dev'), { recursive: true })
  await mkdir(path.join(projectRoot, 'src'), { recursive: true })
  await writeFile(path.join(projectRoot, 'src/retry.js'), 'export function retry() {}\n')
  await writeFile(path.join(projectRoot, 'src/form.js'), 'export function form() {}\n')
  await git(projectRoot, 'init', '-b', 'main')
  await git(projectRoot, 'config', 'user.name', 'Test')
  await git(projectRoot, 'config', 'user.email', 't@example.com')
  await git(projectRoot, 'add', '.')
  await git(projectRoot, 'commit', '-m', 'init')
  const featureDir = await createFeatureWorkspace(projectRoot, {
    id: 'REQ-BRIEF',
    idSource: 'user',
    title: 'Brief',
  })
  return { projectRoot, featureDir }
}

function intake() {
  return {
    schemaVersion: 1,
    sources: [{ id: 'SRC-1', kind: 'prd', locator: 'prd.md', version: '1', contentHash: null, availability: 'available' }],
    evidence: [{ id: 'EV-1', claim: 'retry', label: 'CONFIRMED', sourceId: 'SRC-1', location: '§1' }],
    requirements: [
      { id: 'FR-1', statement: '失败可重试', evidenceIds: ['EV-1'], ownership: 'FRONTEND_BEHAVIOR', disposition: 'included' },
      { id: 'FR-2', statement: '表单展示错误', evidenceIds: ['EV-1'], ownership: 'FRONTEND_BEHAVIOR', disposition: 'included' },
    ],
    questions: [],
  }
}

function delivery() {
  return {
    schemaVersion: 1,
    acceptance: [
      { id: 'AC-1', requirementIds: ['FR-1'], given: '失败', when: '点重试', then: '再请求', verification: 'test' },
      { id: 'AC-2', requirementIds: ['FR-2'], given: '校验失败', when: '提交', then: '显示错误', verification: 'test' },
    ],
    tasks: [
      {
        id: 'T1',
        title: '重试',
        requirementIds: ['FR-1'],
        acceptanceIds: ['AC-1'],
        dependsOn: [],
        files: [{ path: 'src/retry.js', operation: 'modify' }],
        steps: ['implement retry'],
        verify: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }],
      },
      {
        id: 'T2',
        title: '表单错误',
        requirementIds: ['FR-2'],
        acceptanceIds: ['AC-2'],
        dependsOn: ['T1'],
        files: [{ path: 'src/form.js', operation: 'modify' }],
        steps: ['use retry helper'],
        verify: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }],
      },
    ],
    links: [
      { requirementId: 'FR-1', acceptanceId: 'AC-1', taskId: 'T1' },
      { requirementId: 'FR-2', acceptanceId: 'AC-2', taskId: 'T2' },
    ],
  }
}

test('task2 brief excludes task1 debug chat and includes exported interfaces', async () => {
  const { featureDir } = await makeFeature()
  await writeFile(path.join(featureDir, 'artifacts/analysis/intake.json'), `${JSON.stringify(intake(), null, 2)}\n`)
  await writeFile(path.join(featureDir, 'artifacts/design/delivery.json'), `${JSON.stringify(delivery(), null, 2)}\n`)
  await writeFile(
    path.join(featureDir, 'artifacts/design/frontend-spec.md'),
    '# Spec\n\n## FR-1\nRetry after failure.\n\n## FR-2\nShow form errors.\n',
  )
  await writeFile(
    path.join(featureDir, 'artifacts/design/implementation-plan.md'),
    '# Plan\n\n## T1\nChange src/retry.js\n\n## T2\nChange src/form.js using retry().\n',
  )

  await mkdir(path.join(featureDir, 'revisions/tasks/T1/A1'), { recursive: true })
  await writeFile(
    path.join(featureDir, 'revisions/tasks/T1/A1/debug-chat.md'),
    'DEBUG CHAT SECRET: I considered rewriting the whole store while implementing T1.\n',
  )

  await mutateFeature(
    featureDir,
    { expectedVersion: 0, event: { type: 'test.seed-t1', actor: 'test' } },
    (draft) => {
      draft.runtime.taskResults.T1 = {
        status: 'passed',
        exportedInterfaces: [{ contract: 'retry(fn): Promise<T> — rejects after 3 failures' }],
      }
    },
  )

  const prepared = await prepareTask(featureDir, 'T2', {
    searchRecords: [
      {
        query: 'form error display',
        method: 'rg',
        selectedPaths: ['src/form.js'],
        sourceLocations: ['src/form.js:1'],
      },
    ],
  })
  const brief = await readFile(path.join(featureDir, prepared.briefPath), 'utf8')
  const request = JSON.parse(await readFile(path.join(featureDir, prepared.requestPath), 'utf8'))

  assert.match(brief, /FR-2/)
  assert.match(brief, /AC-2/)
  assert.match(brief, /retry\(fn\)/)
  assert.match(brief, /form error display/)
  assert.doesNotMatch(brief, /DEBUG CHAT SECRET/)
  assert.doesNotMatch(brief, /rewriting the whole store/)
  assert.equal(request.taskId, 'T2')
  assert.equal(request.attemptId, 'A1')
  assert.ok(request.projectRoot)
  assert.ok(request.beforeSnapshotId)
  assert.deepEqual(
    request.allowedFiles.map((file) => file.path),
    ['src/form.js'],
  )
  assert.equal(request.exportedInterfacesFromDeps[0].taskId, 'T1')
})

test('prepareTask rejects incomplete task id and path escape', async () => {
  const { featureDir } = await makeFeature()
  await writeFile(path.join(featureDir, 'artifacts/analysis/intake.json'), `${JSON.stringify(intake(), null, 2)}\n`)
  await writeFile(path.join(featureDir, 'artifacts/design/delivery.json'), `${JSON.stringify(delivery(), null, 2)}\n`)
  await assert.rejects(() => prepareTask(featureDir, ''), (error) => error.code === 'INVALID_REQUEST')
  await assert.rejects(() => prepareTask(featureDir, 'T9'), (error) => error.code === 'UNKNOWN_TASK')
})
