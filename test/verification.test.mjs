import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'

import { createFeatureWorkspace } from '../template/.ai-dev/scripts/init-change.mjs'
import { runVerification } from '../template/.ai-dev/scripts/lib/verification.mjs'
import { captureSnapshot } from '../template/.ai-dev/scripts/lib/snapshots.mjs'
import { readDashboard } from '../template/.ai-dev/scripts/dashboard.mjs'

const execFile = promisify(execFileCallback)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function git(cwd, ...args) {
  return execFile('git', args, { cwd })
}

async function makeFeature(verify) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'frontend-work-flow-ver-'))
  await cp(path.join(repositoryRoot, 'template/.ai-dev'), path.join(projectRoot, '.ai-dev'), { recursive: true })
  await mkdir(path.join(projectRoot, 'src'), { recursive: true })
  await writeFile(path.join(projectRoot, 'src/retry.js'), 'export const retry = true\n')
  await git(projectRoot, 'init', '-b', 'main')
  await git(projectRoot, 'config', 'user.name', 'Test')
  await git(projectRoot, 'config', 'user.email', 't@example.com')
  await git(projectRoot, 'add', '.')
  await git(projectRoot, 'commit', '-m', 'init')
  const featureDir = await createFeatureWorkspace(projectRoot, {
    id: 'REQ-VER',
    idSource: 'user',
    title: 'Verification',
  })
  await writeFile(
    path.join(featureDir, 'artifacts/analysis/intake.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      sources: [{ id: 'SRC-1', kind: 'prd', locator: 'p.md', version: '1', contentHash: null, availability: 'available' }],
      evidence: [{ id: 'EV-1', claim: 'retry', label: 'CONFIRMED', sourceId: 'SRC-1', location: '§1' }],
      requirements: [
        { id: 'FR-1', statement: 'retry', evidenceIds: ['EV-1'], ownership: 'FRONTEND_BEHAVIOR', disposition: 'included' },
      ],
      questions: [],
    }, null, 2)}\n`,
  )
  await writeFile(
    path.join(featureDir, 'artifacts/design/delivery.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      acceptance: [{ id: 'AC-1', requirementIds: ['FR-1'], given: 'a', when: 'b', then: 'c', verification: 'test' }],
      tasks: [
        {
          id: 'T1',
          title: 'retry',
          requirementIds: ['FR-1'],
          acceptanceIds: ['AC-1'],
          dependsOn: [],
          files: [{ path: 'src/retry.js', operation: 'modify' }],
          steps: ['x'],
          verify,
        },
      ],
      links: [{ requirementId: 'FR-1', acceptanceId: 'AC-1', taskId: 'T1' }],
    }, null, 2)}\n`,
  )
  return { projectRoot, featureDir }
}

test('non-zero exit cannot be recorded as passed', async () => {
  const { featureDir } = await makeFeature([
    { command: process.execPath, args: ['-e', 'process.exit(1)'] },
  ])
  const before = await captureSnapshot(featureDir, {
    gate: 'task',
    taskId: 'T1',
    inputs: [{ space: 'project', path: 'src/retry.js', freshness: 'live' }],
    includeProjectDigest: true,
  })
  const result = await runVerification(featureDir, {
    taskId: 'T1',
    commandIndex: 0,
    expectedSnapshotId: before.id,
  })
  assert.equal(result.exitCode, 1)
  assert.equal(result.status, 'failed')
})

test('missing command is unverified; timeout and source change are not passed', async () => {
  const missing = await makeFeature([{ command: 'definitely-not-a-command-xyz', args: [] }])
  const missingResult = await runVerification(missing.featureDir, { taskId: 'T1', commandIndex: 0 })
  assert.equal(missingResult.status, 'unverified')
  assert.notEqual(missingResult.status, 'passed')

  const timed = await makeFeature([
    { command: process.execPath, args: ['-e', 'while (true) {}'] },
  ])
  const timedResult = await runVerification(timed.featureDir, {
    taskId: 'T1',
    commandIndex: 0,
    timeoutMs: 50,
  })
  assert.equal(timedResult.status, 'failed')
  assert.equal(timedResult.timedOut, true)

  const changed = await makeFeature([
    {
      command: process.execPath,
      args: ['-e', 'require("fs").writeFileSync("src/retry.js", "export const retry = false\\n")'],
    },
  ])
  const before = await captureSnapshot(changed.featureDir, {
    gate: 'task',
    taskId: 'T1',
    inputs: [{ space: 'project', path: 'src/retry.js', freshness: 'live' }],
    includeProjectDigest: true,
  })
  const changedResult = await runVerification(changed.featureDir, {
    taskId: 'T1',
    commandIndex: 0,
    expectedSnapshotId: before.id,
  })
  assert.notEqual(changedResult.status, 'passed')
  assert.equal(changedResult.status, 'failed')
})

test('dashboard observes a verification command while it is running and after it ends', async () => {
  const { projectRoot, featureDir } = await makeFeature([
    { command: process.execPath, args: ['-e', 'setTimeout(() => process.exit(0), 1000)'] },
  ])
  const execution = runVerification(featureDir, { taskId: 'T1', commandIndex: 0 })
  let observed
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const dashboard = await readDashboard(projectRoot)
    observed = dashboard.observations.find((event) => event.kind === 'command' && event.status === 'running')
    if (observed) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.ok(observed, 'the command should be visible before it completes')
  assert.equal(observed.taskId, 'T1')
  assert.equal(observed.command, path.basename(process.execPath))
  const result = await execution
  assert.equal(result.status, 'passed')
  const dashboard = await readDashboard(projectRoot)
  assert.equal(dashboard.observations.find((event) => event.id === observed.id).status, 'completed')
})
