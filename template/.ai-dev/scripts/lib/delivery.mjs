/**
 * 解决什么问题：交付物（验收、任务、追溯）必须结构完整且路径不逃出项目。
 * 通过什么方式解决：按 phase 校验覆盖与依赖环，异步核文件路径；再渲染 Markdown 视图。
 * 触发时机：写 delivery.json、闸门、渲染验收/任务/追溯。
 * 被谁控制触发：设计脚本与 gates。
 */

import path from 'node:path'
import { access, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'

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
    if (seen.has(id)) errors.push(err('DUPLICATE_ID', `Duplicate ${prefix} id: ${id}`, { artifact: id }))
    seen.add(id)
  }
  return seen
}

function includedRequirements(intake) {
  return (intake.requirements || []).filter((req) => req.disposition === 'included')
}

function detectTaskCycle(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const color = new Map() // 0 white, 1 gray, 2 black

  function visit(id, stack) {
    const state = color.get(id) || 0
    if (state === 1) return true
    if (state === 2) return false
    color.set(id, 1)
    const task = byId.get(id)
    for (const dep of task?.dependsOn || []) {
      if (!byId.has(dep)) continue
      if (visit(dep, stack)) return true
    }
    color.set(id, 2)
    return false
  }

  for (const task of tasks) {
    if (visit(task.id, [])) return true
  }
  return false
}

async function assertPathInsideProject(projectRoot, relativePath, operation, errors, taskId) {
  if (!isNonEmptyString(relativePath)) {
    errors.push(err('INVALID_PATH', `task ${taskId} has empty file path`, { artifact: taskId }))
    return
  }
  if (path.isAbsolute(relativePath)) {
    errors.push(err('PATH_ESCAPE', `task ${taskId} path must be relative: ${relativePath}`, { artifact: taskId }))
    return
  }

  const normalized = path.normalize(relativePath)
  const absolute = path.resolve(projectRoot, normalized)
  const relative = path.relative(projectRoot, absolute)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    errors.push(err('PATH_ESCAPE', `task ${taskId} path escapes project: ${relativePath}`, { artifact: taskId }))
    return
  }
  if (relative === '.ai-dev' || relative.startsWith(`.ai-dev${path.sep}`)) {
    errors.push(err('PATH_IN_WORKFLOW', `task ${taskId} path must stay outside .ai-dev`, { artifact: taskId }))
    return
  }

  if (!projectRoot) return

  try {
    if (operation === 'create') {
      let cursor = path.dirname(absolute)
      while (true) {
        try {
          await access(cursor, constants.F_OK)
          const realParent = await realpath(cursor)
          const parentRel = path.relative(await realpath(projectRoot), realParent)
          if (parentRel.startsWith('..') || path.isAbsolute(parentRel)) {
            errors.push(err('PATH_ESCAPE', `task ${taskId} create path escapes via symlink parents`, { artifact: taskId }))
          }
          break
        } catch {
          const parent = path.dirname(cursor)
          if (parent === cursor) break
          cursor = parent
        }
      }
    } else {
      try {
        await access(absolute, constants.F_OK)
        const realFile = await realpath(absolute)
        const fileRel = path.relative(await realpath(projectRoot), realFile)
        if (fileRel.startsWith('..') || path.isAbsolute(fileRel)) {
          errors.push(err('PATH_ESCAPE', `task ${taskId} ${operation} target escapes project`, { artifact: taskId }))
        }
      } catch {
        errors.push(
          err(
            'MISSING_FILE_EVIDENCE',
            `task ${taskId} ${operation} requires an existing file: ${relativePath}`,
            { artifact: taskId },
          ),
        )
      }
    }
  } catch (error) {
    errors.push(err('PATH_CHECK_FAILED', `task ${taskId} path check failed: ${error.message}`, { artifact: taskId }))
  }
}

/**
 * 同步结构校验 delivery。验收/任务必须挂 included 需求，禁止环依赖。
 * spec 起要求验收覆盖；plan/final 还要任务覆盖与 links 对齐。
 * 不碰文件系统；路径沙箱留给 validateDeliveryAsync。
 */
