import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'

import { migrateFeature } from '../template/.ai-dev/scripts/lib/workspace-store.mjs'
import {
  blockFeature,
  evaluateTransition,
  recordHumanApproval,
  resumeFeature,
  transitionFeature,
} from '../template/.ai-dev/scripts/lib/workflow-state.mjs'

const execFile = promisify(execFileCallback)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const controlScript = path.join(repositoryRoot, 'template/.ai-dev/scripts/workflow-control.mjs')

function approval(name) {
  return {
    approvedBy: name,
    approvedAt: '2026-09-02T08:00:00.000Z',
    decisionRef: `decision://${name}`,
  }
}

function v2Fields() {
  return {
    schemaVersion: 2,
    control: { version: 0, nextEvent: 1, events: [], blocked: null, artifactStatus: null },
    policy: { mode: 'strict', delegation: null, maxFixRounds: 3 },
    reviews: {},
    runtime: { activeTaskId: null, attempts: {}, taskResults: {} },
  }
}

async function makeFeature(statusOverrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'frontend-work-flow-wf-'))
  const featureDir = path.join(root, '.ai-dev/features/REQ-DEMO')
  await cp(path.join(repositoryRoot, 'template/.ai-dev/templates'), featureDir, { recursive: true })
  await mkdir(path.join(featureDir, 'revisions'), { recursive: true })
  await mkdir(path.join(featureDir, 'artifacts/coding-changes/coding'), { recursive: true })
  await cp(
    path.join(repositoryRoot, 'template/.ai-dev/artifact-graph.json'),
    path.join(root, '.ai-dev/artifact-graph.json'),
  )
  await writeFile(path.join(featureDir, 'artifacts/coding-changes/changes.patch'), '')

  const status = {
    id: 'REQ-DEMO',
    title: 'Demo',
    idSource: 'user',
    externalIds: [],
    state: 'INGEST',
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    project: {
      root,
      branch: 'main',
      baseCommit: '0123456789abcdef',
      initialChanges: [],
    },
    approvals: {
      scope: null,
      spec: null,
      plan: null,
      final: null,
    },
    consistency: {
      revision: 0,
      staleArtifacts: [],
      lastChange: null,
    },
    ...v2Fields(),
    ...statusOverrides,
  }
  if (statusOverrides.approvals) {
    status.approvals = { ...status.approvals, ...statusOverrides.approvals }
  }
  if (statusOverrides.consistency) {
    status.consistency = { ...status.consistency, ...statusOverrides.consistency }
  }
  if (statusOverrides.control) {
    status.control = { ...status.control, ...statusOverrides.control }
  }
  await writeFile(path.join(featureDir, 'status.json'), `${JSON.stringify(status, null, 2)}\n`)
  return featureDir
}

test('evaluateTransition allows adjacent approved edges and rejects skips', () => {
  const scopeApproved = {
    state: 'SCOPE_REVIEW',
    approvals: { scope: approval('s'), spec: null, plan: null, final: null },
    consistency: { staleArtifacts: [] },
  }
  const scopePending = {
    state: 'SCOPE_REVIEW',
    approvals: { scope: null, spec: null, plan: null, final: null },
    consistency: { staleArtifacts: [] },
  }

  assert.equal(evaluateTransition(scopeApproved, 'SPEC_REVIEW').ok, true)
  assert.equal(evaluateTransition(scopeApproved, 'IMPLEMENTING').ok, false)
  assert.equal(evaluateTransition(scopePending, 'SPEC_REVIEW').ok, false)
  assert.equal(evaluateTransition({ state: 'COMPLETE', approvals: {}, consistency: { staleArtifacts: [] } }, 'INGEST').ok, false)
  assert.equal(evaluateTransition({ state: 'BLOCKED', approvals: {}, consistency: { staleArtifacts: [] } }, 'SPEC_REVIEW').ok, false)
})

test('transitionFeature advances only with approvals and validateFeature structure', async () => {
  const featureDir = await makeFeature({ state: 'INGEST' })
  const next = await transitionFeature(featureDir, 'SCOPE_REVIEW', {
    actor: 'dev',
    expectedVersion: 0,
  })
  assert.equal(next.state, 'SCOPE_REVIEW')
  assert.ok(next.control.version >= 1)

  await assert.rejects(
    () =>
      transitionFeature(featureDir, 'SPEC_REVIEW', {
        actor: 'dev',
        expectedVersion: next.control.version,
      }),
    (error) => error.code === 'INVALID_TRANSITION',
  )
})

test('block and resume restore suspendedFrom after approval prerequisites hold', async () => {
  const featureDir = await makeFeature({
    state: 'SPEC_REVIEW',
    approvals: {
      scope: approval('scope'),
      spec: null,
      plan: null,
      final: null,
    },
  })

  const blocked = await blockFeature(featureDir, {
    reasonCode: 'NEED_CLARIFICATION',
    requiredInput: '产品确认范围',
    actor: 'dev',
    expectedVersion: 0,
  })
  assert.equal(blocked.state, 'BLOCKED')
  assert.equal(blocked.control.blocked.suspendedFrom, 'SPEC_REVIEW')

  const resumed = await resumeFeature(featureDir, {
    actor: 'dev',
    expectedVersion: 1,
  })
  assert.equal(resumed.state, 'SPEC_REVIEW')
  assert.equal(resumed.control.blocked, null)
})

