#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const EVAL_ROOT = path.join(ROOT, 'eval')

const STABLE_ENV = {
  GIT_AUTHOR_NAME: 'eval-fixture',
  GIT_AUTHOR_EMAIL: 'eval-fixture@example.com',
  GIT_AUTHOR_DATE: '2026-09-12T00:00:00Z',
  GIT_COMMITTER_NAME: 'eval-fixture',
  GIT_COMMITTER_EMAIL: 'eval-fixture@example.com',
  GIT_COMMITTER_DATE: '2026-09-12T00:00:00Z',
}

function usage() {
  console.error(
    'Usage: node eval/scripts/materialize-fixture.mjs <case-id> <target-dir> [--print-hash-only]',
  )
  process.exit(2)
}

function listFiles(dir, base = dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    if (name === '.git') continue
    const full = path.join(dir, name)
    const rel = path.relative(base, full)
    if (statSync(full).isDirectory()) listFiles(full, base, out)
    else out.push(rel)
  }
  return out
}

function treeHash(dir) {
  const files = listFiles(dir)
  const h = createHash('sha256')
  for (const rel of files) {
    h.update(rel)
    h.update('\0')
    h.update(readFileSync(path.join(dir, rel)))
    h.update('\0')
  }
  return h.digest('hex')
}

function runGit(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    env: { ...process.env, ...STABLE_ENV },
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${result.stderr || result.stdout || result.status}`,
    )
  }
  return (result.stdout || '').trim()
}

function materialize(caseId, targetDir, printHashOnly) {
  const fixtureDir = path.join(EVAL_ROOT, 'fixtures', caseId)
  const casePath = path.join(EVAL_ROOT, 'cases', caseId, 'case.json')
  if (!existsSync(fixtureDir)) {
    throw new Error(`Missing fixture: ${fixtureDir}`)
  }
  if (!existsSync(casePath)) {
    throw new Error(`Missing case.json: ${casePath}`)
  }

  const caseMeta = JSON.parse(readFileSync(casePath, 'utf8'))
  const staging = `${targetDir}.__staging__`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  cpSync(fixtureDir, staging, { recursive: true })

  runGit(staging, ['init', '--template='])
  runGit(staging, ['checkout', '-b', 'main'])
  runGit(staging, ['add', '.'])
  runGit(staging, ['commit', '-m', `eval fixture ${caseId}`])
  const commit = runGit(staging, ['rev-parse', 'HEAD'])
  const contentHash = treeHash(staging)

  if (printHashOnly) {
    rmSync(staging, { recursive: true, force: true })
    console.log(
      JSON.stringify(
        {
          caseId,
          repositoryBase: commit,
          contentHash,
          expectedRepositoryBase: caseMeta.repositoryBase,
          match: commit === caseMeta.repositoryBase,
        },
        null,
        2,
      ),
    )
    return
  }

  if (caseMeta.repositoryBase && caseMeta.repositoryBase !== commit) {
    rmSync(staging, { recursive: true, force: true })
    throw new Error(
      `repositoryBase mismatch for ${caseId}: case.json has ${caseMeta.repositoryBase}, materialized ${commit}. Re-run with --print-hash-only and update case.json.`,
    )
  }

  rmSync(targetDir, { recursive: true, force: true })
  mkdirSync(path.dirname(targetDir), { recursive: true })
  cpSync(staging, targetDir, { recursive: true })
  rmSync(staging, { recursive: true, force: true })

  const manifest = {
    caseId,
    repositoryBase: commit,
    contentHash,
    materializedAt: new Date().toISOString(),
    sourceFixture: path.relative(ROOT, fixtureDir),
  }
  writeFileSync(path.join(targetDir, '.eval-materialized.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  console.log(JSON.stringify(manifest, null, 2))
}

const [, , caseId, targetDir, flag] = process.argv
if (!caseId || (!targetDir && flag !== '--print-hash-only')) usage()
if (flag === '--print-hash-only' || targetDir === '--print-hash-only') {
  materialize(caseId, path.join(os.tmpdir(), `eval-hash-${caseId}`), true)
} else {
  materialize(caseId, path.resolve(targetDir), false)
}
