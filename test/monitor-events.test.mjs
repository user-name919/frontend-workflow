import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { finishSkillObservation, startActivity, startSkillObservation, traceContext } from '../template/.ai-dev/scripts/lib/monitor-events.mjs'

const execFile = promisify(execFileCallback)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-monitor-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, '.ai-dev', 'features', 'REQ-1'), { recursive: true })
  return root
}

async function events(root) {
  const directory = path.join(root, '.ai-dev', 'runtime', 'dashboard', 'events')
  const names = await readdir(directory)
  return Promise.all(names.filter((name) => name.endsWith('.json')).map(async (name) => JSON.parse(await readFile(path.join(directory, name), 'utf8'))))
}

test('observations preserve process results, feature association, and independent concurrent events', async (t) => {
  const root = await fixture(t)
  const featureDir = path.join(root, '.ai-dev', 'features', 'REQ-1')
  assert.deepEqual(traceContext(featureDir), { projectRoot: root, featureId: 'REQ-1' })
  const active = Array.from({ length: 16 }, (_, index) => startActivity({ featureDir, kind: 'script', component: 'prepare-task.mjs', taskId: `T${index + 1}` }))
  assert.equal(new Set(active.map((item) => item.id)).size, 16)
  active.forEach((item, index) => item.finish(index === 0 ? 1 : 0))
  active[0].finish(0)
  const recorded = await events(root)
  assert.equal(recorded.length, 16)
  assert.ok(recorded.every((item) => item.featureId === 'REQ-1' && item.endedAt))
  assert.equal(recorded.find((item) => item.id === active[0].id).status, 'failed')
  assert.equal(await readFile(path.join(root, '.ai-dev', 'runtime', 'dashboard', '.gitignore'), 'utf8'), '*\n')
})

test('skill observations are explicitly agent-reported and can be finished without changing the ledger', async (t) => {
  const root = await fixture(t)
  const featureDir = path.join(root, '.ai-dev', 'features', 'REQ-1')
  const id = startSkillObservation(root, featureDir, 'prepare-review', 'T1')
  let [event] = await events(root)
  assert.equal(event.kind, 'skill')
  assert.equal(event.source, 'agent')
  assert.equal(event.status, 'running')
  assert.equal(event.taskId, 'T1')
  finishSkillObservation(root, id)
  ;[event] = await events(root)
  assert.equal(event.status, 'completed')
  assert.throws(() => startSkillObservation(root, featureDir, 'invented-skill'), /Unknown/)
  assert.throws(() => finishSkillObservation(root, '../outside'), /Invalid/)
})

test('unavailable observation storage never throws into the running workflow', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-monitor-unavailable-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(path.join(root, '.ai-dev'), 'not a directory')
  const activity = startActivity({ projectRoot: root, kind: 'script', component: 'workflow-control.mjs' })
  assert.equal(activity.available, false)
  assert.doesNotThrow(() => activity.update({ taskId: 'T1' }))
  assert.doesNotThrow(() => activity.finish(1))
})

