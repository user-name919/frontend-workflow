#!/usr/bin/env node

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
 * Mark an artifact changed and propagate stale downstream.
 * Reads control.version at entry when expectedVersion is omitted.
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
  if (!rawChangeDir || !['mark', 'resolve'].includes(action) || !artifacts.length) {
    console.error('Usage: node .ai-dev/scripts/update-consistency.mjs <change-dir> <mark|resolve> <artifact...>')
    process.exit(1)
  }

  try {
    const status = action === 'mark'
      ? await markArtifactChanged(rawChangeDir, artifacts[0])
      : await resolveArtifacts(rawChangeDir, artifacts)
    console.log(`State ${status.state}; stale artifacts: ${status.consistency.staleArtifacts.join(', ') || 'none'}`)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
