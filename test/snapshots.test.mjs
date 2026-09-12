import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, readFile, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'

import { captureSnapshot, verifySnapshot } from '../template/.ai-dev/scripts/lib/snapshots.mjs'
import { createFeatureWorkspace } from '../template/.ai-dev/scripts/init-change.mjs'

const execFile = promisify(execFileCallback)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function git(cwd, ...args) {
  return execFile('git', args, { cwd })
}

async function makeFeature() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'frontend-work-flow-snap-'))
  await cp(path.join(repositoryRoot, 'template/.ai-dev'), path.join(projectRoot, '.ai-dev'), { recursive: true })
  await mkdir(path.join(projectRoot, 'src'), { recursive: true })
  await writeFile(path.join(projectRoot, 'src/app.js'), 'export const n = 1\n')
  await git(projectRoot, 'init', '-b', 'main')
  await git(projectRoot, 'config', 'user.name', 'Test')
  await git(projectRoot, 'config', 'user.email', 't@example.com')
  await git(projectRoot, 'add', '.')
  await git(projectRoot, 'commit', '-m', 'init')
  const featureDir = await createFeatureWorkspace(projectRoot, {
    id: 'REQ-SNAP',
    idSource: 'user',
    title: 'Snapshot',
  })
  return { projectRoot, featureDir }
}

test('snapshot stays fresh across mtime-only changes and goes stale on content change', async () => {
  const { featureDir } = await makeFeature()
  const deliveryPath = path.join(featureDir, 'artifacts/design/delivery.json')
  const s = await captureSnapshot(featureDir, {
    gate: 'plan',
    inputs: [{ space: 'feature', path: 'artifacts/design/delivery.json' }],
  })
  assert.equal((await verifySnapshot(featureDir, s)).fresh, true)

  const now = new Date()
  await utimes(deliveryPath, now, now)
  assert.equal((await verifySnapshot(featureDir, s)).fresh, true)

  await writeFile(deliveryPath, `${JSON.stringify({ schemaVersion: 1, acceptance: [], tasks: [], links: [], changed: true }, null, 2)}\n`)
  assert.equal((await verifySnapshot(featureDir, s)).fresh, false)
})

test('missing then created file makes previous snapshot stale; path escape fails', async () => {
  const { featureDir } = await makeFeature()
  const relative = 'artifacts/analysis/custom-note.md'
  const s = await captureSnapshot(featureDir, {
    gate: 'scope',
    inputs: [{ space: 'feature', path: relative }],
  })
  assert.equal(s.inputs[0].exists, false)
  assert.equal(s.inputs[0].sha256, null)

  await writeFile(path.join(featureDir, relative), 'hello\n')
  assert.equal((await verifySnapshot(featureDir, s)).fresh, false)

  await assert.rejects(
    () =>
      captureSnapshot(featureDir, {
        gate: 'scope',
        inputs: [{ space: 'feature', path: '../outside.md' }],
      }),
    (error) => error.code === 'PATH_ESCAPE',
  )
})

test('baseline project inputs do not invalidate plan snapshot when source code changes', async () => {
  const { featureDir, projectRoot } = await makeFeature()
  const s = await captureSnapshot(featureDir, {
    gate: 'plan',
    inputs: [
      { space: 'feature', path: 'artifacts/design/delivery.json', freshness: 'live' },
      { space: 'project', path: 'src/app.js', freshness: 'baseline' },
    ],
  })
  await writeFile(path.join(projectRoot, 'src/app.js'), 'export const n = 2\n')
  assert.equal((await verifySnapshot(featureDir, s)).fresh, true)
})

test('init writes code-baseline.json', async () => {
  const { featureDir } = await makeFeature()
  const baseline = JSON.parse(await readFile(path.join(featureDir, 'revisions/code-baseline.json'), 'utf8'))
  assert.ok(baseline.baseCommit)
  assert.ok(Array.isArray(baseline.files))
})
