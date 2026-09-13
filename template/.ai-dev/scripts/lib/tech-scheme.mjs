/**
 * 解决什么问题：frontend-spec.md 必须让开发看见结构和引用，而不是空模板。
 * 通过什么方式解决：检查围栏 mermaid 是否含 flowchart/graph 与 sequenceDiagram，且正文引用 included 需求 id。
 * 触发时机：spec 闸 evaluateGate。
 * 被谁控制触发：gates。
 */

function err(code, message, extra = {}) {
  return { code, message, ruleId: code, ...extra }
}

/** 抽出围栏 mermaid 块正文，供图类型检查。 */
function mermaidBodies(markdown) {
  if (typeof markdown !== 'string') return []
  const bodies = []
  const pattern = /```mermaid\s*([\s\S]*?)```/gi
  let match
  while ((match = pattern.exec(markdown))) {
    bodies.push(match[1])
  }
  return bodies
}

function hasDiagram(bodies, kinds) {
  return bodies.some((body) => kinds.some((kind) => new RegExp(`^\\s*${kind}\\b`, 'im').test(body)))
}

/**
 * 结构检查技术说明。缺图、缺 flowchart/graph、缺 sequenceDiagram、未引用 included FR 都失败。
 * 不评图对不对，只认围栏 mermaid 与正文是否出现需求 id。
 */
export function validateTechScheme(markdown, options = {}) {
  const errors = []
  if (markdown == null || !String(markdown).trim()) {
    return { ok: false, errors: [err('MISSING_TECH_SCHEME', 'frontend-spec.md is missing')] }
  }

  const text = String(markdown)
  if (options.requirePlaceholdersClean !== false) {
    if (/\[TODO\]|TODO: fill|<!-- placeholder/i.test(text)) {
      errors.push(err('PLACEHOLDER_SPEC', 'tech scheme still contains placeholder content'))
    }
  }

  const bodies = mermaidBodies(text)
  // 至少一张 flowchart 或 graph，外加 sequenceDiagram，并在正文引用 included 需求 id。
  if (!bodies.length) {
    errors.push(err('MISSING_DIAGRAM', 'tech scheme needs fenced mermaid diagrams for developers'))
  }
  if (!hasDiagram(bodies, ['flowchart', 'graph'])) {
    errors.push(err('MISSING_FLOWCHART', 'tech scheme needs a mermaid flowchart or graph'))
  }
  if (!hasDiagram(bodies, ['sequenceDiagram'])) {
    errors.push(err('MISSING_SEQUENCE', 'tech scheme needs a mermaid sequenceDiagram'))
  }

  const included = (options.intake?.requirements || []).filter((req) => req.disposition === 'included')
  for (const req of included) {
    if (req.id && !text.includes(req.id)) {
      errors.push(
        err('TECH_SCHEME_UNCITED', `tech scheme does not cite included requirement ${req.id}`, { artifact: req.id }),
      )
    }
  }

  return { ok: errors.length === 0, errors }
}

export { mermaidBodies }
