import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'

import { evaluateGate } from '../template/.ai-dev/scripts/lib/gates.mjs'
import { createFeatureWorkspace } from '../template/.ai-dev/scripts/init-change.mjs'

const execFile = promisify(execFileCallback)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const validateScript = path.join(repositoryRoot, 'template/.ai-dev/scripts/validate-change.mjs')

async function git(cwd, ...args) {
  return execFile('git', args, { cwd })
}

async function makeProjectFeature() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'frontend-work-flow-gate-'))
  await cp(path.join(repositoryRoot, 'template/.ai-dev'), path.join(projectRoot, '.ai-dev'), { recursive: true })
  await mkdir(path.join(projectRoot, 'src'), { recursive: true })
  await writeFile(path.join(projectRoot, 'src/retry.js'), 'export const retry = true\n')
  await git(projectRoot, 'init', '-b', 'main')
  await git(projectRoot, 'config', 'user.name', 'Test User')
  await git(projectRoot, 'config', 'user.email', 'test@example.com')
  await git(projectRoot, 'add', '.')
  await git(projectRoot, 'commit', '-m', 'initial')
  const featureDir = await createFeatureWorkspace(projectRoot, {
    id: 'REQ-GATE',
    idSource: 'user',
    title: 'Gate fixture',
  })
  return { projectRoot, featureDir }
}

function validIntake() {
  return {
    schemaVersion: 1,
    sources: [
      {
        id: 'SRC-1',
        kind: 'prd',
        locator: 'inputs/prd.md',
        version: '1',
        contentHash: null,
        availability: 'available',
      },
    ],
    evidence: [
      {
        id: 'EV-1',
        claim: '失败可重试',
        label: 'CONFIRMED',
        sourceId: 'SRC-1',
        location: '§1',
      },
    ],
    requirements: [
      {
        id: 'FR-1',
        statement: '展示重试',
        evidenceIds: ['EV-1'],
        ownership: 'FRONTEND_BEHAVIOR',
        disposition: 'included',
      },
    ],
    questions: [],
  }
}

function validTechScheme(ids = ['FR-1']) {
  return [
    '# 技术方案',
    '',
    ...ids.map((id) => `### ${id}\n失败后展示重试。`),
    '',
    '```mermaid',
    'flowchart TD',
    '  fail[失败] --> retry[重试]',
    '```',
    '',
    '```mermaid',
    'sequenceDiagram',
    '  User->>Page: 点击重试',
    '  Page->>API: 再请求',
    '```',
    '',
  ].join('\n')
}

function validDelivery() {
  return {
    schemaVersion: 1,
    acceptance: [
      {
        id: 'AC-1',
        requirementIds: ['FR-1'],
        given: '失败',
        when: '重试',
        then: '再请求',
        verification: 'test',
      },
    ],
    tasks: [
      {
        id: 'T1',
        title: '实现重试',
        requirementIds: ['FR-1'],
        acceptanceIds: ['AC-1'],
        dependsOn: [],
        files: [{ path: 'src/retry.js', operation: 'modify' }],
        steps: ['add retry'],
        verify: [{ command: 'node', args: ['--test'], cwd: '.' }],
      },
    ],
    links: [{ requirementId: 'FR-1', acceptanceId: 'AC-1', taskId: 'T1' }],
  }
}

test('initialized placeholder workspace fails scope gate; empty patch is fine at INGEST', async () => {
  const { featureDir } = await makeProjectFeature()
  const scope = await evaluateGate(featureDir, 'scope')
  assert.equal(scope.ok, false)
  assert.ok(scope.errors.some((e) => e.code === 'EMPTY_INTAKE' || e.code === 'PLACEHOLDER_SCOPE'))

  const status = JSON.parse(await readFile(path.join(featureDir, 'status.json'), 'utf8'))
  assert.equal(status.state, 'INGEST')
  assert.equal(await readFile(path.join(featureDir, 'artifacts/coding-changes/changes.patch'), 'utf8'), '')
})

test('scope gate positive and negative cases', async () => {
  const { featureDir } = await makeProjectFeature()
  await writeFile(path.join(featureDir, 'artifacts/analysis/intake.json'), `${JSON.stringify(validIntake(), null, 2)}\n`)
  await writeFile(path.join(featureDir, 'artifacts/analysis/scope.md'), '# Scope\n\nFrontend owns retry UX.\n')

  const ok = await evaluateGate(featureDir, 'scope')
  assert.equal(ok.ok, true)

  // blocking question
  const blockedIntake = validIntake()
  blockedIntake.questions = [
    {
      id: 'Q1',
      text: 'Which env?',
      blocking: true,
      owner: 'Product',
      status: 'open',
      blocksGates: ['scope'],
      decisionEvidenceIds: [],
    },
  ]
  await writeFile(path.join(featureDir, 'artifacts/analysis/intake.json'), `${JSON.stringify(blockedIntake, null, 2)}\n`)
  const blocked = await evaluateGate(featureDir, 'scope')
  assert.ok(blocked.errors.some((e) => e.code === 'BLOCKING_QUESTION'))

  // unknown ownership
  const unknown = validIntake()
  unknown.requirements[0].ownership = 'UNKNOWN'
  await writeFile(path.join(featureDir, 'artifacts/analysis/intake.json'), `${JSON.stringify(unknown, null, 2)}\n`)
  const ownership = await evaluateGate(featureDir, 'scope')
  assert.ok(ownership.errors.some((e) => e.code === 'UNKNOWN_OWNERSHIP'))

  // placeholder scope
  await writeFile(path.join(featureDir, 'artifacts/analysis/intake.json'), `${JSON.stringify(validIntake(), null, 2)}\n`)
  await writeFile(path.join(featureDir, 'artifacts/analysis/scope.md'), '# Scope\n\n[TODO]\n')
  const placeholder = await evaluateGate(featureDir, 'scope')
  assert.ok(placeholder.errors.some((e) => e.code === 'PLACEHOLDER_SCOPE'))
})

