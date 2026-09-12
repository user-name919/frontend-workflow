import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { runCli } from '../src/installer.mjs'
import { markArtifactChanged, resolveArtifacts } from '../template/.ai-dev/scripts/update-consistency.mjs'
import { recordCodeChanges } from '../template/.ai-dev/scripts/record-code-changes.mjs'
import { mutateFeature, readFeature } from '../template/.ai-dev/scripts/lib/workspace-store.mjs'

const execFile = promisify(execFileCallback)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function git(cwd, ...args) {
  return execFile('git', args, { cwd })
}

async function makeInstalledProject() {
  const projectRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'frontend-work-flow-ctl-')))
  await mkdir(path.join(projectRoot, 'src'), { recursive: true })
  await writeFile(path.join(projectRoot, 'src/index.js'), 'export const value = 1\n')
  await git(projectRoot, 'init', '-b', 'main')
  await git(projectRoot, 'config', 'user.name', 'Test User')
  await git(projectRoot, 'config', 'user.email', 'test@example.com')
  await git(projectRoot, 'add', '.')
  await git(projectRoot, 'commit', '-m', 'initial')

  await runCli(['setup', projectRoot], {
    packageRoot: repositoryRoot,
    now: () => new Date('2026-09-12T12:00:00.000Z'),
    stdout: () => {},
  })

  const init = await execFile('node', [
    path.join(projectRoot, '.ai-dev/scripts/init-change.mjs'),
    '--title', 'Control integration',
    '--id', 'REQ-CTL-1',
    '--id-source', 'user',
  ], { cwd: projectRoot })

  const featureDir = path.join(projectRoot, init.stdout.trim())
  return { projectRoot, featureDir }
}

test('setup → init → mark → resolve → record keeps schemaVersion and event chain', async () => {
  const { projectRoot, featureDir } = await makeInstalledProject()

  // Ensure installer copied lib modules.
  await readFile(path.join(projectRoot, '.ai-dev/scripts/lib/workspace-store.mjs'), 'utf8')
  await readFile(path.join(projectRoot, '.ai-dev/scripts/lib/workflow-state.mjs'), 'utf8')

  let status = await readFeature(featureDir)
  assert.equal(status.schemaVersion, 2)
  assert.equal(status.control.version, 0)
  assert.deepEqual(status.control.events, [])
  assert.equal(status.project.root, projectRoot)

  status = await markArtifactChanged(featureDir, 'artifacts/analysis/scope.md', {
    now: () => new Date('2026-09-12T12:01:00.000Z'),
  })
  assert.equal(status.control.version, 1)
  assert.equal(status.consistency.revision, 1)
  assert.equal(status.control.events.at(-1).type, 'consistency.mark')

  status = await resolveArtifacts(featureDir, status.consistency.staleArtifacts, {
    now: () => new Date('2026-09-12T12:02:00.000Z'),
  })
  assert.equal(status.control.version, 2)
  assert.deepEqual(status.consistency.staleArtifacts, [])
  assert.equal(status.control.events.at(-1).type, 'consistency.resolve')

  await writeFile(path.join(projectRoot, 'src/index.js'), 'export const value = 2\n')
  await recordCodeChanges(featureDir, ['src/index.js'], {
    now: new Date('2026-09-12T12:03:00.000Z'),
  })
  status = await readFeature(featureDir)
  assert.equal(status.schemaVersion, 2)
  assert.equal(status.control.version, 3)
  assert.equal(status.control.events.length, 3)
  assert.equal(status.control.events[0].sequence, 1)
  assert.equal(status.control.events[2].sequence, 3)
  assert.ok(status.project.baseCommit)
  assert.equal(status.id, 'REQ-CTL-1')
})

test('concurrent mutate with stale expectedVersion returns VERSION_CONFLICT', async () => {
  const { featureDir } = await makeInstalledProject()
  const first = await mutateFeature(
    featureDir,
    { expectedVersion: 0, event: { type: 'test.first', actor: 'a' } },
    (status) => {
      status.title = 'First write'
    },
  )
  assert.equal(first.control.version, 1)

  await assert.rejects(
    () =>
      mutateFeature(
        featureDir,
        { expectedVersion: 0, event: { type: 'test.second', actor: 'b' } },
        (status) => {
          status.title = 'Lost write'
        },
      ),
    (error) => error.code === 'VERSION_CONFLICT',
  )

  const disk = await readFeature(featureDir)
  assert.equal(disk.title, 'First write')
  assert.equal(disk.control.version, 1)
})
