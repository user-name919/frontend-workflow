import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { ConflictError, runCli } from '../src/installer.mjs'

async function makeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'frontend-work-flow-test-'))
  const packageRoot = path.join(root, 'package')
  const homeDir = path.join(root, 'home')
  const projectDir = path.join(root, 'project')

  await mkdir(path.join(packageRoot, '.agents/skills/prd-to-code'), { recursive: true })
  await mkdir(path.join(packageRoot, '.agents/skills/frontend-review'), { recursive: true })
  await mkdir(path.join(packageRoot, 'template/.ai-dev'), { recursive: true })
  await mkdir(path.join(packageRoot, 'template/.cursor/rules'), { recursive: true })
  await mkdir(homeDir, { recursive: true })
  await mkdir(projectDir, { recursive: true })

  await writeFile(path.join(packageRoot, '.agents/skills/prd-to-code/SKILL.md'), 'global skill\n')
  await writeFile(path.join(packageRoot, '.agents/skills/frontend-review/SKILL.md'), 'review skill\n')
  await writeFile(path.join(packageRoot, 'template/.ai-dev/workflow.md'), 'workflow\n')
  await writeFile(path.join(packageRoot, 'template/.cursor/rules/prd-to-code.mdc'), 'rule\n')

  return { packageRoot, homeDir, projectDir }
}

test('install copies every packaged skill into the cross-agent user directory', async () => {
  const fixture = await makeFixture()

  const result = await runCli(['install'], fixture)

  assert.equal(
    await readFile(path.join(fixture.homeDir, '.agents/skills/prd-to-code/SKILL.md'), 'utf8'),
    'global skill\n'
  )
  assert.equal(
    await readFile(path.join(fixture.homeDir, '.agents/skills/frontend-review/SKILL.md'), 'utf8'),
    'review skill\n'
  )
  assert.deepEqual(result.copied, [
    '.agents/skills/frontend-review/SKILL.md',
    '.agents/skills/prd-to-code/SKILL.md'
  ])
})

test('setup copies workflow, Cursor rule, and every project skill', async () => {
  const fixture = await makeFixture()

  await runCli(['setup', fixture.projectDir], fixture)

  assert.equal(await readFile(path.join(fixture.projectDir, '.ai-dev/workflow.md'), 'utf8'), 'workflow\n')
  assert.equal(await readFile(path.join(fixture.projectDir, '.cursor/rules/prd-to-code.mdc'), 'utf8'), 'rule\n')
  assert.equal(
    await readFile(path.join(fixture.projectDir, '.agents/skills/prd-to-code/SKILL.md'), 'utf8'),
    'global skill\n'
  )
  assert.equal(
    await readFile(path.join(fixture.projectDir, '.agents/skills/frontend-review/SKILL.md'), 'utf8'),
    'review skill\n'
  )
})

test('setup includes the local dashboard and recorder in a business project', async (t) => {
  const fixture = await makeFixture()
  t.after(() => rm(path.dirname(fixture.packageRoot), { recursive: true, force: true }))
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  await runCli(['setup', fixture.projectDir], { ...fixture, packageRoot })
  assert.match(await readFile(path.join(fixture.projectDir, '.ai-dev/dashboard/index.html'), 'utf8'), /工作流看板/)
  assert.match(await readFile(path.join(fixture.projectDir, '.ai-dev/dashboard/catalog.json'), 'utf8'), /运行项目验证/)
  assert.match(await readFile(path.join(fixture.projectDir, '.ai-dev/scripts/dashboard.mjs'), 'utf8'), /127\.0\.0\.1/)
  assert.match(await readFile(path.join(fixture.projectDir, '.ai-dev/scripts/lib/monitor-events.mjs'), 'utf8'), /startActivity/)
  assert.ok((await readFile(path.join(fixture.projectDir, '.ai-dev/dashboard/vendor/markdown-it.min.js'))).length > 1000)
  assert.ok((await readFile(path.join(fixture.projectDir, '.ai-dev/dashboard/vendor/mermaid.min.js'))).length > 1000)
})

test('setup aborts before writing when any destination file conflicts', async () => {
  const fixture = await makeFixture()
  await mkdir(path.join(fixture.projectDir, '.cursor/rules'), { recursive: true })
  await writeFile(path.join(fixture.projectDir, '.cursor/rules/prd-to-code.mdc'), 'employee rule\n')

  await assert.rejects(
    runCli(['setup', fixture.projectDir], fixture),
    error => error instanceof ConflictError && error.paths.includes('.cursor/rules/prd-to-code.mdc')
  )
  await assert.rejects(readFile(path.join(fixture.projectDir, '.ai-dev/workflow.md'), 'utf8'))
  assert.equal(
    await readFile(path.join(fixture.projectDir, '.cursor/rules/prd-to-code.mdc'), 'utf8'),
    'employee rule\n'
  )
})

test('setup --force backs up and replaces conflicting files', async () => {
  const fixture = await makeFixture()
  await mkdir(path.join(fixture.projectDir, '.cursor/rules'), { recursive: true })
  await writeFile(path.join(fixture.projectDir, '.cursor/rules/prd-to-code.mdc'), 'employee rule\n')

  const result = await runCli(['setup', fixture.projectDir, '--force'], {
    ...fixture,
    now: () => new Date('2026-09-01T10:20:30.000Z')
  })

  const backup = path.join(
    fixture.projectDir,
    '.frontend-work-flow-backups/20260901T102030Z/.cursor/rules/prd-to-code.mdc'
  )
  assert.equal(await readFile(backup, 'utf8'), 'employee rule\n')
  assert.equal(await readFile(path.join(fixture.projectDir, '.cursor/rules/prd-to-code.mdc'), 'utf8'), 'rule\n')
  assert.deepEqual(result.backups, ['.cursor/rules/prd-to-code.mdc'])
})

test('setup --force refuses to replace a directory with a packaged file', async () => {
  const fixture = await makeFixture()
  await mkdir(path.join(fixture.projectDir, '.ai-dev/workflow.md'), { recursive: true })

  await assert.rejects(
    runCli(['setup', fixture.projectDir, '--force'], fixture),
    error => error instanceof ConflictError && error.paths.includes('.ai-dev/workflow.md')
  )
})

test('doctor reports the runtime and both required asset roots', async () => {
  const fixture = await makeFixture()
  const lines = []

  const result = await runCli(['doctor'], {
    ...fixture,
    stdout: line => lines.push(line)
  })

  assert.equal(result.ok, true)
  assert.match(lines.join('\n'), /Node\.js/)
  assert.match(lines.join('\n'), /packaged skills: 2 OK/)
  assert.match(lines.join('\n'), /project template assets: OK/)
})

test('doctor fails when a packaged skill has no SKILL.md', async () => {
  const fixture = await makeFixture()
  await mkdir(path.join(fixture.packageRoot, '.agents/skills/incomplete'), { recursive: true })
  const lines = []

  const result = await runCli(['doctor'], {
    ...fixture,
    stdout: line => lines.push(line)
  })

  assert.equal(result.ok, false)
  assert.match(lines.join('\n'), /incomplete: MISSING SKILL\.md/)
})
