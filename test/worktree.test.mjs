import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readlink, realpath, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { createChangeWorktree } from '../template/.ai-dev/scripts/init-worktree.mjs'

const execFile = promisify(execFileCallback)

async function git(cwd, ...args) {
  return execFile('git', args, { cwd })
}

async function makeRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'frontend-work-flow-git-'))
  const changeId = '20260902-demo'
  const changeDir = path.join(root, '.ai-dev/changes', changeId)

  await mkdir(changeDir, { recursive: true })
  await writeFile(path.join(root, '.ai-dev/.gitignore'), 'worktrees/\nchanges/*/project\n')
  await writeFile(path.join(root, 'README.md'), '# fixture\n')
  await writeFile(path.join(changeDir, 'status.json'), `${JSON.stringify({
    id: changeId,
    title: 'Demo',
    state: 'IMPLEMENTING',
    approvals: {
      plan: {
        approvedBy: 'frontend-owner',
        approvedAt: '2026-09-02T09:00:00.000Z'
      }
    }
  }, null, 2)}\n`)

  await git(root, 'init', '-b', 'main')
  await git(root, 'config', 'user.name', 'Test User')
  await git(root, 'config', 'user.email', 'test@example.com')
  await git(root, 'add', '.')
  await git(root, 'commit', '-m', 'initial')

  const physicalRoot = await realpath(root)
  return {
    root: physicalRoot,
    changeDir: path.join(physicalRoot, '.ai-dev/changes', changeId),
    changeId
  }
}

test('creates an isolated worktree linked from the change workspace', async () => {
  const fixture = await makeRepository()
  const baseCommit = (await git(fixture.root, 'rev-parse', 'HEAD')).stdout.trim()

  const result = await createChangeWorktree(fixture.changeDir, {
    now: () => new Date('2026-09-02T09:30:00.000Z')
  })

  const expectedWorktree = path.join(fixture.root, '.ai-dev/worktrees', fixture.changeId)
  assert.equal(result.created, true)
  assert.equal(result.worktreePath, expectedWorktree)
  assert.equal(await readlink(path.join(fixture.changeDir, 'project')), `../../worktrees/${fixture.changeId}`)
  assert.equal((await stat(expectedWorktree)).isDirectory(), true)

  const metadata = JSON.parse(await readFile(path.join(fixture.changeDir, 'worktree.json'), 'utf8'))
  assert.deepEqual(metadata, {
    sourceRepository: fixture.root,
    worktreePath: expectedWorktree,
    branch: `sdd/${fixture.changeId}`,
    baseBranch: 'main',
    baseCommit,
    createdAt: '2026-09-02T09:30:00.000Z'
  })

  assert.equal((await git(expectedWorktree, 'branch', '--show-current')).stdout.trim(), `sdd/${fixture.changeId}`)
})

test('returns the existing workspace link without creating another worktree', async () => {
  const fixture = await makeRepository()
  await createChangeWorktree(fixture.changeDir)

  const result = await createChangeWorktree(fixture.changeDir)

  assert.equal(result.created, false)
  assert.equal(result.worktreePath, path.join(fixture.root, '.ai-dev/worktrees', fixture.changeId))
})

test('refuses to create a worktree before the implementation plan is approved', async () => {
  const fixture = await makeRepository()
  const statusPath = path.join(fixture.changeDir, 'status.json')
  const status = JSON.parse(await readFile(statusPath, 'utf8'))
  status.approvals.plan = null
  await writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`)

  await assert.rejects(
    createChangeWorktree(fixture.changeDir),
    /plan approval is required/
  )
})