export function validateDelivery(intake, delivery, options = {}) {
  const errors = []
  const phase = options.phase || 'plan'

  if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery)) {
    return { ok: false, errors: [err('INVALID_DELIVERY', 'delivery must be an object')] }
  }
  if (delivery.schemaVersion !== 1) {
    errors.push(err('UNSUPPORTED_SCHEMA', 'delivery.schemaVersion must be 1'))
  }

  const acceptance = Array.isArray(delivery.acceptance) ? delivery.acceptance : null
  const tasks = Array.isArray(delivery.tasks) ? delivery.tasks : null
  const links = Array.isArray(delivery.links) ? delivery.links : null
  if (!acceptance || !tasks || !links) {
    return {
      ok: false,
      errors: [err('INVALID_DELIVERY', 'acceptance, tasks, and links must be arrays')],
    }
  }

  const requirementIds = new Set((intake?.requirements || []).map((req) => req.id))
  const included = includedRequirements(intake || { requirements: [] })
  const includedIds = new Set(included.map((req) => req.id))
  const acceptanceIds = uniqueIds(acceptance, 'id', errors, 'acceptance')
  const taskIds = uniqueIds(tasks, 'id', errors, 'task')

  for (const item of acceptance) {
    for (const field of ['given', 'when', 'then', 'verification']) {
      if (!isNonEmptyString(item[field])) {
        errors.push(err('MISSING_ACCEPTANCE_FIELD', `acceptance ${item.id} requires ${field}`, { artifact: item.id }))
      }
    }
    if (!Array.isArray(item.requirementIds) || !item.requirementIds.length) {
      errors.push(err('MISSING_REQUIREMENT_LINK', `acceptance ${item.id} needs requirementIds`, { artifact: item.id }))
    } else {
      for (const requirementId of item.requirementIds) {
        if (!requirementIds.has(requirementId)) {
          errors.push(err('UNKNOWN_REQUIREMENT', `acceptance ${item.id} references ${requirementId}`, { artifact: item.id }))
        }
        if (requirementIds.has(requirementId) && !includedIds.has(requirementId)) {
          errors.push(err('EXCLUDED_REQUIREMENT', `acceptance ${item.id} links excluded requirement ${requirementId}`, { artifact: item.id }))
        }
      }
    }
  }

  for (const task of tasks) {
    if (!isNonEmptyString(task.title)) {
      errors.push(err('MISSING_TITLE', `task ${task.id} requires title`, { artifact: task.id }))
    }
    if (!Array.isArray(task.requirementIds) || !task.requirementIds.length) {
      errors.push(err('MISSING_REQUIREMENT_LINK', `task ${task.id} needs requirementIds`, { artifact: task.id }))
    } else {
      for (const requirementId of task.requirementIds) {
        if (!requirementIds.has(requirementId)) {
          errors.push(err('UNKNOWN_REQUIREMENT', `task ${task.id} references ${requirementId}`, { artifact: task.id }))
        }
        if (requirementIds.has(requirementId) && !includedIds.has(requirementId)) {
          errors.push(err('EXCLUDED_REQUIREMENT', `task ${task.id} implements excluded requirement ${requirementId}`, { artifact: task.id }))
        }
      }
    }
    if (!Array.isArray(task.acceptanceIds) || !task.acceptanceIds.length) {
      errors.push(err('MISSING_ACCEPTANCE_LINK', `task ${task.id} needs acceptanceIds`, { artifact: task.id }))
    } else {
      for (const acceptanceId of task.acceptanceIds) {
        if (!acceptanceIds.has(acceptanceId)) {
          errors.push(err('UNKNOWN_ACCEPTANCE', `task ${task.id} references ${acceptanceId}`, { artifact: task.id }))
        }
      }
    }
    if (!Array.isArray(task.dependsOn)) {
      errors.push(err('INVALID_DEPENDS_ON', `task ${task.id} requires dependsOn array`, { artifact: task.id }))
    } else {
      for (const dep of task.dependsOn) {
        if (!taskIds.has(dep)) {
          errors.push(err('UNKNOWN_TASK_DEP', `task ${task.id} depends on unknown ${dep}`, { artifact: task.id }))
        }
      }
    }
    if (!Array.isArray(task.files) || !task.files.length) {
      errors.push(err('MISSING_FILES', `task ${task.id} needs files`, { artifact: task.id }))
    } else {
      for (const file of task.files) {
        if (!['create', 'modify', 'delete'].includes(file.operation)) {
          errors.push(err('INVALID_OPERATION', `task ${task.id} has invalid file operation`, { artifact: task.id }))
        }
        if (!isNonEmptyString(file.path) || path.isAbsolute(file.path)) {
          errors.push(err('PATH_ESCAPE', `task ${task.id} path must be a relative project path`, { artifact: task.id }))
        } else {
          const normalized = path.normalize(file.path)
          if (normalized.split(path.sep).includes('..') || normalized.startsWith('..')) {
            errors.push(err('PATH_ESCAPE', `task ${task.id} path escapes project: ${file.path}`, { artifact: task.id }))
          }
        }
      }
    }
    if (!Array.isArray(task.steps) || !task.steps.length) {
      errors.push(err('MISSING_STEPS', `task ${task.id} needs steps`, { artifact: task.id }))
    }
    if (!Array.isArray(task.verify) || !task.verify.length) {
      errors.push(err('MISSING_VERIFY', `task ${task.id} needs verify commands`, { artifact: task.id }))
    }
  }

  if (detectTaskCycle(tasks)) {
    errors.push(err('TASK_CYCLE', 'task dependsOn graph contains a cycle'))
  }

  if (phase === 'spec' || phase === 'plan' || phase === 'final') {
    for (const req of included) {
      const covered = acceptance.some((item) => (item.requirementIds || []).includes(req.id))
      if (!covered) {
        errors.push(err('REQUIREMENT_UNCOVERED', `included requirement ${req.id} has no acceptance`, { artifact: req.id }))
      }
    }
  }

  if (phase === 'plan' || phase === 'final') {
    for (const req of included) {
      const tasked = tasks.some((task) => (task.requirementIds || []).includes(req.id))
      if (!tasked) {
        errors.push(err('REQUIREMENT_WITHOUT_TASK', `included requirement ${req.id} has no task`, { artifact: req.id }))
      }
    }
    for (const item of acceptance) {
      const tasked = tasks.some((task) => (task.acceptanceIds || []).includes(item.id))
      if (!tasked) {
        errors.push(err('ACCEPTANCE_WITHOUT_TASK', `acceptance ${item.id} has no task`, { artifact: item.id }))
      }
    }
    for (const link of links) {
      if (!includedIds.has(link.requirementId)) {
        errors.push(err('UNKNOWN_REQUIREMENT', `link references requirement ${link.requirementId}`))
      }
      if (!acceptanceIds.has(link.acceptanceId)) {
        errors.push(err('UNKNOWN_ACCEPTANCE', `link references acceptance ${link.acceptanceId}`))
      }
      if (!taskIds.has(link.taskId)) {
        errors.push(err('UNKNOWN_TASK', `link references task ${link.taskId}`))
      }
    }
  }

  // Path checks are async-capable via validateDeliveryAsync; sync API skips FS unless caller pre-validated.
  if (options.checkPaths === false) {
    // no-op
  }

  return { ok: errors.length === 0, errors }
}