test('installed CLI and Cursor hook record real invocations without changing stdout', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-monitor-cli-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await cp(path.join(repositoryRoot, 'template', '.ai-dev'), path.join(root, '.ai-dev'), { recursive: true })
  await cp(path.join(repositoryRoot, 'template', '.cursor'), path.join(root, '.cursor'), { recursive: true })
  await execFile('git', ['init', '-q', root])
  await writeFile(path.join(root, 'README.md'), 'fixture\n')
  await execFile('git', ['-C', root, 'add', '.'])
  await execFile('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'baseline'])
  const initialSkill = await execFile(process.execPath, ['.ai-dev/scripts/record-observation.mjs', 'start', '--skill', 'prd-to-code', '--project-root', root], { cwd: root })
  const initialSkillId = JSON.parse(initialSkill.stdout).id
  const init = await execFile(process.execPath, ['.ai-dev/scripts/init-change.mjs', '--title', '示例需求', '--id', 'REQ-1'], { cwd: root, env: { ...process.env, WORKFLOW_SKILL_RUN_ID: initialSkillId } })
  await execFile(process.execPath, ['.ai-dev/scripts/record-observation.mjs', 'finish', '--id', initialSkillId, '--project-root', root], { cwd: root })
  assert.match(init.stdout, /REQ-1/)
  const featureDir = path.join(root, '.ai-dev', 'features', 'REQ-1')
  const before = await readFile(path.join(featureDir, 'status.json'), 'utf8')
  const checks = await Promise.all(Array.from({ length: 5 }, () => execFile(process.execPath, ['.ai-dev/scripts/workflow-control.mjs', featureDir, 'inspect'], { cwd: root })))
  assert.ok(checks.every((result) => JSON.parse(result.stdout).state === 'INGEST'))
  const skill = await execFile(process.execPath, ['.ai-dev/scripts/record-observation.mjs', 'start', '--skill', 'prd-to-code', '--feature-dir', featureDir], { cwd: root })
  const skillId = JSON.parse(skill.stdout).id
  const nested = await execFile(process.execPath, ['.ai-dev/scripts/record-observation.mjs', 'start', '--skill', 'prepare-review', '--feature-dir', featureDir], { cwd: root, env: { ...process.env, WORKFLOW_SKILL_RUN_ID: skillId } })
  const nestedId = JSON.parse(nested.stdout).id
  await execFile(process.execPath, ['.ai-dev/scripts/workflow-control.mjs', featureDir, 'inspect'], { cwd: root, env: { ...process.env, WORKFLOW_SKILL_RUN_ID: nestedId } })
  const anotherFeature = path.join(root, '.ai-dev', 'features', 'REQ-2')
  await mkdir(anotherFeature, { recursive: true })
  const mismatched = await execFile(process.execPath, ['.ai-dev/scripts/record-observation.mjs', 'start', '--skill', 'prepare-review', '--feature-dir', anotherFeature], { cwd: root, env: { ...process.env, WORKFLOW_SKILL_RUN_ID: skillId } })
  const mismatchedId = JSON.parse(mismatched.stdout).id
  await execFile(process.execPath, ['.ai-dev/scripts/record-observation.mjs', 'finish', '--id', nestedId, '--project-root', root], { cwd: root })
  await execFile(process.execPath, ['.ai-dev/scripts/record-observation.mjs', 'finish', '--id', skillId, '--project-root', root], { cwd: root })
  await execFile(process.execPath, ['.ai-dev/scripts/workflow-control.mjs', featureDir, 'inspect'], { cwd: root, env: { ...process.env, WORKFLOW_SKILL_RUN_ID: nestedId } })
  const after = await readFile(path.join(featureDir, 'status.json'), 'utf8')
  assert.equal(after, before)
  const hook = await execFile(process.execPath, ['.cursor/hooks/review-visible.mjs'], { cwd: root })
  assert.equal(JSON.parse(hook.stdout).permission, 'allow')
  const recorded = await events(root)
  assert.equal(recorded.filter((item) => item.component === 'workflow-control.mjs' && item.action === 'inspect' && item.featureId === 'REQ-1').length, 7)
  assert.equal(recorded.find((item) => item.id === nestedId).parentId, skillId)
  assert.equal(recorded.find((item) => item.id === mismatchedId).parentId, null)
  assert.equal(recorded.filter((item) => item.component === 'workflow-control.mjs' && item.parentId === nestedId).length, 1)
  assert.ok(recorded.some((item) => item.component === 'init-change.mjs' && item.featureId === 'REQ-1' && item.parentId === initialSkillId && item.status === 'completed'))
  assert.ok(recorded.some((item) => item.component === 'review-visible.mjs' && item.kind === 'hook' && item.status === 'completed'))
  const gitStatus = await execFile('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root })
  assert.doesNotMatch(gitStatus.stdout, /runtime\/dashboard/)
})
