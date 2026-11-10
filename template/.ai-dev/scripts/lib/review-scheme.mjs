import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { mermaidBodies } from './tech-scheme.mjs'

export const REVIEW_SCHEME = 'artifacts/design/技术方案-技术评审使用.md'
export const REVIEW_SYNC = 'artifacts/design/review-scheme-sync.json'
export const REVIEW_SOURCES = ['artifacts/design/frontend-spec.md', 'artifacts/analysis/intake.json', 'artifacts/design/delivery.json', REVIEW_SCHEME]
export const CONSISTENCY_CHECKS = ['scope', 'behavior', 'contracts', 'boundaries', 'technicalDecisions', 'noAddedRules']

// Hashes prove version alignment, not semantic equivalence. The recorded checks
// are evidence for a reviewer to independently inspect, never an approval.
export async function reviewSchemeDigests(featureDir) {
  const digests = {}
  for (const relative of REVIEW_SOURCES) {
    digests[relative] = createHash('sha256').update(await readFile(path.join(featureDir, relative))).digest('hex')
  }
  return digests
}

export async function validateReviewScheme(featureDir, recordOverride) {
  const errors = []
  const fail = (code, message) => errors.push({ code, ruleId: code, message })
  try {
    const markdown = await readFile(path.join(featureDir, REVIEW_SCHEME), 'utf8')
    const record = recordOverride ?? JSON.parse(await readFile(path.join(featureDir, REVIEW_SYNC), 'utf8'))
    const intake = JSON.parse(await readFile(path.join(featureDir, REVIEW_SOURCES[1]), 'utf8'))
    const delivery = JSON.parse(await readFile(path.join(featureDir, REVIEW_SOURCES[2]), 'utf8'))
    if (!markdown.trim() || /\[TODO\]|TODO: fill|<!-- placeholder/i.test(markdown)) fail('REVIEW_SCHEME_PLACEHOLDER', '评审版仍为空或含占位符')
    // Two separately labelled diagrams: architecture and business flow may both use flowchart.
    for (const heading of ['架构图', '流程图']) {
      const section = markdown.split(/^## /m).find(part => part.split('\n')[0].trim() === heading)
      if (!section || !mermaidBodies(section).some(body => /^\s*(flowchart|graph)\b/m.test(body))) {
        fail('REVIEW_SCHEME_DIAGRAM', `评审版需要 ## ${heading} 下的 Mermaid flowchart/graph`)
      }
    }
    if (record.schemaVersion !== 1 || typeof record.checkedBy !== 'string' || !record.checkedBy.trim()) fail('REVIEW_SYNC_INVALID', '一致性记录需要 schemaVersion:1 和 checkedBy')
    const headings = [...markdown.matchAll(/^#{1,6} +(.+?)\s*$/gm)].map(match => match[1])
    const ids = [...(intake.requirements || []).filter(item => item.disposition === 'included'), ...(delivery.acceptance || [])].map(item => item.id)
    for (const id of ids) {
      const entry = record.coverage?.[id]
      if (!entry || !headings.includes(entry.section) || typeof entry.evidence !== 'string' || !entry.evidence.trim()) fail('REVIEW_SYNC_COVERAGE', `${id} 缺少有效评审版章节及一致性说明`)
    }
    for (const key of CONSISTENCY_CHECKS) {
      const check = record.checks?.[key]
      if (check?.result !== 'pass' || typeof check.evidence !== 'string' || !check.evidence.trim()) fail('REVIEW_SYNC_CHECK', `${key} 未完成两版内容核对`)
    }
    const digests = await reviewSchemeDigests(featureDir)
    for (const [file, digest] of Object.entries(digests)) {
      if (record.digests?.[file] !== digest) fail('REVIEW_SYNC_STALE', `${file} 已变化，请同步两版并重新检查`)
    }
  } catch (error) {
    fail('REVIEW_SYNC_MISSING', `无法读取评审版或一致性记录：${error.message}`)
  }
  return { ok: errors.length === 0, errors }
}
