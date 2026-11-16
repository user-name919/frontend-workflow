/** Execute approved checks and persist source-bound, per-case evidence. No model calls. */
import { execFile as execFileCallback } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { readSnapshot, verifySnapshot } from './snapshots.mjs'
import { validateDelivery } from './delivery.mjs'
import { mutateFeature, readFeature, StoreError } from './workspace-store.mjs'
import { currentTraceId, startActivity } from './monitor-events.mjs'
import { captureVerificationSnapshot, digest, jsonBytes, loadAcceptance, refreshAcceptanceResults, validateVerificationRecord, writeJsonAtomic } from './acceptance.mjs'
import { readEvidenceFile, readAcceptanceReport } from './verification-report.mjs'

const execFile = promisify(execFileCallback)

export function renderVerificationMarkdown(records) {
  return ['# Verification (legacy command evidence)', '', '| Command | Result | Run |', '| --- | --- | --- |',
    ...records.map((record) => `| ${record.command} | ${record.status} | ${record.id} |`), '',
    'These records do not establish v2 requirement acceptance. Upgrade the delivery and rerun.', ''].join('\n')
}

async function registerRun(featureDir, record, expectedVersion, actor) {
  const recordRef = `revisions/verifications/${record.id}/record.json`
  // Complete bytes are durable before the ledger references them. A failed CAS is recoverable.
  await writeJsonAtomic(path.join(featureDir, recordRef), record)
  return mutateFeature(featureDir, {
    expectedVersion,
    event: { type: 'verification.run', actor, data: { id: record.id, taskId: record.taskId, checkId: record.checkId, status: record.status, exitCode: record.exitCode } },
  }, (draft) => {
    const previousRun = draft.runtime.verifications?.[record.id]
    draft.runtime.verifications = { ...draft.runtime.verifications, [record.id]: {
      schemaVersion: record.schemaVersion, id: record.id, scope: record.scope, taskId: record.taskId,
      attemptId: record.attemptId, checkId: record.checkId, sequence: record.sequence,
      status: record.status, exitCode: record.exitCode, recordRef, recordDigest: digest(jsonBytes(record)),
    } }
    if (record.schemaVersion === 2 && previousRun?.status === 'running' && record.status !== 'running') {
      const key = `${record.scope}:${record.taskId || 'feature'}:${record.checkId}`
      const previousFailures = draft.runtime.verificationRepairs?.[key]?.consecutiveFailures || 0
      const consecutiveFailures = record.status === 'passed' ? 0 : record.status === 'blocked' ? previousFailures : previousFailures + 1
      draft.runtime.verificationRepairs = { ...draft.runtime.verificationRepairs, [key]: {
        scope: record.scope, taskId: record.taskId, checkId: record.checkId,
        consecutiveFailures, fixRound: Math.max(0, consecutiveFailures - 1), lastRunId: record.id,
      } }
    }
    if (record.taskId) {
      const current = draft.runtime.taskResults[record.taskId] || { status: 'pending' }
      draft.runtime.taskResults[record.taskId] = { ...current, verificationIds: [...new Set([...(current.verificationIds || []), record.id])] }
    }
    if (record.schemaVersion === 2 && record.scope === 'feature') {
      draft.approvals.final = null
      if (draft.reviews?.final) draft.reviews.final = { ...draft.reviews.final, evidenceChanged: true }
    }
  })
}

