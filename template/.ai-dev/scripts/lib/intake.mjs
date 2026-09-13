/**
 * 解决什么问题：分析阶段需要一份可校验、可渲染的结构化 intake，而不是自由文本。
 * 通过什么方式解决：校验 sources/evidence/requirements/questions 的引用与枚举，再单向生成 Markdown 视图。
 * 触发时机：写入或渲染 intake、闸门读 intake.json。
 * 被谁控制触发：分析脚本与 gates；不判断业务对错。
 */

export const SOURCE_KINDS = new Set(['prd', 'api', 'prototype', 'meeting', 'user', 'code'])
export const AVAILABILITIES = new Set(['available', 'unavailable'])
export const EVIDENCE_LABELS = new Set([
  'CONFIRMED',
  'USER_CONFIRMED',
  'CODE_EVIDENCE',
  'INFERRED',
  'CONFLICTED',
  'CONTRACT_GAP',
  'NOT_LOCATED',
  'OUT_OF_SCOPE',
])
export const OWNERSHIPS = new Set([
  'FRONTEND_BEHAVIOR',
  'BACKEND_DATA',
  'API_CONTRACT',
  'CROSS_REPOSITORY',
  'DESIGN_ASSET',
  'VERIFICATION',
  'UNKNOWN',
])
export const DISPOSITIONS = new Set(['included', 'excluded'])
export const QUESTION_STATUSES = new Set(['open', 'resolved'])
export const GATES = new Set(['scope', 'spec', 'plan', 'final'])

const ALLOWED_INCLUDED_LABELS = new Set(['CONFIRMED', 'USER_CONFIRMED', 'CODE_EVIDENCE'])

