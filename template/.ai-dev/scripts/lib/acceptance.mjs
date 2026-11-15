/** Shared, read-only admission checks for tasks, final review and completion. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { validateDelivery } from './delivery.mjs'
import { captureSnapshot, readSnapshot, verifySnapshot } from './snapshots.mjs'
import { readFeature, mutateFeature, StoreError } from './workspace-store.mjs'
import { readEvidenceFile, readPlaywrightReport } from './verification-report.mjs'
import { markArtifactChanged, resolveArtifacts } from '../update-consistency.mjs'
import { recordArtifactDigest } from './consistency.mjs'

export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
export const jsonBytes = (value) => `${JSON.stringify(value, null, 2)}\n`
export async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  await writeFile(temp, jsonBytes(value))
  await rename(temp, file)
}

export async function loadAcceptance(featureDir) {
  const [status, intake, delivery] = await Promise.all([
    readFeature(featureDir),
    readFile(path.join(featureDir, 'artifacts/analysis/intake.json'), 'utf8').then(JSON.parse),
    readFile(path.join(featureDir, 'artifacts/design/delivery.json'), 'utf8').then(JSON.parse),
  ])
  return { status, intake, delivery }
}

export async function captureVerificationSnapshot(featureDir, delivery, { taskId = null } = {}) {
  const status = await readFeature(featureDir)
  const inputs = [
    { space: 'feature', path: 'artifacts/analysis/intake.json' },
    { space: 'feature', path: 'artifacts/design/delivery.json' },
    ...(delivery.verification?.inputs || []),
  ]
  const checks = delivery.verification?.checks || []
  const selectedChecks = taskId ? checks.filter((check) => delivery.tasks.find((task) => task.id === taskId)?.verifyIds?.includes(check.id)) : checks
  const selectedCases = taskId ? (delivery.testCases || []).filter((tc) => tc.requiredAt.includes(`task:${taskId}`) || selectedChecks.some((check) => check.caseIds?.includes(tc.id))) : delivery.testCases || []
  const selectedEnvironments = (delivery.verification?.environments || []).filter((env) => !taskId || selectedChecks.some((check) => check.environmentId === env.id) || selectedCases.some((tc) => tc.environmentId === env.id))
  for (const environment of selectedEnvironments) {
    for (const file of [...(environment.inputs || []), environment.contract?.path, ...(environment.mocks || []).map((mock) => mock.fixture)].filter(Boolean)) inputs.push({ space: 'project', path: file })
    if (environment.contract) {
      const bytes = await readEvidenceFile(status.project.root, environment.contract.path)
      if (digest(bytes) !== environment.contract.sha256) throw new StoreError('CONTRACT_CHANGED', `${environment.id}: contract differs from confirmed digest`)
    }
  }
  for (const tc of selectedCases) {
    for (const file of [tc.implementation?.file, tc.dataRef].filter(Boolean)) inputs.push({ space: 'project', path: file })
  }
  if (delivery.schemaVersion === 1) {
    for (const file of delivery.tasks?.find((task) => task.id === taskId)?.files || []) inputs.push({ space: 'project', path: file.path })
  }
  const unique = [...new Map(inputs.map((input) => [`${input.space}:${input.path}`, { ...input, freshness: 'live' }])).values()]
  const snapshot = await captureSnapshot(featureDir, { gate: 'verification', taskId, inputs: unique, includeProjectDigest: true })
  if (!snapshot.projectDigest) throw new StoreError('PROJECT_DIGEST_UNAVAILABLE', 'Verification requires a Git project')
  const missing = snapshot.inputs.filter((input) => !input.exists)
  if (delivery.schemaVersion === 2 && missing.length) throw new StoreError('MISSING_TEST_INPUT', missing.map((input) => input.path).join(', '))
  return snapshot
}

/** Validate bytes, run identity, raw results and freshness again at consumption time. */
export async function validateVerificationRecord(featureDir, ref, delivery, { recover = false } = {}) {
  try {
    const bytes = await readEvidenceFile(featureDir, ref.recordRef)
    if (!recover && digest(bytes) !== ref.recordDigest) throw new Error('record bytes differ from ledger')
    const record = JSON.parse(bytes)
    if (record.schemaVersion !== 2 || record.id !== ref.id || record.checkId !== ref.checkId || record.scope !== ref.scope || record.taskId !== ref.taskId || record.attemptId !== ref.attemptId) throw new Error('wrong run identity or legacy record')
    if (record.status !== 'passed' || record.exitCode !== 0 || record.timedOut) return { ok: false, record, reason: record.status || 'interrupted' }
    const snapshotBytes = await readEvidenceFile(featureDir, `revisions/snapshots/${record.inputSnapshotId}.json`)
    if (digest(snapshotBytes) !== record.snapshotDigest) throw new Error('snapshot bytes changed')
    const snapshot = JSON.parse(snapshotBytes)
    if (!snapshot.projectDigest || !(await verifySnapshot(featureDir, snapshot)).fresh) return { ok: false, record, reason: 'stale' }
    const check = delivery.verification.checks.find((item) => item.id === record.checkId)
    if (!check || check.environmentId !== record.environmentId) throw new Error('unknown check/environment')
    if (!record.files?.length || !record.files.some((file) => file.path === record.stdoutPath) || !record.files.some((file) => file.path === record.stderrPath)) throw new Error('missing output fingerprints')
    for (const file of record.files) {
      if (digest(await readEvidenceFile(featureDir, file.path)) !== file.sha256) throw new Error(`evidence changed: ${file.path}`)
    }
    if (check.kind === 'acceptance') {
      if (!record.files.some((file) => file.path === record.rawReportPath)) throw new Error('raw report fingerprint missing')
      const report = JSON.parse(await readEvidenceFile(featureDir, record.rawReportPath))
      const parsed = await readPlaywrightReport(report, {
        check, cases: delivery.testCases,
        environment: delivery.verification.environments.find((env) => env.id === check.environmentId),
        projectRoot: (await readFeature(featureDir)).project.root,
        outputDir: path.dirname(path.join(featureDir, record.rawReportPath)),
      })
      if (parsed.errors.length) throw new Error(parsed.errors.join('; '))
      for (const file of parsed.evidencePaths) {
        const relative = path.join(path.dirname(record.rawReportPath), file)
        if (!record.files.some((item) => item.path === relative)) throw new Error(`attachment fingerprint missing: ${file}`)
      }
      if (JSON.stringify(parsed.cases) !== JSON.stringify(record.cases)) throw new Error('case summary differs from raw report')
    }
    return { ok: true, record }
  } catch (error) {
    return { ok: false, reason: `invalid_evidence: ${error.message}` }
  }
}