export async function runVerification(featureDir, input = {}) {
  const resolved = path.resolve(featureDir)
  const { status, intake, delivery } = await loadAcceptance(resolved)
  const v2 = delivery.schemaVersion === 2
  const actor = input.actor || 'coordinator'
  const taskId = input.taskId || null
  const scope = input.scope || (taskId ? 'task' : 'feature')
  const task = delivery.tasks?.find((item) => item.id === taskId)
  let check
  if (v2) {
    const validation = validateDelivery(intake, delivery, { phase: 'plan' })
    if (!validation.ok) throw new StoreError('INVALID_DELIVERY', validation.errors.map((item) => item.message).join('; '))
    if (!['task', 'feature'].includes(scope) || (scope === 'feature' && taskId)) throw new StoreError('INVALID_SCOPE', 'scope must be task or feature; feature has no taskId')
    check = delivery.verification.checks.find((item) => item.id === input.checkId)
    const allowed = scope === 'task' ? task?.verifyIds : delivery.verification.finalCheckIds
    if (!check || !allowed?.includes(check.id)) throw new StoreError('UNKNOWN_CHECK', 'Check is not scheduled in this scope')
    if (scope === 'task' && (!input.attemptId || status.runtime.taskResults?.[taskId]?.status !== 'running' || status.runtime.taskResults[taskId].attemptId !== input.attemptId)) throw new StoreError('STALE_ATTEMPT', 'Task verification requires the current running attemptId')
    if (scope === 'feature' && !['VERIFYING', 'FINAL_REVIEW'].includes(status.state)) throw new StoreError('INVALID_STATE', 'Final candidate checks run in VERIFYING or FINAL_REVIEW')
    const running = Object.values(status.runtime.verifications || {}).find((ref) => ref.status === 'running' && ref.scope === scope && ref.taskId === taskId && ref.checkId === check.id)
    if (running) throw new StoreError('VERIFICATION_RUNNING', `Inspect/recover ${running.id} before retrying`)
  } else {
    if (!task || !Number.isInteger(input.commandIndex)) throw new StoreError('INVALID_REQUEST', 'Legacy runs require taskId and commandIndex')
    check = task.verify?.[input.commandIndex]
    if (!check) throw new StoreError('UNKNOWN_COMMAND', `Unknown verify[${input.commandIndex}]`)
    check = { ...check, id: `legacy-${taskId}-${input.commandIndex}`, kind: 'engineering' }
  }
  if (Number.isInteger(input.expectedVersion) && input.expectedVersion !== status.control.version) throw new StoreError('VERSION_CONFLICT', 'Reload status before running verification')
  if (input.expectedSnapshotId && !(await verifySnapshot(resolved, await readSnapshot(resolved, input.expectedSnapshotId))).fresh) throw new StoreError('STALE_SNAPSHOT', 'Caller snapshot is no longer fresh')
  const command = check.command
  if (typeof command !== 'string' || !command || /[|;&\n\r]/.test(command) || (!path.isAbsolute(command) && command.includes(' '))) throw new StoreError('SHELL_FORBIDDEN', 'Use command + args; shell strings are forbidden')
  const args = check.args || []
  const projectRoot = await realpath(status.project.root)
  const cwd = await realpath(path.resolve(projectRoot, check.cwd || '.'))
  if (cwd !== projectRoot && !cwd.startsWith(`${projectRoot}${path.sep}`)) throw new StoreError('PATH_ESCAPE', 'Check cwd escapes project')
  const environment = v2 ? delivery.verification.environments.find((env) => env.id === check.environmentId) : null
  const before = await captureVerificationSnapshot(resolved, delivery, { taskId })
  const id = `ver-${randomUUID()}`
  const outDir = path.join(resolved, 'revisions/verifications', id)
  await mkdir(outDir, { recursive: true })
  const record = {
    schemaVersion: v2 ? 2 : 1, id, sequence: status.control.version + 1, scope, taskId,
    attemptId: input.attemptId || null, checkId: check.id, environmentId: environment?.id || null,
    command, args, cwd, startedAt: new Date().toISOString(), endedAt: null,
    status: 'running', exitCode: null, timedOut: false, summary: '', cases: [], files: [],
    inputSnapshotId: before.id, outputSnapshotId: null,
    snapshotDigest: digest(await readFile(path.join(resolved, 'revisions/snapshots', `${before.id}.json`))),
    stdoutPath: `revisions/verifications/${id}/stdout.log`, stderrPath: `revisions/verifications/${id}/stderr.log`,
    rawReportPath: v2 && check.kind === 'acceptance' ? `revisions/verifications/${id}/raw-report.json` : null,
  }
  const runningStatus = await registerRun(resolved, record, status.control.version, actor)
  const activity = startActivity({ kind: 'command', component: 'verification-command', command: path.basename(command), projectRoot, featureDir: resolved, taskId, parentId: currentTraceId() })
  let stdout = ''
  let stderr = ''
  let missingHost = false
  try {
    const result = await execFile(command, args, {
      cwd, timeout: Number.isInteger(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : 120000,
      maxBuffer: 20 * 1024 * 1024, encoding: 'utf8',
      env: { ...process.env, ...(v2 ? {
        WORKFLOW_VERIFICATION_DIR: outDir, WORKFLOW_ENVIRONMENT_ID: environment.id,
        WORKFLOW_BASE_URL: environment.baseURL || '',
        WORKFLOW_RUN_ID: id,
        WORKFLOW_FEATURE_DIR: resolved,
        WORKFLOW_INPUT_SNAPSHOT: before.id,
        WORKFLOW_JSON_OUTPUT_FILE: path.join(outDir, 'raw-report.json'),
        PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(outDir, 'raw-report.json'),
        PLAYWRIGHT_HTML_OUTPUT_DIR: path.join(outDir, 'html'),
      } : {}) },
    })
    stdout = result.stdout || ''
    stderr = result.stderr || ''
    record.exitCode = 0
  } catch (error) {
    stdout = error.stdout || ''
    stderr = error.stderr || error.message || ''
    record.timedOut = Boolean(error.killed) || /ETIMEOUT|timed out/i.test(error.message || '')
    missingHost = error.code === 'ENOENT'
    record.exitCode = missingHost ? null : typeof error.code === 'number' ? error.code : 1
    record.summary = missingHost ? 'command/host missing' : record.timedOut ? 'timed out' : 'non-zero exit'
  } finally {
    activity.finish(record.exitCode, record.exitCode === 0 ? 'completed' : 'failed')
  }
  await writeFile(path.join(resolved, record.stdoutPath), stdout)
  await writeFile(path.join(resolved, record.stderrPath), stderr)
  record.status = missingHost ? 'unverified' : record.exitCode === 0 && !record.timedOut ? 'passed' : 'failed'
  const evidencePaths = [record.stdoutPath, record.stderrPath]
  if (record.rawReportPath) {
    try {
      const report = JSON.parse(await readEvidenceFile(resolved, record.rawReportPath))
      const parsed = await readAcceptanceReport(report, { check, cases: delivery.testCases, environment, projectRoot, outputDir: outDir })
      record.cases = parsed.cases
      record.reportErrors = parsed.errors
      evidencePaths.push(record.rawReportPath, ...parsed.evidencePaths.map((file) => path.relative(resolved, path.join(outDir, file))))
      if (parsed.errors.length) {
        record.status = parsed.cases.some((tc) => tc.status === 'failed') || parsed.globalErrors?.length || record.timedOut ? 'failed'
          : parsed.cases.some((tc) => tc.status === 'flaky') ? 'flaky'
            : parsed.cases.some((tc) => tc.status === 'blocked') ? 'blocked' : 'failed'
        record.summary = parsed.errors.join('; ')
      }
    } catch (error) {
      record.status = 'unverified'
      record.summary = `Missing/invalid fresh report: ${error.message}`
    }
  }
  for (const file of [...new Set(evidencePaths)]) record.files.push({ path: file, sha256: digest(await readEvidenceFile(resolved, file)) })
  const after = await verifySnapshot(resolved, before)
  record.outputSnapshotId = before.id
  if (!after.fresh) {
    record.status = 'failed'
    record.summary = 'source or verification inputs changed during execution'
    record.changes = after.changes
  }
  record.endedAt = new Date().toISOString()
  const next = await registerRun(resolved, record, runningStatus.control.version, actor)
  if (v2) await refreshAcceptanceResults(resolved)
  else {
    const records = await Promise.all(Object.values(next.runtime.verifications).map(async (ref) => JSON.parse(await readFile(path.join(resolved, ref.recordRef), 'utf8'))))
    await writeFile(path.join(resolved, 'artifacts/verification/verification.md'), renderVerificationMarkdown(records))
  }
  return record
}

/** Recover a durable completed run after CAS failure, or mark a stopped run interrupted. */
export async function recoverVerification(featureDir, input) {
  const { status, delivery } = await loadAcceptance(featureDir)
  if (input.confirmWorkerStopped !== true || !input.actor || !Number.isInteger(input.expectedVersion)) throw new StoreError('INVALID_REQUEST', 'Confirm the test process stopped and supply actor/expectedVersion')
  if (status.control.version !== input.expectedVersion) throw new StoreError('VERSION_CONFLICT', 'Reload status')
  const ref = status.runtime.verifications?.[input.runId]
  if (!ref || ref.status !== 'running') throw new StoreError('NO_RUNNING_VERIFICATION', 'No running verification with this id')
  const validation = await validateVerificationRecord(featureDir, ref, delivery, { recover: true })
  const record = validation.record || JSON.parse(await readEvidenceFile(featureDir, ref.recordRef))
  if (!validation.ok) {
    record.status = 'interrupted'
    record.summary = `Recovered without pass: ${validation.reason}`
    record.endedAt = new Date().toISOString()
  }
  const next = await registerRun(featureDir, record, input.expectedVersion, input.actor)
  await refreshAcceptanceResults(featureDir)
  return { status: next, record }
}
