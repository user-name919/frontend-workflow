import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, open, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { mkdtemp } from 'node:fs/promises'

import {
  migrateStatus,
  migrateFeature,
  mutateFeature,
  readFeature,
  StoreError,
} from '../template/.ai-dev/scripts/lib/workspace-store.mjs'

function legacyStatus(overrides = {}) {
  return {
    id: 'REQ-LEGACY',
    title: 'Legacy feature',
    idSource: 'user',
    externalIds: [],
    state: 'SCOPE_REVIEW',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    project: {
      root: '/tmp/project',
      branch: 'main',
      baseCommit: 'abc123',
      initialChanges: [],
    },
    consistency: {
      revision: 0,
      staleArtifacts: [],
      lastChange: null,
    },
    approvals: {
      scope: null,
      spec: null,
      plan: null,
      final: null,
    },
    customExtension: { keep: true },
    ...overrides,
  }
}

async function writeFeature(status) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'frontend-work-flow-store-'))
  const featureDir = path.join(root, 'REQ')
  await mkdir(path.join(featureDir, 'revisions'), { recursive: true })
  await writeFile(path.join(featureDir, 'status.json'), `${JSON.stringify(status, null, 2)}\n`)
  return featureDir
}

test('migrateStatus upgrades legacy status and rejects unknown schema', () => {
  const legacy = legacyStatus()
  const next = migrateStatus(legacy)
  assert.equal(next.schemaVersion, 2)
  assert.equal(next.state, legacy.state)
  assert.deepEqual(next.project, legacy.project)
  assert.equal(next.control.version, 0)
  assert.equal(next.policy.mode, 'strict')
  assert.equal(next.control.artifactStatus, 'NEEDS_STRUCTURED_IMPORT')
  assert.deepEqual(next.customExtension, { keep: true })
  assert.throws(
    () => migrateStatus({ ...legacy, schemaVersion: 99 }),
    (error) => error.code === 'UNSUPPORTED_SCHEMA',
  )
})

test('migrateStatus marks legacy BLOCKED without suspendedFrom for human recovery', () => {
  const next = migrateStatus(legacyStatus({ state: 'BLOCKED' }))
  assert.equal(next.state, 'BLOCKED')
  assert.equal(next.control.blocked.suspendedFrom, null)
  assert.equal(next.control.blocked.requiredInput, '人工指定原阶段')
})

test('readFeature refuses legacy status without writing', async () => {
  const featureDir = await writeFeature(legacyStatus())
  await assert.rejects(
    () => readFeature(featureDir),
    (error) => error instanceof StoreError && error.code === 'NEEDS_MIGRATION',
  )
  const disk = JSON.parse(await readFile(path.join(featureDir, 'status.json'), 'utf8'))
  assert.equal(disk.schemaVersion, undefined)
})

test('migrateFeature is idempotent and backs up legacy bytes once', async () => {
  const featureDir = await writeFeature(legacyStatus())
  const first = await migrateFeature(featureDir)
  assert.equal(first.schemaVersion, 2)
  const backup = await readFile(path.join(featureDir, 'revisions/migration-v1-status.json'), 'utf8')
  assert.match(backup, /"id": "REQ-LEGACY"/)

  const second = await migrateFeature(featureDir)
  assert.equal(second.schemaVersion, 2)
  assert.equal(second.control.version, 0)
  assert.deepEqual(second.control.events, [])
  const backupAgain = await readFile(path.join(featureDir, 'revisions/migration-v1-status.json'), 'utf8')
  assert.equal(backupAgain, backup)
})

test('readFeature rejects corrupt JSON', async () => {
  const featureDir = await writeFeature(legacyStatus())
  await writeFile(path.join(featureDir, 'status.json'), '{not-json')
  await assert.rejects(
    () => readFeature(featureDir),
    (error) => error.code === 'INVALID_JSON',
  )
})

test('mutateFeature appends event and enforces expectedVersion', async () => {
  const featureDir = await writeFeature(legacyStatus())
  await migrateFeature(featureDir)

  const updated = await mutateFeature(
    featureDir,
    {
      expectedVersion: 0,
      event: { type: 'test.ping', actor: 'tester', data: { ok: true } },
    },
    (status) => {
      status.title = 'Updated'
    },
  )
  assert.equal(updated.title, 'Updated')
  assert.equal(updated.control.version, 1)
  assert.equal(updated.control.events.length, 1)
  assert.equal(updated.control.events[0].beforeVersion, 0)
  assert.equal(updated.control.events[0].afterVersion, 1)
  assert.equal(updated.control.events[0].sequence, 1)

  await assert.rejects(
    () =>
      mutateFeature(
        featureDir,
        { expectedVersion: 0, event: { type: 'test.stale', actor: 'tester' } },
        (status) => {
          status.title = 'Should not write'
        },
      ),
    (error) => error.code === 'VERSION_CONFLICT',
  )
  const disk = JSON.parse(await readFile(path.join(featureDir, 'status.json'), 'utf8'))
  assert.equal(disk.title, 'Updated')
  assert.equal(disk.control.version, 1)
})

test('mutateFeature returns BUSY when status.lock already exists', async () => {
  const featureDir = await writeFeature(legacyStatus())
  await migrateFeature(featureDir)
  const lock = path.join(featureDir, 'status.lock')
  const handle = await open(lock, 'wx')
  await handle.close()
  try {
    await assert.rejects(
      () =>
        mutateFeature(
          featureDir,
          { expectedVersion: 0, event: { type: 'test.busy', actor: 'tester' } },
          () => {},
        ),
      (error) => error.code === 'BUSY',
    )
  } finally {
    await unlink(lock)
  }
})