export async function acceptanceReadiness(featureDir, options = {}) {
  const { status, intake, delivery } = await loadAcceptance(featureDir)
  const errors = []
  const add = (code, message) => errors.push({ code, ruleId: code, message })
  const scope = options.scope || 'feature'
  const task = scope === 'task' ? delivery.tasks.find((item) => item.id === options.taskId) : null
  if (delivery.schemaVersion !== 2) return { ok: false, errors: [{ code: 'ACCEPTANCE_MIGRATION_REQUIRED', message: 'delivery v1 is historical command evidence; prepare and review a v2 upgrade' }], checks: [], cases: [] }
  const validation = validateDelivery(intake, delivery, { phase: 'plan' })
  if (!validation.ok) return { ok: false, errors: validation.errors, checks: [], cases: [] }
  if (scope === 'task' && !task) add('UNKNOWN_TASK', options.taskId)
  const requiredIds = scope === 'task' ? task?.verifyIds || [] : delivery.verification.finalCheckIds
  const checks = []
  const refs = Object.values(status.runtime?.verifications || {})
  for (const id of requiredIds) {
    const candidates = refs.filter((ref) => ref.schemaVersion === 2 && ref.checkId === id && ref.scope === scope && (scope !== 'task' || ref.taskId === options.taskId))
    candidates.sort((a, b) => b.sequence - a.sequence)
    const latest = candidates[0]
    let result
    if (!latest) result = { ok: false, reason: 'not_run' }
    else if (scope === 'task' && latest.attemptId !== options.attemptId) result = { ok: false, reason: 'wrong_attempt' }
    else if (options.verificationIds && !options.verificationIds.includes(latest.id)) result = { ok: false, reason: 'latest_run_not_submitted' }
    else result = await validateVerificationRecord(featureDir, latest, delivery)
    const repair = status.runtime?.verificationRepairs?.[`${scope}:${scope === 'task' ? options.taskId : 'feature'}:${id}`]
    checks.push({ checkId: id, runId: latest?.id || null, status: result.ok ? 'passed' : result.reason, cases: result.record?.cases || [], rawReportPath: result.record?.rawReportPath || null, repair: repair || null })
    if (!result.ok) add('ACCEPTANCE_NOT_READY', `${id}: ${result.reason}`)
  }
  const cases = []
  for (const tc of delivery.testCases.filter((item) => item.requiredAt.includes(scope === 'task' ? `task:${options.taskId}` : 'feature'))) {
    if (tc.method === 'browser') {
      const owner = checks.find((check) => check.status === 'passed' && check.cases.some((item) => item.caseId === tc.id))
      cases.push({ caseId: tc.id, environmentId: tc.environmentId, method: tc.method, status: owner ? 'passed' : 'not_verified', runId: owner?.runId || null })
      if (!owner) add('CASE_NOT_VERIFIED', tc.id)
      continue
    }
    const ref = status.runtime?.caseEvidence?.[tc.id]
    let valid = false
    let record
    try {
      const bytes = await readEvidenceFile(featureDir, ref?.recordRef)
      record = JSON.parse(bytes)
      const snapshot = await readSnapshot(featureDir, record.snapshotId)
      valid = digest(bytes) === ref.recordDigest && record.caseId === tc.id && record.method === tc.method && record.result === 'passed' && (await verifySnapshot(featureDir, snapshot)).fresh
      if (tc.method === 'manual') valid &&= Boolean(record.confirmationRef)
    } catch { /* Missing manual/inspection evidence stays pending. */ }
    cases.push({ caseId: tc.id, environmentId: tc.environmentId, method: tc.method, status: valid ? 'passed' : 'pending', recordRef: ref?.recordRef || null })
    if (!valid && (tc.method !== 'manual' || options.includeManual !== false)) add('CASE_EVIDENCE_REQUIRED', tc.id)
  }
  return { ok: errors.length === 0, scope, checks, cases, errors }
}

