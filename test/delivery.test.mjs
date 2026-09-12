import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { validateDelivery, validateDeliveryAsync, renderDelivery } from '../template/.ai-dev/scripts/lib/delivery.mjs'

const intake = {
  schemaVersion: 1,
  sources: [{ id: 'SRC-1', kind: 'prd', locator: 'prd.md', version: '1', contentHash: null, availability: 'available' }],
  evidence: [{ id: 'EV-1', claim: 'retry', label: 'CONFIRMED', sourceId: 'SRC-1', location: '1' }],
  requirements: [
    {
      id: 'FR-1',
      statement: 'retry button',
      evidenceIds: ['EV-1'],
      ownership: 'FRONTEND_BEHAVIOR',
      disposition: 'included',
    },
    {
      id: 'FR-X',
      statement: 'backend',
      evidenceIds: ['EV-1'],
      ownership: 'BACKEND_DATA',
      disposition: 'excluded',
      exclusionReason: 'backend',
    },
  ],
  questions: [],
}

function validDelivery(overrides = {}) {
  return {
    schemaVersion: 1,
    acceptance: [
      {
        id: 'AC-1',
        requirementIds: ['FR-1'],
        given: '接口失败',
        when: '点击重试',
        then: '重新发送请求',
        verification: 'test',
      },
    ],
    tasks: [
      {
        id: 'T1',
        title: '实现加载重试',
        requirementIds: ['FR-1'],
        acceptanceIds: ['AC-1'],
        dependsOn: [],
        files: [{ path: 'src/retry.js', operation: 'modify' }],
        steps: ['沿现有请求入口增加重试事件处理'],
        verify: [{ command: 'npm', args: ['test', '--', 'retry'], cwd: '.' }],
      },
    ],
    links: [{ requirementId: 'FR-1', acceptanceId: 'AC-1', taskId: 'T1' }],
    ...overrides,
  }
}

test('validateDelivery detects cycles and accepts valid plan delivery', () => {
  const cyclicTasks = validDelivery({
    tasks: [
      {
        id: 'T1',
        title: 'A',
        requirementIds: ['FR-1'],
        acceptanceIds: ['AC-1'],
        dependsOn: ['T2'],
        files: [{ path: 'src/a.js', operation: 'create' }],
        steps: ['a'],
        verify: [{ command: 'node', args: ['-v'], cwd: '.' }],
      },
      {
        id: 'T2',
        title: 'B',
        requirementIds: ['FR-1'],
        acceptanceIds: ['AC-1'],
        dependsOn: ['T1'],
        files: [{ path: 'src/b.js', operation: 'create' }],
        steps: ['b'],
        verify: [{ command: 'node', args: ['-v'], cwd: '.' }],
      },
    ],
    links: [
      { requirementId: 'FR-1', acceptanceId: 'AC-1', taskId: 'T1' },
      { requirementId: 'FR-1', acceptanceId: 'AC-1', taskId: 'T2' },
    ],
  })
  assert.ok(validateDelivery(intake, cyclicTasks, { phase: 'plan' }).errors.some((e) => e.code === 'TASK_CYCLE'))
  assert.equal(validateDelivery(intake, validDelivery(), { phase: 'plan' }).ok, true)
})

test('validateDelivery rejects uncovered requirements, excluded tasks, and path escape', () => {
  const uncovered = validDelivery({ acceptance: [], tasks: [], links: [] })
  assert.ok(
    validateDelivery(intake, uncovered, { phase: 'spec' }).errors.some((e) => e.code === 'REQUIREMENT_UNCOVERED'),
  )

  const excludedTask = validDelivery({
    tasks: [
      {
        id: 'T1',
        title: 'bad',
        requirementIds: ['FR-X'],
        acceptanceIds: ['AC-1'],
        dependsOn: [],
        files: [{ path: 'src/x.js', operation: 'create' }],
        steps: ['x'],
        verify: [{ command: 'node', args: ['-v'], cwd: '.' }],
      },
    ],
  })
  assert.ok(
    validateDelivery(intake, excludedTask, { phase: 'plan' }).errors.some((e) => e.code === 'EXCLUDED_REQUIREMENT'),
  )

  const escaped = validDelivery({
    tasks: [
      {
        id: 'T1',
        title: 'escape',
        requirementIds: ['FR-1'],
        acceptanceIds: ['AC-1'],
        dependsOn: [],
        files: [{ path: '../outside.js', operation: 'create' }],
        steps: ['x'],
        verify: [{ command: 'node', args: ['-v'], cwd: '.' }],
      },
    ],
  })
  assert.ok(validateDelivery(intake, escaped, { phase: 'plan' }).errors.some((e) => e.code === 'PATH_ESCAPE'))
})

test('validateDeliveryAsync checks create paths with spaces and existing modify targets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delivery-path-'))
  await mkdir(path.join(root, 'src'), { recursive: true })
  await writeFile(path.join(root, 'src', 'retry.js'), 'export {}\n')

  const withSpaceCreate = validDelivery({
    tasks: [
      {
        id: 'T1',
        title: 'create spaced',
        requirementIds: ['FR-1'],
        acceptanceIds: ['AC-1'],
        dependsOn: [],
        files: [{ path: 'src/new file.js', operation: 'create' }],
        steps: ['add file'],
        verify: [{ command: 'node', args: ['-v'], cwd: '.' }],
      },
    ],
  })
  const createResult = await validateDeliveryAsync(intake, withSpaceCreate, {
    phase: 'plan',
    projectRoot: root,
    checkPaths: true,
  })
  assert.equal(createResult.ok, true)

  const modifyMissing = validDelivery({
    tasks: [
      {
        id: 'T1',
        title: 'modify missing',
        requirementIds: ['FR-1'],
        acceptanceIds: ['AC-1'],
        dependsOn: [],
        files: [{ path: 'src/missing.js', operation: 'modify' }],
        steps: ['edit'],
        verify: [{ command: 'node', args: ['-v'], cwd: '.' }],
      },
    ],
  })
  const modifyResult = await validateDeliveryAsync(intake, modifyMissing, {
    phase: 'plan',
    projectRoot: root,
    checkPaths: true,
  })
  assert.ok(modifyResult.errors.some((e) => e.code === 'MISSING_FILE_EVIDENCE'))

  const escapeAsync = validDelivery({
    tasks: [
      {
        id: 'T1',
        title: 'escape',
        requirementIds: ['FR-1'],
        acceptanceIds: ['AC-1'],
        dependsOn: [],
        files: [{ path: '../outside.js', operation: 'create' }],
        steps: ['x'],
        verify: [{ command: 'node', args: ['-v'], cwd: '.' }],
      },
    ],
  })
  const escapeResult = await validateDeliveryAsync(intake, escapeAsync, {
    phase: 'plan',
    projectRoot: root,
    checkPaths: true,
  })
  assert.ok(escapeResult.errors.some((e) => e.code === 'PATH_ESCAPE'))
})

test('renderDelivery uses taskResults for status without mutating delivery', () => {
  const delivery = validDelivery()
  const frozen = JSON.stringify(delivery)
  const views = renderDelivery(intake, delivery, { T1: { status: 'DONE' } })
  assert.equal(JSON.stringify(delivery), frozen)
  assert.match(views['artifacts/design/tasks.md'], /Status: DONE/)
  assert.match(views['artifacts/design/tasks.md'], /generated:from=artifacts\/design\/delivery\.json/)
})
