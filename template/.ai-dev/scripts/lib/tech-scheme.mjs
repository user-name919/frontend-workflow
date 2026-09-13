/**
 * Developer-facing tech scheme (frontend-spec.md) is a byproduct of intake/delivery.
 * Structural checks only: diagrams exist and confirmed IDs are cited.
 */

function err(code, message, extra = {}) {
  return { code, message, ruleId: code, ...extra }
}

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
 * @param {string|null} markdown
 * @param {{intake?: object, requirePlaceholdersClean?: boolean}} [options]
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
