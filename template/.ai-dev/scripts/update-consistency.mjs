#!/usr/bin/env node

/**
 * 解决什么问题：改了一份上游产物后，下游 Markdown/JSON 会过期，但 status.state 不能因此回退。缺少“谁过期了”的账本，过门会读到旧投影。
 * 通过什么方式解决：mark 按 artifact-graph 把下游标 stale、作废相关 approvals，并唯一创建 revisions/revision-NNNN.json。resolve 只清除实际已刷新的路径。两者都经 mutateFeature 记事件。
 * 触发时机：编辑已有工作流产物之前 mark；刷新完下游之后 resolve。不得用它来改 state 机。
 * 被谁控制触发：主 Agent 在改产物前后下令；人也可在终端对单个路径 mark/resolve。
 */

import { mkdir, readFile, writeFile, open } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { mutateFeature, readFeature, StoreError } from './lib/workspace-store.mjs'

async function readGraph(rawChangeDir) {
  const changeDir = path.resolve(rawChangeDir)
  const graphPath = path.resolve(changeDir, '../..', 'artifact-graph.json')
  return JSON.parse(await readFile(graphPath, 'utf8'))
}

function downstreamArtifacts(graph, artifact) {
  if (!graph[artifact]) throw new Error(`Unknown artifact: ${artifact}`)

  const result = new Set()
  const queue = [...graph[artifact].downstream]
  while (queue.length) {
    const current = queue.shift()
    if (result.has(current)) continue
    if (!graph[current]) throw new Error(`Artifact graph references unknown artifact: ${current}`)
    result.add(current)
    queue.push(...graph[current].downstream)
  }
  return result
}

function consistency(status) {
  return status.consistency || {
    revision: 0,
    staleArtifacts: [],
    lastChange: null,
  }
}

/**
 * 把某产物标为已改：自身移出 stale，所有下游加入 stale，并按图作废相关 approvals。
 * 未传 expectedVersion 时读取入口处的 control.version，写入用 wx 保证 revision 文件不覆盖。
 * VERSION_CONFLICT 原样抛出，提示并发 mark，调用方应重读后再试。
 */