function err(code, message, extra = {}) {
  return { code, message, ruleId: code, ...extra }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function uniqueIds(items, field, errors, prefix) {
  const seen = new Set()
  for (const item of items) {
    const id = item?.[field]
    if (!isNonEmptyString(id)) {
      errors.push(err('MISSING_ID', `${prefix} entry is missing ${field}`))
      continue
    }
    if (seen.has(id)) {
      errors.push(err('DUPLICATE_ID', `Duplicate ${prefix} id: ${id}`, { artifact: id }))
    }
    seen.add(id)
  }
  return seen
}

/**
 * 结构校验 intake：schema、唯一 id、引用完整性与枚举。
 * included 需求不能只靠非确认证据，也不能只挂全部不可用源。
 * blocking 问题必须声明 blocksGates。不评业务语义。
 */
export function validateIntake(value) {
  const errors = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: [err('INVALID_INTAKE', 'intake must be an object')] }
  }
  if (value.schemaVersion !== 1) {
    errors.push(err('UNSUPPORTED_SCHEMA', `intake.schemaVersion must be 1`))
  }

  const sources = Array.isArray(value.sources) ? value.sources : null
  const evidence = Array.isArray(value.evidence) ? value.evidence : null
  const requirements = Array.isArray(value.requirements) ? value.requirements : null
  const questions = Array.isArray(value.questions) ? value.questions : null

  if (!sources) errors.push(err('INVALID_INTAKE', 'sources must be an array'))
  if (!evidence) errors.push(err('INVALID_INTAKE', 'evidence must be an array'))
  if (!requirements) errors.push(err('INVALID_INTAKE', 'requirements must be an array'))
  if (!questions) errors.push(err('INVALID_INTAKE', 'questions must be an array'))
  if (errors.length) return { ok: false, errors }

  const sourceIds = uniqueIds(sources, 'id', errors, 'source')
  const evidenceIds = uniqueIds(evidence, 'id', errors, 'evidence')
  const requirementIds = uniqueIds(requirements, 'id', errors, 'requirement')
  uniqueIds(questions, 'id', errors, 'question')

  for (const source of sources) {
    if (!SOURCE_KINDS.has(source.kind)) {
      errors.push(err('INVALID_SOURCE_KIND', `Invalid source.kind: ${source.kind}`, { artifact: source.id }))
    }
    if (!isNonEmptyString(source.locator)) {
      errors.push(err('MISSING_LOCATOR', `source ${source.id} requires locator`, { artifact: source.id }))
    }
    if (!isNonEmptyString(source.version)) {
      errors.push(err('MISSING_VERSION', `source ${source.id} requires version`, { artifact: source.id }))
    }
    if (!AVAILABILITIES.has(source.availability)) {
      errors.push(err('INVALID_AVAILABILITY', `Invalid availability for ${source.id}`, { artifact: source.id }))
    }
  }

  for (const item of evidence) {
    if (!isNonEmptyString(item.claim)) {
      errors.push(err('MISSING_CLAIM', `evidence ${item.id} requires claim`, { artifact: item.id }))
    }
    if (!EVIDENCE_LABELS.has(item.label)) {
      errors.push(err('INVALID_LABEL', `Invalid evidence label: ${item.label}`, { artifact: item.id }))
    }
    if (!sourceIds.has(item.sourceId)) {
      errors.push(err('UNKNOWN_SOURCE', `evidence ${item.id} references unknown source ${item.sourceId}`, { artifact: item.id }))
    }
    if (!isNonEmptyString(item.location)) {
      errors.push(err('MISSING_LOCATION', `evidence ${item.id} requires location`, { artifact: item.id }))
    }
  }

  for (const req of requirements) {
    if (!isNonEmptyString(req.statement)) {
      errors.push(err('MISSING_STATEMENT', `requirement ${req.id} requires statement`, { artifact: req.id }))
    }
    if (!OWNERSHIPS.has(req.ownership)) {
      errors.push(err('INVALID_OWNERSHIP', `Invalid ownership: ${req.ownership}`, { artifact: req.id }))
    }
    if (!DISPOSITIONS.has(req.disposition)) {
      errors.push(err('INVALID_DISPOSITION', `Invalid disposition: ${req.disposition}`, { artifact: req.id }))
    }
    if (req.disposition === 'excluded' && !isNonEmptyString(req.exclusionReason)) {
      errors.push(err('MISSING_EXCLUSION_REASON', `excluded requirement ${req.id} needs exclusionReason`, { artifact: req.id }))
    }
    if (!Array.isArray(req.evidenceIds) || !req.evidenceIds.length) {
      errors.push(err('MISSING_EVIDENCE', `requirement ${req.id} needs evidenceIds`, { artifact: req.id }))
      continue
    }
    const labels = []
    for (const evidenceId of req.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) {
        errors.push(err('UNKNOWN_EVIDENCE', `requirement ${req.id} references unknown evidence ${evidenceId}`, { artifact: req.id }))
        continue
      }
      const ev = evidence.find((row) => row.id === evidenceId)
      if (ev) labels.push(ev.label)
    }
    if (req.disposition === 'included') {
      const okLabel = labels.some((label) => ALLOWED_INCLUDED_LABELS.has(label))
      if (!okLabel && labels.length) {
        errors.push(
          err(
            'INFERRED_ONLY_REQUIREMENT',
            `included requirement ${req.id} cannot be supported only by non-confirming evidence`,
            { artifact: req.id },
          ),
        )
      }
      // Unavailable sources supporting included requirements are flagged for gates; still structural error if all sources unavailable.
      const linkedSources = req.evidenceIds
        .map((id) => evidence.find((row) => row.id === id))
        .filter(Boolean)
        .map((ev) => sources.find((source) => source.id === ev.sourceId))
        .filter(Boolean)
      if (linkedSources.length && linkedSources.every((source) => source.availability === 'unavailable')) {
        errors.push(
          err(
            'UNAVAILABLE_SOURCE',
            `included requirement ${req.id} depends only on unavailable sources`,
            { artifact: req.id },
          ),
        )
      }
    }
  }

  for (const question of questions) {
    if (!isNonEmptyString(question.text)) {
      errors.push(err('MISSING_QUESTION_TEXT', `question ${question.id} requires text`, { artifact: question.id }))
    }
    if (typeof question.blocking !== 'boolean') {
      errors.push(err('INVALID_BLOCKING', `question ${question.id} requires boolean blocking`, { artifact: question.id }))
    }
    if (!isNonEmptyString(question.owner)) {
      errors.push(err('MISSING_OWNER', `question ${question.id} requires owner`, { artifact: question.id }))
    }
    if (!QUESTION_STATUSES.has(question.status)) {
      errors.push(err('INVALID_QUESTION_STATUS', `Invalid question status: ${question.status}`, { artifact: question.id }))
    }
    if (!Array.isArray(question.blocksGates)) {
      errors.push(err('INVALID_BLOCKS_GATES', `question ${question.id} requires blocksGates array`, { artifact: question.id }))
    } else if (question.blocking === false && question.blocksGates.length) {
      errors.push(err('BLOCKS_GATES_NOT_EMPTY', `non-blocking question ${question.id} must have empty blocksGates`, { artifact: question.id }))
    } else if (question.blocking === true && !question.blocksGates.length) {
      errors.push(err('BLOCKS_GATES_REQUIRED', `blocking question ${question.id} requires non-empty blocksGates`, { artifact: question.id }))
    } else {
      for (const gate of question.blocksGates || []) {
        if (!GATES.has(gate)) {
          errors.push(err('INVALID_GATE', `question ${question.id} has invalid gate ${gate}`, { artifact: question.id }))
        }
      }
    }
    if (!Array.isArray(question.decisionEvidenceIds)) {
      errors.push(err('INVALID_DECISION_EVIDENCE', `question ${question.id} requires decisionEvidenceIds array`, { artifact: question.id }))
    } else if (question.status === 'resolved') {
      if (!question.decisionEvidenceIds.length) {
        errors.push(err('MISSING_DECISION_EVIDENCE', `resolved question ${question.id} needs decisionEvidenceIds`, { artifact: question.id }))
      }
      for (const evidenceId of question.decisionEvidenceIds) {
        if (!evidenceIds.has(evidenceId)) {
          errors.push(err('UNKNOWN_EVIDENCE', `question ${question.id} references unknown decision evidence ${evidenceId}`, { artifact: question.id }))
        }
      }
    }
  }

  return { ok: errors.length === 0, errors }
}

