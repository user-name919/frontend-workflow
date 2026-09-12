import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'

import { createReviewPackage, assertSnapshotBoundApproval } from '../template/.ai-dev/scripts/lib/review-package.mjs'
import { createFeatureWorkspace } from '../template/.ai-dev/scripts/init-change.mjs'

const execFile = promisify(execFileCallback)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function git(cwd, ...args) {
  return execFile('git', args, { cwd })
}

test('createReviewPackage freezes snapshot and task before/after digests', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'frontend-work-flow-pkg-'))
  await cp(path.join(repositoryRoot, 'template/.ai-dev'), path.join(projectRoot, '.ai-dev'), { recursive: true })
  await mkdir(path.join(projectRoot, 'src'), { recursive: true })
  await writeFile(path.join(projectRoot, 'src/app.js'), 'export const n = 1\n')
  await git(projectRoot, 'init', '-b', 'main')
  await git(projectRoot, 'config', 'user.name', 'Test')
  await git(projectRoot, 'config', 'user.email', 't@example.com')
  await git(projectRoot, 'add', '.')
  await git(projectRoot, 'commit', '-m', 'init')
  const featureDir = await createFeatureWorkspace(projectRoot, {
    id: 'REQ-PKG',
    idSource: 'user',
    title: 'Package',
  })

  const result = await createReviewPackage(featureDir, {
    gate: 'plan',
    taskId: 'T1',
    inputs: [{ space: 'feature', path: 'artifacts/design/delivery.json' }],
    beforeFiles: { 'src/app.js': 'export const n = 1\n' },
    afterFiles: { 'src/app.js': 'export const n = 2\n' },
  })

  assert.ok(result.packageId)
  assert.ok(result.snapshotId)
  const manifest = JSON.parse(await readFile(path.join(featureDir, result.manifestPath), 'utf8'))
  assert.equal(manifest.snapshotId, result.snapshotId)
  assert.ok(manifest.taskDelta.beforeFileDigests['src/app.js'])
  assert.notEqual(
    manifest.taskDelta.beforeFileDigests['src/app.js'],
    manifest.taskDelta.afterFileDigests['src/app.js'],
  )
  assert.match(manifest.note, /Softlinks/)
})

test('legacy approval without snapshotId requires reapproval', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'frontend-work-flow-pkg2-'))
  await cp(path.join(repositoryRoot, 'template/.ai-dev'), path.join(projectRoot, '.ai-dev'), { recursive: true })
  await mkdir(path.join(projectRoot, 'src'), { recursive: true })
  await writeFile(path.join(projectRoot, 'src/app.js'), 'export {}\n')
  await git(projectRoot, 'init', '-b', 'main')
  await git(projectRoot, 'config', 'user.name', 'Test')
  await git(projectRoot, 'config', 'user.email', 't@example.com')
  await git(projectRoot, 'add', '.')
  await git(projectRoot, 'commit', '-m', 'init')
  const featureDir = await createFeatureWorkspace(projectRoot, {
    id: 'REQ-PKG2',
    idSource: 'user',
    title: 'Package2',
  })

  const check = await assertSnapshotBoundApproval(
    featureDir,
    { approvedBy: 'old', approvedAt: '2026-01-01T00:00:00.000Z', decisionRef: 'legacy' },
    'scope',
  )
  assert.equal(check.ok, false)
  assert.equal(check.code, 'REAPPROVAL_REQUIRED')
})