export async function markArtifactChanged(rawChangeDir, artifact, options = {}) {
  const changeDir = path.resolve(rawChangeDir)
  const graph = await readGraph(changeDir)
  if (!graph[artifact]) throw new Error(`Unknown artifact: ${artifact}`)

  const currentStatus = await readFeature(changeDir)
  const expectedVersion = Number.isInteger(options.expectedVersion)
    ? options.expectedVersion
    : currentStatus.control.version

  const now = options.now || (() => new Date())
  const current = consistency(currentStatus)
  const stale = new Set(current.staleArtifacts)
  stale.delete(artifact)
  for (const downstream of downstreamArtifacts(graph, artifact)) stale.add(downstream)

  const invalidatedApprovals = []
  for (const approval of graph[artifact].invalidatesApprovals || []) {
    if (currentStatus.approvals?.[approval]) invalidatedApprovals.push(approval)
  }

  const changedAt = now().toISOString()
  const revision = current.revision + 1
  const revisionFile = `revisions/revision-${String(revision).padStart(4, '0')}.json`
  const staleArtifacts = [...stale].sort()
  const revisionPath = path.join(changeDir, revisionFile)
  const revisionRecord = {
    revision,
    state: currentStatus.state,
    changedArtifact: artifact,
    changedAt,
    invalidatedApprovals,
    staleArtifacts,
    resolvedArtifacts: [],
    remainingStaleArtifacts: staleArtifacts,
    resolvedAt: null,
  }

  await mkdir(path.dirname(revisionPath), { recursive: true })
  // Unique create — never overwrite an existing revision file.
  try {
    const handle = await open(revisionPath, 'wx')
    try {
      await handle.writeFile(`${JSON.stringify(revisionRecord, null, 2)}\n`)
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (error.code === 'EEXIST') {
      // wx 撞车说明 revision 号已被占用，不能覆盖既有审计文件。
      throw new Error(`Revision file already exists: ${revisionFile}`)
    }
    throw error
  }

  try {
    return await mutateFeature(
      changeDir,
      {
        expectedVersion,
        event: {
          type: 'consistency.mark',
          actor: options.actor || 'system',
          data: { artifact, revisionFile },
        },
      },
      (status) => {
        for (const approval of invalidatedApprovals) {
          if (status.approvals && approval in status.approvals) status.approvals[approval] = null
        }
        status.consistency = {
          revision,
          staleArtifacts,
          lastChange: { artifact, changedAt, revisionFile },
          artifactDigests: {
            ...(status.consistency?.artifactDigests || {}),
          },
        }
      },
    )
  } catch (error) {
    if (error instanceof StoreError && error.code === 'VERSION_CONFLICT') {
      throw error
    }
    throw error
  }
}

/**
 * 声明若干下游已按新内容刷新，从 consistency.staleArtifacts 里去掉这些路径。
 * 只 resolve 当前确实 stale 的项；未 mark 过的路径不会凭空清掉。
 * 没有 lastChange.revisionFile 说明尚未 mark，直接失败以免假解决。
 */
export async function resolveArtifacts(rawChangeDir, artifacts, options = {}) {
  if (!artifacts.length) throw new Error('At least one refreshed artifact is required')
  const changeDir = path.resolve(rawChangeDir)
  const graph = await readGraph(changeDir)
  for (const artifact of artifacts) {
    if (!graph[artifact]) throw new Error(`Unknown artifact: ${artifact}`)
  }

  const currentStatus = await readFeature(changeDir)
  const expectedVersion = Number.isInteger(options.expectedVersion)
    ? options.expectedVersion
    : currentStatus.control.version

  const current = consistency(currentStatus)
  const revisionFile = current.lastChange?.revisionFile
  if (!revisionFile) throw new Error('Current consistency revision has no revision record')

  const updatedAt = (options.now || (() => new Date()))().toISOString()
  const revisionPath = path.join(changeDir, revisionFile)
  const revisionRecord = JSON.parse(await readFile(revisionPath, 'utf8'))
  const resolvedSet = new Set([
    ...(revisionRecord.resolvedArtifacts || []),
    ...artifacts.filter((artifact) => current.staleArtifacts.includes(artifact)),
  ])
  revisionRecord.resolvedArtifacts = [...resolvedSet].sort()
  const remaining = current.staleArtifacts.filter((artifact) => !new Set(artifacts).has(artifact))
  revisionRecord.remainingStaleArtifacts = remaining
  revisionRecord.resolvedAt = updatedAt
  await writeFile(revisionPath, `${JSON.stringify(revisionRecord, null, 2)}\n`)

  return mutateFeature(
    changeDir,
    {
      expectedVersion,
      event: {
        type: 'consistency.resolve',
        actor: options.actor || 'system',
        data: { artifacts, revisionFile },
      },
    },
    (status) => {
      status.consistency = {
        ...consistency(status),
        staleArtifacts: remaining,
      }
    },
  )
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [, , rawChangeDir, action, ...artifacts] = process.argv
  // CLI：mark <artifact> 或 resolve <artifact...>，缺参直接失败，避免空操作改账本。
  if (!rawChangeDir || !['mark', 'resolve'].includes(action) || !artifacts.length) {
    console.error('Usage: node .ai-dev/scripts/update-consistency.mjs <change-dir> <mark|resolve> <artifact...>')
    process.exit(1)
  }

  try {
    // mark 只取第一个路径；resolve 接受多个已刷新产物。
    const status = action === 'mark'
      ? await markArtifactChanged(rawChangeDir, artifacts[0])
      : await resolveArtifacts(rawChangeDir, artifacts)
    console.log(`State ${status.state}; stale artifacts: ${status.consistency.staleArtifacts.join(', ') || 'none'}`)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
