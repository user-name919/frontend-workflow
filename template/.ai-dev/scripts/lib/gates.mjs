/**
 * Phase gate evaluator: structural / reference checks only.
 * Semantic correctness remains human + later independent review.
 */

import { access, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import { validateIntake } from './intake.mjs'
import { validateDelivery, validateDeliveryAsync } from './delivery.mjs'
import { readFeature } from './workspace-store.mjs'
import { blockingStale, readGraph } from './consistency.mjs'
import { gateAuthorized } from './reviews.mjs'
import { assertSnapshotBoundApproval } from './review-package.mjs'
import { validateTechScheme } from './tech-scheme.mjs'

function err(code, message, extra = {}) {
  return { code, message, ruleId: code, ...extra }
}

const PLACEHOLDER_MARKERS = ['[TODO]', 'TODO: fill', '<!-- placeholder']

const REQUIRED_INPUTS = {
  scope: [
    'artifacts/analysis/intake.json',
    'artifacts/analysis/scope.md',
    'artifacts/analysis/source-index.md',
    'artifacts/analysis/evidence.md',
    'artifacts/analysis/open-questions.md',
  ],
  spec: [
    'artifacts/analysis/intake.json',
    'artifacts/design/delivery.json',
    'artifacts/design/frontend-spec.md',
    'artifacts/design/acceptance.md',
  ],
  plan: [
    'artifacts/analysis/intake.json',
    'artifacts/design/delivery.json',
    'artifacts/design/implementation-plan.md',
    'artifacts/design/tasks.md',
    'artifacts/design/traceability.md',
  ],
  final: [
    'artifacts/analysis/intake.json',
    'artifacts/design/delivery.json',
    'artifacts/coding-changes/changed-files.json',
    'artifacts/coding-changes/changes.patch',
    'artifacts/verification/verification.md',
  ],
}

async function readJson(featureDir, relative) {
  const full = path.join(featureDir, relative)
  try {
    return JSON.parse(await readFile(full, 'utf8'))
  } catch (error) {
    return { __error: error }
  }
}

async function readText(featureDir, relative) {
  try {
    return await readFile(path.join(featureDir, relative), 'utf8')
  } catch {
    return null
  }
}

function looksLikePlaceholder(text) {
  if (text == null) return true
  const trimmed = text.trim()
  if (!trimmed) return true
  return PLACEHOLDER_MARKERS.some((marker) => trimmed.includes(marker))
}

function openBlockingQuestions(intake, gate) {
  return (intake.questions || []).filter((question) => {
    if (!question.blocking || question.status === 'resolved') return false
    if (gate === 'scope') {
      return (question.blocksGates || []).includes('scope')
    }
    // spec and later: all unresolved blocking questions
    return true
  })
}

/**
 * @param {string} featureDir
 * @param {'scope'|'spec'|'plan'|'final'} gate
 */
export async function evaluateGate(featureDir, gate) {
  const resolved = path.resolve(featureDir)
  const errors = []
  const warnings = []
  const requiredInputs = REQUIRED_INPUTS[gate]
  if (!requiredInputs) {
    return {
      ok: false,
      errors: [err('UNKNOWN_GATE', `Unknown gate: ${gate}`)],
      warnings,
      requiredInputs: [],
    }
  }

  let status
  try {
    status = await readFeature(resolved)
  } catch (error) {
    return {
      ok: false,
      errors: [err(error.code || 'STATUS_ERROR', error.message)],
      warnings,
      requiredInputs,
    }
  }

  if (status.control?.artifactStatus === 'NEEDS_STRUCTURED_IMPORT') {
    errors.push(
      err(
        'NEEDS_STRUCTURED_IMPORT',
        'Legacy workspace needs structured import before gate admission',
      ),
    )
  }

  let graph = {}
  try {
    graph = await readGraph(resolved)
  } catch {
    graph = {}
  }
  const blockedStale = blockingStale(status, requiredInputs, graph)
  if (blockedStale.length) {
    errors.push(err('STALE_ARTIFACTS', `stale artifacts: ${blockedStale.join(', ')}`))
  }

  const upstreamGates = {
    scope: [],
    spec: ['scope'],
    plan: ['scope', 'spec'],
    final: ['scope', 'spec', 'plan'],
  }
  for (const upstream of upstreamGates[gate] || []) {
    const approval = status.approvals?.[upstream]
    if (approval) {
      const bound = await assertSnapshotBoundApproval(resolved, approval, upstream)
      if (!bound.ok) {
        errors.push(err(bound.code, bound.message))
      }
      continue
    }
    // Delegated independent pass may authorize spec/plan without forging approvals.*
    if (status.policy?.mode === 'delegated-review' && !gateAuthorized(status, upstream)) {
      errors.push(
        err(
          'DELEGATION_INCOMPLETE',
          `${upstream} lacks human approval and has no accepted independent review under delegation`,
        ),
      )
    }
  }

  for (const relative of requiredInputs) {
    try {
      const fileStat = await stat(path.join(resolved, relative))
      if (!fileStat.isFile()) errors.push(err('MISSING_INPUT', `${relative}: not a file`, { artifact: relative }))
    } catch {
      errors.push(err('MISSING_INPUT', `${relative}: missing`, { artifact: relative }))
    }
  }

  const intakeBundle = await readJson(resolved, 'artifacts/analysis/intake.json')
  if (intakeBundle.__error) {
    errors.push(err('INVALID_INTAKE', `Cannot read intake.json: ${intakeBundle.__error.message}`))
    return { ok: false, errors, warnings, requiredInputs }
  }

  const intakeResult = validateIntake(intakeBundle)
  if (!intakeResult.ok) {
    errors.push(...intakeResult.errors)
  }

  if (gate === 'scope') {
    const scopeText = await readText(resolved, 'artifacts/analysis/scope.md')
    if (looksLikePlaceholder(scopeText)) {
      errors.push(err('PLACEHOLDER_SCOPE', 'scope.md still contains placeholder content'))
    }
    // Empty intake cannot pass scope
    if (
      !intakeBundle.sources?.length ||
      !intakeBundle.requirements?.length
    ) {
      errors.push(err('EMPTY_INTAKE', 'scope gate requires sources and requirements in intake.json'))
    }
    for (const question of openBlockingQuestions(intakeBundle, 'scope')) {
      errors.push(
        err('BLOCKING_QUESTION', `Unresolved blocking question ${question.id} blocks scope`, { artifact: question.id }),
      )
    }
    // Ownership clarity: included requirements must not be UNKNOWN
    for (const req of intakeBundle.requirements || []) {
      if (req.disposition === 'included' && req.ownership === 'UNKNOWN') {
        errors.push(err('UNKNOWN_OWNERSHIP', `included requirement ${req.id} has UNKNOWN ownership`, { artifact: req.id }))
      }
    }
  }

  if (gate === 'spec' || gate === 'plan' || gate === 'final') {
    for (const question of openBlockingQuestions(intakeBundle, gate)) {
      errors.push(
        err('BLOCKING_QUESTION', `Unresolved blocking question ${question.id} blocks ${gate}`, { artifact: question.id }),
      )
    }

    const deliveryBundle = await readJson(resolved, 'artifacts/design/delivery.json')
    if (deliveryBundle.__error) {
      errors.push(err('INVALID_DELIVERY', `Cannot read delivery.json: ${deliveryBundle.__error.message}`))
    } else {
      const phase = gate === 'final' ? 'final' : gate
      const deliveryResult = await validateDeliveryAsync(intakeBundle, deliveryBundle, {
        phase,
        projectRoot: status.project?.root,
        checkPaths: gate === 'plan' || gate === 'final',
      })
      if (!deliveryResult.ok) errors.push(...deliveryResult.errors)
    }

    const specText = await readText(resolved, 'artifacts/design/frontend-spec.md')
    if (gate === 'spec') {
      const scheme = validateTechScheme(specText, {
        intake: intakeBundle.__error ? undefined : intakeBundle,
      })
      if (!scheme.ok) errors.push(...scheme.errors)
    }
  }

  if (gate === 'plan') {
    const planText = await readText(resolved, 'artifacts/design/implementation-plan.md')
    if (looksLikePlaceholder(planText)) {
      errors.push(err('PLACEHOLDER_PLAN', 'implementation-plan.md still contains placeholder content'))
    }
  }

  if (gate === 'final') {
    // P02: require execution evidence slots; do not invent passed results.
    const taskResults = status.runtime?.taskResults || {}
    const deliveryBundle = await readJson(resolved, 'artifacts/design/delivery.json')
    if (!deliveryBundle.__error) {
      for (const task of deliveryBundle.tasks || []) {
        const result = taskResults[task.id]
        if (!result || result.reviewStatus !== 'passed') {
          errors.push(
            err(
              'MISSING_EXECUTION_EVIDENCE',
              `task ${task.id} lacks passed review evidence (produced in later phases)`,
              { artifact: task.id },
            ),
          )
        }
        if ((task.verify || []).length) {
          const verificationIds = result?.verificationIds || []
          const records = status.runtime?.verifications || {}
          if (!verificationIds.length) {
            errors.push(
              err(
                'MISSING_EXECUTION_EVIDENCE',
                `task ${task.id} has verify commands but no verification records`,
                { artifact: task.id },
              ),
            )
          } else if (!verificationIds.some((id) => records[id]?.status === 'passed')) {
            errors.push(
              err(
                'VERIFICATION_FAILED',
                `task ${task.id} has no passed verification record`,
                { artifact: task.id },
              ),
            )
          }
        }
      }
    }

    const changed = await readJson(resolved, 'artifacts/coding-changes/changed-files.json')
    if (changed.__error) {
      errors.push(err('MISSING_CHANGE_MANIFEST', 'changed-files.json is required for final'))
    } else if (!Array.isArray(changed.files) || changed.files.length === 0) {
      // Empty patch may be valid only if tasks claim no code — still require explicit registration.
      warnings.push(err('EMPTY_CHANGES', 'changed-files.json has no files; confirm intentional'))
    }

    const verification = await readText(resolved, 'artifacts/verification/verification.md')
    if (looksLikePlaceholder(verification)) {
      errors.push(err('PLACEHOLDER_VERIFICATION', 'verification.md still contains placeholder content'))
    }
    if (verification && /FAIL|failed|失败/i.test(verification) && !/all (checks )?passed/i.test(verification)) {
      // Soft signal only if explicit failure markers without overall pass note.
      if (/^\s*[-*].*\bFAIL\b/im.test(verification)) {
        errors.push(err('VERIFICATION_FAILED', 'verification.md reports failed checks'))
      }
    }

    if (!status.approvals?.final?.approvedBy) {
      // final gate evaluation before human approval may still run structural checks;
      // approval itself remains a separate control step.
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    requiredInputs,
  }
}

export { REQUIRED_INPUTS }