export async function assertAcceptanceReady(featureDir, options) {
  const result = await acceptanceReadiness(featureDir, options)
  if (!result.ok) {
    const error = new StoreError('ACCEPTANCE_NOT_READY', result.errors.map((item) => `${item.code}: ${item.message}`).join('; '))
    error.errors = result.errors
    throw error
  }
  return result
}

export async function refreshAcceptanceResults(featureDir) {
  const summary = await acceptanceReadiness(featureDir)
  const dir = path.join(featureDir, 'artifacts/verification')
  const summaryValue = { schemaVersion: 2, ...summary }
  const cell = (value) => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ')
  const lines = ['# Requirement acceptance', '', 'Derived view; gates re-read original run evidence.', '', '| Case | Environment | Method | Result | Evidence |', '| --- | --- | --- | --- | --- |', ...summary.cases.map((tc) => `| ${[tc.caseId, tc.environmentId, tc.method, tc.status, tc.runId || tc.recordRef].map(cell).join(' | ')} |`), '', '| Check | Latest feature run | Result |', '| --- | --- | --- |', ...summary.checks.map((check) => `| ${[check.checkId, check.runId, check.status].map(cell).join(' | ')} |`), '', ...summary.errors.map((error) => `- ${cell(error.code)}: ${cell(error.message)}`), '']
  const markdown = lines.join('\n')
  const previousJson = await readFile(path.join(dir, 'acceptance-results.json'), 'utf8').catch(() => null)
  const previousMarkdown = await readFile(path.join(dir, 'verification.md'), 'utf8').catch(() => null)
  if (previousJson === jsonBytes(summaryValue) && previousMarkdown === markdown) return summary
  // Use the same consistency protocol as other generated artifacts, and resolve only these two outputs.
  await markArtifactChanged(featureDir, 'artifacts/verification/acceptance-results.json', { actor: 'verification' })
  await writeJsonAtomic(path.join(dir, 'acceptance-results.json'), summaryValue)
  await writeFile(path.join(dir, 'verification.md'), markdown)
  for (const file of ['artifacts/verification/acceptance-results.json', 'artifacts/verification/verification.md']) {
    await recordArtifactDigest(featureDir, file, { actor: 'verification' })
  }
  await resolveArtifacts(featureDir, ['artifacts/verification/acceptance-results.json', 'artifacts/verification/verification.md'], { actor: 'verification' })
  return summary
}

