import { mkdtemp, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { createFeatureWorkspace } from '../../template/.ai-dev/scripts/init-change.mjs'
import { digest, writeJsonAtomic } from '../../template/.ai-dev/scripts/lib/acceptance.mjs'

export const manualReason = { category: 'human-judgment', reason: 'Human copy judgment in a protocol fixture', sourceRefs: ['prd.md'] }
export function observedEvidence(tc, confirmationRef = 'test-message-1') {
  return {
    preconditionResults: tc.preconditions.map((_, index) => ({ index, result: 'met', observation: 'Synthetic protocol precondition, not business evidence' })),
    expectationResults: tc.expectations.map(e => ({ id: e.id, result: 'passed', observation: 'Synthetic protocol assertion, not business evidence', evidenceRefs: ['app.js'] })),
    ...(tc.method === 'manual' ? { confirmation: { kind: 'acceptance', actor: 'simulated-human', sourceRef: confirmationRef, quote: 'Protocol fixture confirms all declared expectations', caseId: tc.id, expectationIds: tc.expectations.map(e => e.id) } } : {}),
  }
}

// Protocol fixtures explicitly use inspection. These are not browser acceptance claims.
export function inspectionDelivery(old) {
  const delivery = structuredClone(old)
  delivery.schemaVersion = 2
  delivery.acceptance.forEach((ac) => { ac.verification = 'inspection' })
  delivery.testCases = delivery.acceptance.map((ac) => ({ id: `TC-${ac.id}`, acceptanceIds: [ac.id], method: 'inspection', environmentId: 'local', requiredAt: ['feature'], preconditions: [ac.given], steps: [ac.when], expectations: [{ id: 'E1', observable: 'document', expected: ac.then }] }))
  delivery.verification = { inputs: [{ space: 'feature', path: 'artifacts/analysis/intake.json' }], environments: [{ id: 'local', kind: 'local', setup: 'Existing protocol fixture', reset: 'New temporary project per test', inputs: [delivery.tasks[0].files[0].path] }], checks: [], finalCheckIds: [] }
  for (const task of delivery.tasks) {
    task.verifyIds = (task.verify || []).map((check, index) => {
      const id = `${task.id}-CHECK-${index}`
      delivery.verification.checks.push({ ...check, id, kind: 'engineering', environmentId: 'local', caseIds: [] })
      delivery.verification.finalCheckIds.push(id)
      return id
    })
    delete task.verify
  }
  return delivery
}

export function playwrightReport(root, ids = ['TC-1'], overrides = {}) {
  return {
    config: { rootDir: root }, errors: [],
    suites: [{ title: 'cases', specs: ids.map((id) => ({ title: `[${id}] behavior`, file: 'tests/cases.spec.mjs', tests: [{
      projectName: 'mock', expectedStatus: 'passed', status: 'expected', annotations: [],
      results: [{ status: 'passed', retry: 0, attachments: [{ name: 'acceptance-context', contentType: 'application/json', body: Buffer.from(JSON.stringify({ environmentId: 'mock', baseURL: 'http://127.0.0.1:3000', mockedRoutes: ['profile'], mockHits: { profile: 1 }, preconditionResults: [{ index: 0, result: 'met', observation: 'Synthetic fixture' }], expectationResults: [{ id: 'E1', result: 'passed', observation: 'Synthetic reporter assertion' }] })).toString('base64') }], ...overrides }],
    }] })) }],
  }
}

export async function acceptanceFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-acceptance-'))
  await cp(new URL('../../template/.ai-dev', import.meta.url), path.join(root, '.ai-dev'), { recursive: true })
  await mkdir(path.join(root, 'tests'), { recursive: true })
  for (const [name, contents] of Object.entries({ 'app.js': 'export const result = true\n', 'prd.md': 'Show response; errors permit retry.', 'contract.json': '{"name":"string"}', 'fixture.json': '{"name":"Ada"}', 'tests/cases.spec.mjs': '// synthetic reporter fixture; not a browser test\n' })) await writeFile(path.join(root, name), contents)
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.com'], ['add', '.'], ['commit', '-m', 'fixture']]) execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  const featureDir = await createFeatureWorkspace(root, { id: 'REQ-ACCEPTANCE', idSource: 'user', title: 'Acceptance protocol' })
  const intake = { schemaVersion: 1, sources: [{ id: 'S1', kind: 'prd', locator: 'prd.md', version: '1', availability: 'available', contentHash: null }], evidence: [{ id: 'E1', claim: 'Show response', label: 'CONFIRMED', sourceId: 'S1', location: 'line 1' }], requirements: [{ id: 'FR-1', statement: 'Show response', evidenceIds: ['E1'], ownership: 'FRONTEND_BEHAVIOR', disposition: 'included' }], questions: [] }
  const report = playwrightReport(root)
  // This process only exercises report ingestion. Browser semantics are tested by eval/acceptance.
  const command = { command: process.execPath, args: ['-e', `require('fs').writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, ${JSON.stringify(JSON.stringify(report))})`] }
  const delivery = {
    schemaVersion: 2,
    acceptance: [{ id: 'AC-1', requirementIds: ['FR-1'], given: 'profile response', when: 'load', then: 'display profile', verification: 'test' }],
    tasks: [{ id: 'T1', title: 'Profile', requirementIds: ['FR-1'], acceptanceIds: ['AC-1'], dependsOn: [], files: [{ path: 'app.js', operation: 'modify' }], steps: ['implement profile'], verifyIds: ['browser', 'lint'] }],
    links: [{ requirementId: 'FR-1', acceptanceId: 'AC-1', taskId: 'T1' }],
    testCases: [{ id: 'TC-1', acceptanceIds: ['AC-1'], method: 'browser', environmentId: 'mock', requiredAt: ['feature', 'task:T1'], preconditions: ['profile fixture'], steps: ['click load'], expectations: [{ id: 'E1', observable: 'ui', expected: 'Ada is displayed' }], dataRef: 'fixture.json', mockRuleIds: ['profile'], implementation: { file: 'tests/cases.spec.mjs', testId: 'TC-1' } }],
    verification: {
      inputs: [{ space: 'project', path: 'prd.md' }],
      environments: [{ id: 'mock', kind: 'contract-mock', baseURL: 'http://127.0.0.1:3000', projectName: 'mock', setup: 'temporary fixture', reset: 'new fixture', inputs: ['fixture.json'], contract: { path: 'contract.json', sha256: digest(await readFile(path.join(root, 'contract.json'))) }, mocks: [{ id: 'profile', method: 'GET', url: '/api/profile', fixture: 'fixture.json' }] }],
      checks: [{ id: 'browser', kind: 'acceptance', environmentId: 'mock', report: 'playwright-json', caseIds: ['TC-1'], ...command }, { id: 'lint', kind: 'engineering', environmentId: 'mock', caseIds: [], command: process.execPath, args: ['-e', 'process.exit(0)'] }],
      finalCheckIds: ['browser', 'lint'],
    },
  }
  await writeJsonAtomic(path.join(featureDir, 'artifacts/analysis/intake.json'), intake)
  await writeJsonAtomic(path.join(featureDir, 'artifacts/design/delivery.json'), delivery)
  const status = JSON.parse(await readFile(path.join(featureDir, 'status.json'), 'utf8'))
  status.state = 'VERIFYING'
  status.runtime.taskResults.T1 = { status: 'passed', reviewStatus: 'passed', attemptId: 'A1' }
  await writeJsonAtomic(path.join(featureDir, 'status.json'), status)
  return { root, featureDir, delivery, intake, report }
}
