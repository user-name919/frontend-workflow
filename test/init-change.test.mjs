import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { cp, mkdtemp, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const initScript = path.join(repositoryRoot, 'template/.ai-dev/scripts/init-change.mjs')
const validateScript = path.join(repositoryRoot, 'template/.ai-dev/scripts/validate-change.mjs')

async function git(cwd, ...args) {
  return execFile('git', args, { cwd })
}

async function makeProject() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'frontend-work-flow-init-')))
  await cp(path.join(repositoryRoot, 'template/.ai-dev'), path.join(root, '.ai-dev'), { recursive: true })
  await mkdir(path.join(root, 'src'))
  await writeFile(path.join(root, 'src/index.js'), 'export const value = 1\n')
  await git(root, 'init', '-b', 'main')
  await git(root, 'config', 'user.name', 'Test User')
  await git(root, 'config', 'user.email', 'test@example.com')
  await git(root, 'add', '.')
  await git(root, 'commit', '-m', 'initial')
  await writeFile(path.join(root, 'local.env'), 'LOCAL_ONLY=true\n')
  return root
}

async function isDirectory(target) {
  return (await stat(target)).isDirectory()
}

test('creates a layered feature workspace from an explicit business requirement id', async () => {
  const projectRoot = await makeProject()
  const baseCommit = (await git(projectRoot, 'rev-parse', 'HEAD')).stdout.trim()

  const result = await execFile('node', [
    initScript,
    '--title', '错题本教研学校字段调整',
    '--id', 'R-KF-649215',
    '--id-source', 'document'
  ], { cwd: projectRoot })

  const featureDir = path.join(projectRoot, '.ai-dev/features/R-KF-649215')
  assert.equal(result.stdout.trim(), '.ai-dev/features/R-KF-649215')
  const status = JSON.parse(await readFile(path.join(featureDir, 'status.json'), 'utf8'))
  assert.equal(status.id, 'R-KF-649215')
  assert.equal(status.title, '错题本教研学校字段调整')
  assert.equal(status.idSource, 'document')
  assert.deepEqual(status.externalIds, [])
  assert.equal(status.project.root, projectRoot)
  assert.equal(status.project.branch, 'main')
  assert.equal(status.project.baseCommit, baseCommit)
  assert.deepEqual(status.project.initialChanges, [{ status: '??', path: 'local.env' }])

  for (const relative of [
    'artifacts/analysis',
    'artifacts/design',
    'artifacts/coding-changes/coding',
    'artifacts/verification',
    'revisions'
  ]) {
    assert.equal(await isDirectory(path.join(featureDir, relative)), true)
  }
  assert.equal(
    JSON.parse(await readFile(path.join(featureDir, 'artifacts/coding-changes/changed-files.json'), 'utf8')).files.length,
    0
  )
  assert.equal(await readFile(path.join(featureDir, 'artifacts/coding-changes/changes.patch'), 'utf8'), '')

  const validation = await execFile('node', [validateScript, featureDir], { cwd: projectRoot })
  assert.equal(validation.stdout.trim(), 'Valid feature: .ai-dev/features/R-KF-649215 (INGEST)')
})

test('generates a stable local id when only a requirement title is available', async () => {
  const projectRoot = await makeProject()

  const result = await execFile('node', [
    initScript,
    '--title', '只有名称的需求'
  ], { cwd: projectRoot })

  const relativeDir = result.stdout.trim()
  const date = new Date()
  const datePart = [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((value, index) => index === 0 ? String(value) : String(value).padStart(2, '0'))
    .join('')
  assert.match(relativeDir, new RegExp(`^\\.ai-dev/features/REQ-${datePart}-[A-F0-9]{6}$`))

  const status = JSON.parse(await readFile(path.join(projectRoot, relativeDir, 'status.json'), 'utf8'))
  assert.equal(status.title, '只有名称的需求')
  assert.equal(status.idSource, 'generated')
  assert.deepEqual(status.externalIds, [])
})
