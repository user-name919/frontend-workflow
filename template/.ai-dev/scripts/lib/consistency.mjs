/**
 * Digest-aware consistency helpers: blocking stale by gate, reconcile without mark.
 */

import { createHash } from 'node:crypto'
import { readFile, access } from 'node:fs/promises'
import path from 'node:path'

import { mutateFeature, readFeature, StoreError } from './workspace-store.mjs'

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

export async function readGraph(featureDir) {
  const resolved = path.resolve(featureDir)
  const candidates = [
    path.resolve(resolved, '../..', 'artifact-graph.json'),
    path.resolve(resolved, '..', 'artifact-graph.json'),
  ]
  try {
    const status = JSON.parse(await readFile(path.join(resolved, 'status.json'), 'utf8'))
    if (status.project?.root) {
      candidates.push(path.join(status.project.root, '.ai-dev', 'artifact-graph.json'))
    }
  } catch {
    // ignore
  }
  for (const graphPath of candidates) {
    try {
      return JSON.parse(await readFile(graphPath, 'utf8'))
    } catch {
      // try next
    }
  }
  throw new StoreError('MISSING_GRAPH', `artifact-graph.json not found for ${resolved}`)
}

function downstreamArtifacts(graph, artifact) {
  if (!graph[artifact]) return new Set()
  const result = new Set()
  const queue = [...(graph[artifact].downstream || [])]
  while (queue.length) {
    const current = queue.shift()
    if (result.has(current)) continue
    if (!graph[current]) continue
    result.add(current)
    queue.push(...(graph[current].downstream || []))
  }
  return result
}

/**
 * Only stale artifacts that intersect required inputs (or their transitive upstream
 * already represented in requiredInputs) block the gate.
 */
export function blockingStale(status, requiredInputs, graph) {
  const stale = status.consistency?.staleArtifacts || []
  if (!stale.length) return []
  const required = new Set(requiredInputs || [])
  return stale.filter((artifact) => required.has(artifact)).sort()
}

async function digestFeatureFile(featureDir, relative) {
  try {
    await access(path.join(featureDir, relative))
    const bytes = await readFile(path.join(featureDir, relative))
    return { exists: true, sha256: sha256(bytes), generated: true }
  } catch {
    return { exists: false, sha256: null, generated: false }
  }
}

const TRACKED_ARTIFACTS = [
  'artifacts/analysis/intake.json',
  'artifacts/analysis/scope.md',
  'artifacts/analysis/source-index.md',
  'artifacts/analysis/evidence.md',
  'artifacts/analysis/open-questions.md',
  'artifacts/design/delivery.json',
  'artifacts/design/frontend-spec.md',
  'artifacts/design/implementation-plan.md',
  'artifacts/design/acceptance.md',
  'artifacts/design/tasks.md',
  'artifacts/design/traceability.md',
  'artifacts/coding-changes/changed-files.json',
  'artifacts/coding-changes/changes.patch',
  'artifacts/verification/verification.md',
]

/**
 * Detect content changes that bypassed mark, propagate stale, invalidate approvals.
 * Idempotent when digests already match recorded artifactDigests.
 */