function escapeCell(value) {
  return String(value ?? '')
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/\|/g, '\\|')
}

function generatedHeader(kind) {
  return [
    `<!-- generated:from=artifacts/analysis/intake.json;kind=${kind};do-not-edit -->`,
    '',
  ].join('\n')
}

/**
 * 校验通过后单向生成 source-index / evidence / open-questions。
 * 带 generated 头，禁止当手写源。校验失败则拒绝覆盖视图。
 */
export function renderIntake(value) {
  const validation = validateIntake(value)
  if (!validation.ok) {
    const error = new Error(validation.errors.map((item) => item.message).join('; '))
    error.code = 'INVALID_INTAKE'
    error.errors = validation.errors
    throw error
  }

  const sourceRows = value.sources.map((source) =>
    `| ${escapeCell(source.id)} | ${escapeCell(source.locator)} | ${escapeCell(source.kind)} | ${escapeCell(source.locator)} / ${escapeCell(source.version)} | ${escapeCell(source.availability)} | ${escapeCell(source.contentHash ?? '')} |`,
  )
  const sourceIndex = [
    generatedHeader('source-index'),
    '# Source index',
    '',
    '| ID | Title | Type | Location/version | Availability | Notes |',
    '| --- | --- | --- | --- | --- | --- |',
    ...sourceRows,
    '',
    '## Sanitization',
    '',
    '- [ ] Access tokens and credentials removed',
    '- [ ] Personal data minimized',
    '- [ ] Embedded images referenced without copying oversized Base64 content',
    '',
  ].join('\n')

  const evidenceRows = value.evidence.map((item) =>
    `| ${escapeCell(item.id)} | ${escapeCell(item.claim)} | ${escapeCell(item.label)} | ${escapeCell(item.sourceId)} @ ${escapeCell(item.location)} | | |`,
  )
  const evidenceMd = [
    generatedHeader('evidence'),
    '# Evidence ledger',
    '',
    '| ID | Claim | Label | Source pointer | Repository pointer | Consequence |',
    '| --- | --- | --- | --- | --- | --- |',
    ...evidenceRows,
    '',
  ].join('\n')

  const questionRows = value.questions.length
    ? value.questions.map((question) =>
      `| ${escapeCell(question.id)} | ${escapeCell(question.text)} | ${escapeCell(question.blocking ? question.blocksGates.join(',') : 'none')} | ${escapeCell(question.owner)} | ${escapeCell(question.status)} | ${escapeCell((question.decisionEvidenceIds || []).join(', '))} |`,
    )
    : ['| — | — | — | — | — | — |']
  const questionsMd = [
    generatedHeader('open-questions'),
    '# Open questions',
    '',
    '| ID | Question | Why it blocks | Owner | Status | Decision evidence |',
    '| --- | --- | --- | --- | --- | --- |',
    ...questionRows,
    '',
    'Only questions that materially change scope, behavior, contracts, or verification belong here.',
    '',
  ].join('\n')

  return {
    'artifacts/analysis/source-index.md': sourceIndex,
    'artifacts/analysis/evidence.md': evidenceMd,
    'artifacts/analysis/open-questions.md': questionsMd,
  }
}

/** 空的 v1 intake 骨架，供新建 feature。 */
export function emptyIntake() {
  return {
    schemaVersion: 1,
    sources: [],
    evidence: [],
    requirements: [],
    questions: [],
  }
}
