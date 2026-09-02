import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { cp, lstat, mkdtemp, mkdir, readFile, readlink, realpath, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { createFeatureWorkspace } from '../template/.ai-dev/scripts/init-change.mjs'
import { recordCodeChanges } from '../template/.ai-dev/scripts/record-code-changes.mjs'

const execFile = promisify(execFileCallback)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function git(cwd, ...args) {
  return execFile('git', args, { cwd })
}

async function makeFeature() {
  const projectRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'frontend-work-flow-code-')))
  await cp(path.join(repositoryRoot, 'template/.ai-dev'), path.join(projectRoot, '.ai-dev'), { recursive: true })
  await mkdir(path.join(projectRoot, 'src'))
  await writeFile(path.join(projectRoot, 'src/modified.js'), 'export const value = 1\n')
  await writeFile(path.join(projectRoot, 'src/deleted.js'), 'export const removed = true\n')
  await writeFile(path.join(projectRoot, 'src/preexisting.js'), 'export const state = "clean"\n')
  await git(projectRoot, 'init', '-b', 'main')
  await git(projectRoot, 'config', 'user.name', 'Test User')
  await git(projectRoot, 'config', 'user.email', 'test@example.com')
  await git(projectRoot, 'add', '.')
  await git(projectRoot, 'commit', '-m', 'initial')

  await writeFile(path.join(projectRoot, 'src/preexisting.js'), 'export const state = "already dirty"\n')
  const featureDir = await createFeatureWorkspace(projectRoot, {
    id: 'REQ-100',
    idSource: 'user',
    title: 'Code trace test',
    now: new Date('2026-09-02T09:00:00.000Z')
  })

  await writeFile(path.join(projectRoot, 'src/modified.js'), 'export const value = 2\n')
  await writeFile(path.join(projectRoot, 'src/new.js'), 'export const added = true\n')
  await writeFile(path.join(projectRoot, 'src/preexisting.js'), 'export const state = "changed again"\n')
  await unlink(path.join(projectRoot, 'src/deleted.js'))
  return { projectRoot, featureDir }
}

test('records changed files, live code links, and a durable patch from the real project', async () => {
  const fixture = await makeFeature()

  const manifest = await recordCodeChanges(fixture.featureDir, [
    'src/modified.js',
    'src/new.js',
    'src/deleted.js',
    'src/preexisting.js'
  ], { now: new Date('2026-09-02T10:00:00.000Z') })

  assert.deepEqual(manifest.files, [
    { path: 'src/deleted.js', status: 'deleted', preExisting: false, link: null },
    { path: 'src/modified.js', status: 'modified', preExisting: false, link: 'coding/src/modified.js' },
    { path: 'src/new.js', status: 'added', preExisting: false, link: 'coding/src/new.js' },
    { path: 'src/preexisting.js', status: 'modified', preExisting: true, link: 'coding/src/preexisting.js' }
  ])

  const codingRoot = path.join(fixture.featureDir, 'artifacts/coding-changes/coding')
  for (const relative of ['src/modified.js', 'src/new.js', 'src/preexisting.js']) {
    const linkPath = path.join(codingRoot, relative)
    assert.equal((await lstat(linkPath)).isSymbolicLink(), true)
    assert.equal(await realpath(linkPath), path.join(fixture.projectRoot, relative))
    assert.equal(path.isAbsolute(await readlink(linkPath)), false)
  }
  await assert.rejects(lstat(path.join(codingRoot, 'src/deleted.js')), error => error.code === 'ENOENT')

  const savedManifest = JSON.parse(await readFile(
    path.join(fixture.featureDir, 'artifacts/coding-changes/changed-files.json'),
    'utf8'
  ))
  assert.deepEqual(savedManifest, manifest)
  const patch = await readFile(path.join(fixture.featureDir, 'artifacts/coding-changes/changes.patch'), 'utf8')
  assert.match(patch, /src\/modified\.js/)
  assert.match(patch, /src\/new\.js/)
  assert.match(patch, /src\/deleted\.js/)
  assert.match(patch, /src\/preexisting\.js/)
  assert.doesNotMatch(patch, /\.ai-dev\/features/)
})

test('rejects paths outside the recorded real project', async () => {
  const fixture = await makeFeature()

  await assert.rejects(
    recordCodeChanges(fixture.featureDir, ['../outside.js']),
    /must stay inside the project/
  )
})