/**
 * 在同步校验上按需做路径沙箱：必须相对路径、不得逃出项目、不得写 .ai-dev。
 * create 沿父目录查 symlink；modify/delete 要求目标已存在且仍在项目内。
 */
export async function validateDeliveryAsync(intake, delivery, options = {}) {
  const base = validateDelivery(intake, delivery, options)
  const errors = [...base.errors]
  const projectRoot = options.projectRoot
  const tasks = Array.isArray(delivery?.tasks) ? delivery.tasks : []
  if (projectRoot && (options.phase === 'plan' || options.phase === 'final' || options.checkPaths)) {
    for (const task of tasks) {
      for (const file of task.files || []) {
        await assertPathInsideProject(projectRoot, file.path, file.operation, errors, task.id)
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
  return `<!-- generated:from=artifacts/design/delivery.json;kind=${kind};do-not-edit -->\n`
}

/**
 * 校验通过后单向生成 acceptance / tasks / traceability。
 * 默认拒绝半成品覆盖视图。任务状态来自 runtime.taskResults。
 */
export function renderDelivery(intake, delivery, taskResults = {}) {
  const validation = validateDelivery(intake, delivery, { phase: 'plan', checkPaths: false })
  if (!validation.ok) {
    // Allow rendering during early drafting only when explicitly forced by caller;
    // default: refuse partial overwrite of views.
    const error = new Error(validation.errors.map((item) => item.message).join('; '))
    error.code = 'INVALID_DELIVERY'
    error.errors = validation.errors
    throw error
  }

  const acceptanceRows = delivery.acceptance.map((item) =>
    `| ${escapeCell(item.id)} | ${escapeCell((item.requirementIds || []).join(', '))} | ${escapeCell(`${item.given} / ${item.when} / ${item.then}`)} | ${escapeCell(item.verification)} | PENDING |`,
  )
  const acceptanceMd = [
    generatedHeader('acceptance'),
    '# Acceptance',
    '',
    '| ID | Requirement | Scenario | Expected evidence | Status |',
    '| --- | --- | --- | --- | --- |',
    ...acceptanceRows,
    '',
  ].join('\n')

  const taskSections = delivery.tasks.map((task) => {
    const result = taskResults[task.id]
    const status = result?.status || 'PENDING'
    return [
      `## ${escapeCell(task.id)} ${escapeCell(task.title)}`,
      '',
      `- Requirements: ${(task.requirementIds || []).map(escapeCell).join(', ')}`,
      `- Acceptance: ${(task.acceptanceIds || []).map(escapeCell).join(', ')}`,
      `- Allowed files: ${(task.files || []).map((file) => `${file.operation}:${file.path}`).map(escapeCell).join(', ')}`,
      `- Depends on: ${(task.dependsOn || []).length ? task.dependsOn.map(escapeCell).join(', ') : 'none'}`,
      `- Steps: ${(task.steps || []).map(escapeCell).join('; ')}`,
      `- Verify: ${(task.verify || []).map((cmd) => `${cmd.command} ${(cmd.args || []).join(' ')}`).map(escapeCell).join('; ')}`,
      `- Status: ${escapeCell(status)}`,
      '',
    ].join('\n')
  })
  const tasksMd = [
    generatedHeader('tasks'),
    '# Tasks',
    '',
    ...taskSections,
  ].join('\n')

  const reqById = new Map((intake.requirements || []).map((req) => [req.id, req]))
  const traceRows = delivery.links.map((link) => {
    const req = reqById.get(link.requirementId)
    const evidence = (req?.evidenceIds || []).join(', ')
    const result = taskResults[link.taskId]?.status || 'PENDING'
    return `| ${escapeCell(link.requirementId)} | ${escapeCell(evidence)} | ${escapeCell(req?.ownership || '')} | | ${escapeCell(link.taskId)} | ${escapeCell(link.acceptanceId)} | ${escapeCell(result)} |`
  })
  const traceMd = [
    generatedHeader('traceability'),
    '# Traceability',
    '',
    '| Requirement | Evidence | Ownership | Code | Task | Acceptance | Result |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...traceRows,
    '',
  ].join('\n')

  return {
    'artifacts/design/acceptance.md': acceptanceMd,
    'artifacts/design/tasks.md': tasksMd,
    'artifacts/design/traceability.md': traceMd,
  }
}

/** 空的 v1 delivery 骨架，供新建 feature。 */
export function emptyDelivery() {
  return {
    schemaVersion: 1,
    acceptance: [],
    tasks: [],
    links: [],
  }
}