test('recordHumanApproval requires decisionRef and current or invalidated gate', async () => {
  const featureDir = await makeFeature({ state: 'SCOPE_REVIEW' })
  await writeFile(
    path.join(featureDir, 'artifacts/analysis/intake.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      sources: [{ id: 'SRC-1', kind: 'prd', locator: 'prd.md', version: '1', contentHash: null, availability: 'available' }],
      evidence: [{ id: 'EV-1', claim: 'scope ok', label: 'CONFIRMED', sourceId: 'SRC-1', location: '1' }],
      requirements: [{
        id: 'FR-1',
        statement: 'frontend change',
        evidenceIds: ['EV-1'],
        ownership: 'FRONTEND_BEHAVIOR',
        disposition: 'included',
      }],
      questions: [],
    }, null, 2)}\n`,
  )
  await writeFile(path.join(featureDir, 'artifacts/analysis/scope.md'), '# Scope\n\nFrontend owns this change.\n')

  await assert.rejects(
    () =>
      recordHumanApproval(featureDir, {
        gate: 'scope',
        actor: 'reviewer',
        expectedVersion: 0,
      }),
    (error) => error.code === 'INVALID_REQUEST',
  )

  const approved = await recordHumanApproval(featureDir, {
    gate: 'scope',
    actor: 'reviewer',
    decisionRef: 'meeting-notes#1',
    expectedVersion: 0,
  })
  assert.equal(approved.approvals.scope.decisionRef, 'meeting-notes#1')
})

test('CLI inspect reads legacy status without migration', async () => {
  const featureDir = await makeFeature()
  await writeFile(
    path.join(featureDir, 'status.json'),
    `${JSON.stringify({
      id: 'REQ-DEMO',
      title: 'Demo',
      state: 'INGEST',
      consistency: { revision: 0, staleArtifacts: [] },
    }, null, 2)}\n`,
  )

  const result = await execFile('node', [controlScript, featureDir, 'inspect'])
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.needsMigration, true)
  assert.equal(payload.schemaVersion, 1)
  const disk = JSON.parse(await readFile(path.join(featureDir, 'status.json'), 'utf8'))
  assert.equal(disk.schemaVersion, undefined)
})

test('CLI migrate and unknown action behavior', async () => {
  const featureDir = await makeFeature()
  await writeFile(
    path.join(featureDir, 'status.json'),
    `${JSON.stringify({
      id: 'REQ-DEMO',
      title: 'Demo',
      idSource: 'user',
      externalIds: [],
      state: 'INGEST',
      project: {
        root: path.dirname(featureDir),
        branch: 'main',
        baseCommit: 'abc',
        initialChanges: [],
      },
      approvals: { scope: null, spec: null, plan: null, final: null },
      consistency: { revision: 0, staleArtifacts: [], lastChange: null },
    }, null, 2)}\n`,
  )

  const migrated = JSON.parse((await execFile('node', [controlScript, featureDir, 'migrate'])).stdout)
  assert.equal(migrated.schemaVersion, 2)
  assert.equal(migrated.ok, true)

  await assert.rejects(
    () => execFile('node', [controlScript, featureDir, 'nope']),
    (error) => error.code === 1 && /UNKNOWN_ACTION/.test(error.stderr),
  )
})

test('CLI transition refuses skip and leaves status unchanged', async () => {
  const featureDir = await makeFeature({
    state: 'SCOPE_REVIEW',
    approvals: { scope: approval('s'), spec: null, plan: null, final: null },
  })
  const requestPath = path.join(featureDir, 'request.json')
  await writeFile(
    requestPath,
    JSON.stringify({
      to: 'IMPLEMENTING',
      actor: 'dev',
      expectedVersion: 0,
    }),
  )

  await assert.rejects(
    () => execFile('node', [controlScript, featureDir, 'transition', '--request', requestPath]),
    (error) => error.code === 1 && /INVALID_TRANSITION|NON_ADJACENT/.test(error.stderr),
  )
  const disk = JSON.parse(await readFile(path.join(featureDir, 'status.json'), 'utf8'))
  assert.equal(disk.state, 'SCOPE_REVIEW')
  assert.equal(disk.control.version, 0)
})

test('migrateFeature via library remains available for resume edge cases', async () => {
  const featureDir = await makeFeature({ state: 'INGEST' })
  // force rewrite as legacy blocked
  await writeFile(
    path.join(featureDir, 'status.json'),
    `${JSON.stringify({
      id: 'REQ-DEMO',
      title: 'Demo',
      idSource: 'user',
      externalIds: [],
      state: 'BLOCKED',
      project: {
        root: path.dirname(featureDir),
        branch: 'main',
        baseCommit: 'abc',
        initialChanges: [],
      },
      approvals: { scope: null, spec: null, plan: null, final: null },
      consistency: { revision: 0, staleArtifacts: [], lastChange: null },
    }, null, 2)}\n`,
  )
  const migrated = await migrateFeature(featureDir)
  assert.equal(migrated.control.blocked.requiredInput, '人工指定原阶段')
  await assert.rejects(
    () => resumeFeature(featureDir, { actor: 'dev', expectedVersion: 0 }),
    (error) => error.code === 'RESUME_NEEDS_HUMAN',
  )
})
