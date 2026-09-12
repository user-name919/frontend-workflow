import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'

import { createFeatureWorkspace } from '../template/.ai-dev/scripts/init-change.mjs'
import { recordDelegation } from '../template/.ai-dev/scripts/lib/workflow-state.mjs'
import { acceptReview, gateAuthorized } from '../template/.ai-dev/scripts/lib/reviews.mjs'
import { captureSnapshot } from '../template/.ai-dev/scripts/lib/snapshots.mjs'
import { reconcileArtifacts } from '../template/.ai-dev/scripts/lib/consistency.mjs'

const execFile = promisify(execFileCallback)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function git(cwd, ...args) {
  return execFile('git', args, { cwd })
}

async function makeFeature() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'frontend-work-flow-revpol-'))
  await cp(path.join(repositoryRoot, 'template/.ai-dev'), path.join(projectRoot, '.ai-dev'), { recursive: true })
  await mkdir(path.join(projectRoot, 'src'), { recursive: true })
  await writeFile(path.join(projectRoot, 'src/app.js'), 'export {}\n')
  await git(projectRoot, 'init', '-b', 'main')
  await git(projectRoot, 'config', 'user.name', 'Test')
  await git(projectRoot, 'config', 'user.email', 't@example.com')
  await git(projectRoot, 'add', '.')
  await git(projectRoot, 'commit', '-m', 'init')
  return createFeatureWorkspace(projectRoot, {
    id: 'REQ-REVPOL',
    idSource: 'user',
    title: 'Review policy',
  })
}

test('strict mode does not treat review pass as gate authorization; delegated spec can', async () => {
  const featureDir = await makeFeature()
  let status = await reconcileArtifacts(featureDir, { expectedVersion: 0 })

  const snapshot = await captureSnapshot(featureDir, {
    gate: 'spec',
    inputs: [{ space: 'feature', path: 'artifacts/design/frontend-spec.md' }],
  })

  const request = {
    requestId: 'RV-SPEC-1',
    gate: 'spec',
    taskId: null,
    packageId: 'pkg-spec',
    snapshotId: snapshot.id,
    requiredRuleIds: ['SPEC-ACCEPTANCE'],
    implementerRunId: 'IMPL-1',
    expectedVersion: status.control.version,
  }
  const report = {
    schemaVersion: 1,
    requestId: 'RV-SPEC-1',
    snapshotId: snapshot.id,
    reviewer: {
      runId: 'REV-1',
      host: 'cursor',
      model: 'test-model',
      independence: 'independent',
    },
    gate: 'spec',
    taskId: null,
    verdict: 'pass',
    specVerdict: 'pass',
    qualityVerdict: 'not_run',
    checks: [{ ruleId: 'SPEC-ACCEPTANCE', result: 'pass', evidence: ['AC-1'] }],
    findings: [],
  }

  assert.equal(gateAuthorized(status, 'spec', report), false)

  status = await recordDelegation(featureDir, {
    actor: 'lead',
    decisionRef: 'meeting#delegate-spec',
    expectedVersion: status.control.version,
    gates: ['spec'],
  })
  assert.equal(status.policy.mode, 'delegated-review')

  status = await acceptReview(featureDir, report, {
    request: { ...request, expectedVersion: status.control.version },
    expectedVersion: status.control.version,
    snapshot,
  })
  assert.equal(gateAuthorized(status, 'spec'), true)
  assert.equal(gateAuthorized(status, 'plan'), false)
  assert.equal(gateAuthorized(status, 'final'), false)
  assert.equal(status.approvals.spec, null)
})

test('delegate rejects scope/final and CLI unknown action stays safe', async () => {
  const featureDir = await makeFeature()
  const status = await reconcileArtifacts(featureDir, { expectedVersion: 0 })
  await assert.rejects(
    () =>
      recordDelegation(featureDir, {
        actor: 'lead',
        decisionRef: 'x',
        expectedVersion: status.control.version,
        gates: ['final'],
      }),
    (error) => error.code === 'INVALID_DELEGATION',
  )

  const control = path.join(repositoryRoot, 'template/.ai-dev/scripts/workflow-control.mjs')
  await assert.rejects(
    () => execFile('node', [control, featureDir, 'nope']),
    (error) => error.code === 1,
  )
})