export async function recordCaseEvidence(featureDir, input) {
  const { status, delivery } = await loadAcceptance(featureDir)
  const tc = delivery.testCases?.find((item) => item.id === input.caseId)
  if (!tc || !['manual', 'inspection'].includes(tc.method)) throw new StoreError('INVALID_CASE', 'Only declared manual/inspection cases accept observed evidence')
  if (!input.actor || !input.observation || !input.expectedSnapshotId || !['passed', 'failed'].includes(input.result) || !Number.isInteger(input.expectedVersion)) throw new StoreError('INVALID_REQUEST', 'actor, observation, expectedSnapshotId, result and expectedVersion required')
  if (tc.method === 'manual' && !input.confirmationRef) throw new StoreError('MISSING_CONFIRMATION', 'Record the actual human confirmation reference')
  if (tc.method === 'inspection' && !input.evidenceRefs?.length) throw new StoreError('MISSING_EVIDENCE', 'Inspection needs concrete evidence references')
  if (status.control.version !== input.expectedVersion) throw new StoreError('VERSION_CONFLICT', 'Reload status before recording evidence')
  if (status.state === 'COMPLETE') throw new StoreError('COMPLETE_IS_HISTORY', 'Do not rewrite completed work')
  const expected = await readSnapshot(featureDir, input.expectedSnapshotId)
  const current = await captureVerificationSnapshot(featureDir, delivery)
  if (!(await verifySnapshot(featureDir, expected)).fresh || expected.projectDigest?.digest !== current.projectDigest.digest || JSON.stringify(expected.inputs) !== JSON.stringify(current.inputs)) throw new StoreError('STALE_SNAPSHOT', 'Confirmation must identify the current verification candidate')
  const record = { caseId: tc.id, method: tc.method, actor: input.actor, result: input.result, observation: input.observation, confirmationRef: input.confirmationRef || null, evidenceRefs: input.evidenceRefs || [], snapshotId: current.id, recordedAt: new Date().toISOString() }
  const recordRef = `revisions/verifications/manual-${randomUUID()}/record.json`
  await writeJsonAtomic(path.join(featureDir, recordRef), record)
  const next = await mutateFeature(featureDir, { expectedVersion: input.expectedVersion, event: { type: 'verification.observe', actor: input.actor, data: { caseId: tc.id, result: input.result } } }, (draft) => {
    draft.runtime.caseEvidence = { ...draft.runtime.caseEvidence, [tc.id]: { recordRef, recordDigest: digest(jsonBytes(record)) } }
    draft.approvals.final = null
    if (draft.reviews?.final) draft.reviews.final = { ...draft.reviews.final, verdict: 'revise', evidenceChanged: true }
  })
  await refreshAcceptanceResults(featureDir)
  return next
}
