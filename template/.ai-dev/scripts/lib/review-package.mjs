/**
 * 解决什么问题：给人/独立审核一份冻结清单，并让批准绑在新鲜快照上。
 * 通过什么方式解决：先 captureSnapshot，再写 package manifest（含 before/after digest）；批准必须带仍新鲜的 snapshotId。
 * 触发时机：准备审核包、闸门核对上游批准。
 * 被谁控制触发：准备审核脚本与 gates。软链不是审计证据。
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { captureSnapshot, readSnapshot } from './snapshots.mjs'
import { StoreError } from './workspace-store.mjs'

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * 抓快照后写 revisions/review-packages/<id>/manifest.json，把清单与 snapshotId 绑在一起。
 * 软链不是审计证据，只记 before/after 字节 digest。
 * final 或带 taskId 时快照含 projectDigest。
 */
export async function createReviewPackage(featureDir, options = {}) {
  const resolved = path.resolve(featureDir)
  const { gate, taskId = null } = options
  if (!gate) throw new StoreError('INVALID_REQUEST', 'gate is required')

  const snapshot = await captureSnapshot(resolved, {
    gate,
    taskId,
    inputs: options.inputs,
    includeProjectDigest: gate === 'final' || Boolean(taskId),
  })

  const packageId = `pkg-${snapshot.id.slice(5, 21)}-${randomBytes(3).toString('hex')}`
  const packageDir = path.join(resolved, 'revisions/review-packages', packageId)
  await mkdir(packageDir, { recursive: true })

  const before = {}
  for (const [relative, content] of Object.entries(options.beforeFiles || {})) {
    before[relative] = content == null ? null : sha256(Buffer.isBuffer(content) ? content : Buffer.from(content))
  }
  const after = {}
  for (const [relative, content] of Object.entries(options.afterFiles || {})) {
    after[relative] = content == null ? null : sha256(Buffer.isBuffer(content) ? content : Buffer.from(content))
  }

  const manifest = {
    packageId,
    snapshotId: snapshot.id,
    gate,
    taskId,
    createdAt: new Date().toISOString(),
    note: 'Softlinks under coding-changes/coding are live indexes, not audited evidence. Use before/after bytes or Git versions.',
    requirementPatchPath: options.requirementPatchPath || 'artifacts/coding-changes/changes.patch',
    taskDelta: {
      beforeFileDigests: before,
      afterFileDigests: after,
      naming: 'task-level before/after are separate from requirement-level changes.patch',
    },
    snapshotRef: `revisions/snapshots/${snapshot.id}.json`,
  }

  const manifestPath = path.join(packageDir, 'manifest.json')
  const handle = await open(manifestPath, 'wx')
  try {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`)
  } finally {
    await handle.close()
  }

  return {
    packageId,
    snapshotId: snapshot.id,
    manifestPath: path.relative(resolved, manifestPath),
  }
}

/**
 * 批准必须带 snapshotId，且该快照相对当前输入仍 fresh。
 * 缺 id 或已过期都要求按当前输入重批。
 */
export async function assertSnapshotBoundApproval(featureDir, approval, gate) {
  if (!approval) {
    return { ok: false, code: 'MISSING_APPROVAL', message: `${gate} approval missing` }
  }
  if (!approval.snapshotId) {
    return {
      ok: false,
      code: 'REAPPROVAL_REQUIRED',
      message: `${gate} approval has no snapshotId; re-approve against current inputs`,
    }
  }
  const snapshot = await readSnapshot(featureDir, approval.snapshotId)
  const { verifySnapshot } = await import('./snapshots.mjs')
  const check = await verifySnapshot(featureDir, snapshot)
  if (!check.fresh) {
    return {
      ok: false,
      code: 'STALE_APPROVAL_SNAPSHOT',
      message: `${gate} approval snapshot is no longer fresh`,
      changes: check.changes,
    }
  }
  return { ok: true, snapshot }
}
