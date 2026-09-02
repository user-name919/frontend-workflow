#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

async function readWorkspace(rawChangeDir) {
  const changeDir = path.resolve(rawChangeDir)
  const statusPath = path.join(changeDir, 'status.json')
  const graphPath = path.resolve(changeDir, '../..', 'artifact-graph.json')
  const [statusText, graphText] = await Promise.all([
    readFile(statusPath, 'utf8'),
    readFile(graphPath, 'utf8')
  ])
  return {
    status: JSON.parse(statusText),
    graph: JSON.parse(graphText),
    statusPath
  }
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
    lastChange: null
  }
}

async function saveStatus(statusPath, status) {
  await writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`)
  return status
}

export async function markArtifactChanged(rawChangeDir, artifact, options = {}) {
  const { status, graph, statusPath } = await readWorkspace(rawChangeDir)
  const changeDir = path.resolve(rawChangeDir)
  const now = options.now || (() => new Date())
  const current = consistency(status)
  const stale = new Set(current.staleArtifacts)
  stale.delete(artifact)
  for (const downstream of downstreamArtifacts(graph, artifact)) stale.add(downstream)

  const invalidatedApprovals = []
  for (const approval of graph[artifact].invalidatesApprovals || []) {
    if (status.approvals?.[approval]) invalidatedApprovals.push(approval)
    if (status.approvals && approval in status.approvals) status.approvals[approval] = null
  }

  const changedAt = now().toISOString()
  const revision = current.revision + 1
  const revisionFile = `revisions/revision-${String(revision).padStart(4, '0')}.json`
  const staleArtifacts = [...stale].sort()
  status.updatedAt = changedAt
  status.consistency = {
    revision,
    staleArtifacts,
    lastChange: { artifact, changedAt, revisionFile }
  }
  const revisionRecord = {
    revision,
    state: status.state,
    changedArtifact: artifact,
    changedAt,
    invalidatedApprovals,
    staleArtifacts,
    resolvedArtifacts: [],
    remainingStaleArtifacts: staleArtifacts,
    resolvedAt: null
  }
  const revisionPath = path.join(changeDir, revisionFile)
  await mkdir(path.dirname(revisionPath), { recursive: true })
  await writeFile(revisionPath, `${JSON.stringify(revisionRecord, null, 2)}\n`)
  return saveStatus(statusPath, status)
}

export async function resolveArtifacts(rawChangeDir, artifacts, options = {}) {
  if (!artifacts.length) throw new Error('At least one refreshed artifact is required')
  const { status, graph, statusPath } = await readWorkspace(rawChangeDir)
  const changeDir = path.resolve(rawChangeDir)
  for (const artifact of artifacts) {
    if (!graph[artifact]) throw new Error(`Unknown artifact: ${artifact}`)
  }

  const current = consistency(status)
  const refreshed = new Set(artifacts)
  const updatedAt = (options.now || (() => new Date()))().toISOString()
  status.updatedAt = updatedAt
  status.consistency = {
    ...current,
    staleArtifacts: current.staleArtifacts.filter(artifact => !refreshed.has(artifact))
  }
  const revisionFile = current.lastChange?.revisionFile
  if (!revisionFile) throw new Error('Current consistency revision has no revision record')
  const revisionPath = path.join(changeDir, revisionFile)
  const revisionRecord = JSON.parse(await readFile(revisionPath, 'utf8'))
  revisionRecord.resolvedArtifacts = [...new Set([
    ...(revisionRecord.resolvedArtifacts || []),
    ...artifacts.filter(artifact => current.staleArtifacts.includes(artifact))
  ])].sort()
  revisionRecord.remainingStaleArtifacts = status.consistency.staleArtifacts
  revisionRecord.resolvedAt = updatedAt
  await writeFile(revisionPath, `${JSON.stringify(revisionRecord, null, 2)}\n`)
  return saveStatus(statusPath, status)
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