export async function reconcileArtifacts(featureDir, options = {}) {
  const resolved = path.resolve(featureDir)
  const status = await readFeature(resolved)
  const expectedVersion = Number.isInteger(options.expectedVersion)
    ? options.expectedVersion
    : status.control.version
  const graph = await readGraph(resolved)
  const currentDigests = status.consistency?.artifactDigests || {}
  const observed = {}
  const changed = []

  for (const artifact of TRACKED_ARTIFACTS) {
    if (!graph[artifact] && !artifact.endsWith('.json') && !artifact.endsWith('.md')) continue
    const digest = await digestFeatureFile(resolved, artifact)
    observed[artifact] = {
      sha256: digest.sha256,
      generated: digest.generated,
      upstreamDigests: currentDigests[artifact]?.upstreamDigests || {},
    }
    const previous = currentDigests[artifact]
    if (!previous) {
      // First observation: record without treating template presence as a change event
      // unless it was previously generated and now differs.
      continue
    }
    if (previous.generated && digest.generated && previous.sha256 !== digest.sha256) {
      changed.push(artifact)
    } else if (previous.generated && !digest.generated) {
      changed.push(artifact)
    } else if (!previous.generated && digest.generated && previous.sha256 && previous.sha256 !== digest.sha256) {
      changed.push(artifact)
    } else if (!previous.generated && digest.generated && !previous.sha256 && digest.sha256) {
      // newly generated from empty — treat as change for downstream freshness
      changed.push(artifact)
    }
  }

  // Seed digests on first reconcile without bumping revision.
  if (!Object.keys(currentDigests).length && !changed.length) {
    return mutateFeature(
      resolved,
      {
        expectedVersion,
        event: {
          type: 'consistency.reconcile.seed',
          actor: options.actor || 'system',
          data: { tracked: TRACKED_ARTIFACTS.length },
        },
      },
      (draft) => {
        draft.consistency = {
          ...draft.consistency,
          artifactDigests: observed,
        }
      },
    )
  }

  if (!changed.length) {
    // Refresh observed digests if identical set — no revision bump when nothing meaningful changed.
    const same = TRACKED_ARTIFACTS.every((artifact) => {
      const prev = currentDigests[artifact]
      const next = observed[artifact]
      if (!prev && !next?.generated) return true
      return prev?.sha256 === next?.sha256 && prev?.generated === next?.generated
    })
    if (same) {
      return status
    }
  }

  if (!changed.length) {
    return mutateFeature(
      resolved,
      {
        expectedVersion,
        event: {
          type: 'consistency.reconcile.observe',
          actor: options.actor || 'system',
          data: {},
        },
      },
      (draft) => {
        draft.consistency = {
          ...draft.consistency,
          artifactDigests: {
            ...(draft.consistency.artifactDigests || {}),
            ...observed,
          },
        }
      },
    )
  }

  const stale = new Set(status.consistency?.staleArtifacts || [])
  const invalidated = new Set()
  for (const artifact of changed) {
    stale.delete(artifact)
    for (const downstream of downstreamArtifacts(graph, artifact)) stale.add(downstream)
    for (const approval of graph[artifact]?.invalidatesApprovals || []) invalidated.add(approval)
  }

  const revision = (status.consistency?.revision || 0) + 1
  return mutateFeature(
    resolved,
    {
      expectedVersion,
      event: {
        type: 'consistency.reconcile',
        actor: options.actor || 'system',
        data: { changed, invalidated: [...invalidated] },
      },
    },
    (draft) => {
      for (const approval of invalidated) {
        if (draft.approvals && approval in draft.approvals) draft.approvals[approval] = null
      }
      draft.consistency = {
        ...draft.consistency,
        revision,
        staleArtifacts: [...stale].sort(),
        artifactDigests: {
          ...(draft.consistency.artifactDigests || {}),
          ...observed,
        },
        lastChange: {
          artifact: changed[0],
          changedAt: new Date().toISOString(),
          revisionFile: null,
          via: 'reconcile',
        },
      }
    },
  )
}

export async function recordArtifactDigest(featureDir, artifact, options = {}) {
  const resolved = path.resolve(featureDir)
  const status = await readFeature(resolved)
  const expectedVersion = Number.isInteger(options.expectedVersion)
    ? options.expectedVersion
    : status.control.version
  const digest = await digestFeatureFile(resolved, artifact)
  return mutateFeature(
    resolved,
    {
      expectedVersion,
      event: {
        type: 'consistency.digest',
        actor: options.actor || 'system',
        data: { artifact },
      },
    },
    (draft) => {
      const digests = { ...(draft.consistency.artifactDigests || {}) }
      digests[artifact] = {
        sha256: digest.sha256,
        generated: digest.generated,
        upstreamDigests: options.upstreamDigests || {},
      }
      draft.consistency = {
        ...draft.consistency,
        artifactDigests: digests,
      }
    },
  )
}

export { TRACKED_ARTIFACTS, downstreamArtifacts }