test('spec and plan gates require delivery coverage; final needs execution evidence', async () => {
  const { featureDir, projectRoot } = await makeProjectFeature()
  await writeFile(path.join(featureDir, 'artifacts/analysis/intake.json'), `${JSON.stringify(validIntake(), null, 2)}\n`)
  await writeFile(path.join(featureDir, 'artifacts/analysis/scope.md'), '# Scope\n\nFrontend retry.\n')
  await writeFile(path.join(featureDir, 'artifacts/design/frontend-spec.md'), validTechScheme())
  await writeFile(path.join(featureDir, 'artifacts/design/implementation-plan.md'), '# Plan\n\nModify request helper.\n')

  // spec without acceptance coverage
  await writeFile(
    path.join(featureDir, 'artifacts/design/delivery.json'),
    `${JSON.stringify({ schemaVersion: 1, acceptance: [], tasks: [], links: [] }, null, 2)}\n`,
  )
  const specNeg = await evaluateGate(featureDir, 'spec')
  assert.ok(specNeg.errors.some((e) => e.code === 'REQUIREMENT_UNCOVERED'))

  await writeFile(path.join(featureDir, 'artifacts/design/delivery.json'), `${JSON.stringify(validDelivery(), null, 2)}\n`)
  await writeFile(path.join(featureDir, 'artifacts/design/frontend-spec.md'), '# Spec\n\nFR-1 retry without diagrams.\n')
  const specNoDiagram = await evaluateGate(featureDir, 'spec')
  assert.equal(specNoDiagram.ok, false)
  assert.ok(specNoDiagram.errors.some((e) => e.code === 'MISSING_FLOWCHART'))
  assert.ok(specNoDiagram.errors.some((e) => e.code === 'MISSING_SEQUENCE'))

  await writeFile(path.join(featureDir, 'artifacts/design/frontend-spec.md'), validTechScheme())
  const specOk = await evaluateGate(featureDir, 'spec')
  assert.equal(specOk.ok, true)

  const planOk = await evaluateGate(featureDir, 'plan')
  assert.equal(planOk.ok, true)

  // plan placeholder
  await writeFile(path.join(featureDir, 'artifacts/design/implementation-plan.md'), '# Plan\n\n[TODO]\n')
  const planNeg = await evaluateGate(featureDir, 'plan')
  assert.ok(planNeg.errors.some((e) => e.code === 'PLACEHOLDER_PLAN'))
  await writeFile(path.join(featureDir, 'artifacts/design/implementation-plan.md'), '# Plan\n\nModify request helper.\n')

  // false task path
  const badDelivery = validDelivery()
  badDelivery.tasks[0].files = [{ path: 'src/nope.js', operation: 'modify' }]
  await writeFile(path.join(featureDir, 'artifacts/design/delivery.json'), `${JSON.stringify(badDelivery, null, 2)}\n`)
  const planMissingFile = await evaluateGate(featureDir, 'plan')
  assert.ok(planMissingFile.errors.some((e) => e.code === 'MISSING_FILE_EVIDENCE'))
  await writeFile(path.join(featureDir, 'artifacts/design/delivery.json'), `${JSON.stringify(validDelivery(), null, 2)}\n`)

  const final = await evaluateGate(featureDir, 'final')
  assert.equal(final.ok, false)
  assert.ok(final.errors.some((e) => e.code === 'MISSING_EXECUTION_EVIDENCE'))
  assert.ok(projectRoot)
})

test('validate-change --gate --json reports structured failures', async () => {
  const { featureDir } = await makeProjectFeature()
  const result = await execFile('node', [validateScript, featureDir, '--gate', 'scope', '--json'])
    .then((value) => ({ code: 0, stdout: value.stdout }))
    .catch((error) => ({ code: error.code, stdout: error.stdout }))
  assert.equal(result.code, 1)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.ok, false)
  assert.ok(payload.gate)
})

test('NEEDS_STRUCTURED_IMPORT blocks gates after migration marker', async () => {
  const { featureDir } = await makeProjectFeature()
  const statusPath = path.join(featureDir, 'status.json')
  const status = JSON.parse(await readFile(statusPath, 'utf8'))
  status.control.artifactStatus = 'NEEDS_STRUCTURED_IMPORT'
  await writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`)
  await writeFile(path.join(featureDir, 'artifacts/analysis/intake.json'), `${JSON.stringify(validIntake(), null, 2)}\n`)
  await writeFile(path.join(featureDir, 'artifacts/analysis/scope.md'), '# Scope\n\nReady.\n')
  const result = await evaluateGate(featureDir, 'scope')
  assert.ok(result.errors.some((e) => e.code === 'NEEDS_STRUCTURED_IMPORT'))
})
