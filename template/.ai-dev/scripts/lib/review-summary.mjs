/**
 * 解决什么问题：主 Agent / 人只需要三项可读结论，而不是整份报告。
 * 通过什么方式解决：从 report+decision 收成 pass / fail / needs_human，并带 event（passed / returned / needs_human）。
 * 触发时机：acceptReview 写 summary 时。
 * 被谁控制触发：reviews。
 */

import { decideReviewAction } from './review-loop.mjs'

function outcomeOf(report, decision) {
  if (decision.escalateTo === 'human' || report.verdict === 'needs_human') {
    return 'needs_human'
  }
  if (decision.action === 'accept' && report.verdict === 'pass') return 'pass'
  return 'fail'
}

function outcomeLabel(outcome) {
  if (outcome === 'pass') return '通过'
  if (outcome === 'needs_human') return '无法确定，需要人确认'
  return '未通过'
}

function nextEvent(outcome, report, decision) {
  if (outcome === 'pass') {
    return {
      type: 'review.passed',
      to: 'main',
      action: 'next',
      message: `${report.taskId || report.gate} 审核通过，主 Agent 执行 next`,
    }
  }
  if (outcome === 'needs_human') {
    return {
      type: 'review.needs_human',
      to: 'user',
      action: 'await_human',
      message: '子 Agent 无法判断，必须告知用户，主 Agent 不得代决',
    }
  }
  return {
    type: 'review.returned',
    to: 'main',
    action: decision.action,
    message: `${report.taskId || report.gate} 未通过，回主 Agent：${decision.reason}`,
  }
}

/**
 * 生成三项结论（通过 / 未通过 / 无法确定）与下一步事件。
 * needs_human 必须带 humanReasons，主 Agent 不得代决。
 * 缺 decision 时会现算 decideReviewAction。
 */
export function buildReviewSummary(report, options = {}) {
  const decision = options.decision || decideReviewAction({ report })
  const outcome = outcomeOf(report, decision)
  const checks = Array.isArray(report.checks) ? report.checks : []
  const findings = Array.isArray(report.findings) ? report.findings : []
  const reviewed = checks.map((check) => ({
    id: check.ruleId,
    result: check.result,
    evidence: check.evidence || [],
  }))
  const humanReasons = findings
    .filter((finding) => finding.requiresHuman || finding.severity === 'blocking')
    .map((finding) => finding.message || finding.id)
  if (outcome === 'needs_human' && !humanReasons.length) {
    humanReasons.push(decision.reason || '缺少已确认依据，子 Agent 不能自行结案')
  }

  return {
    schemaVersion: 1,
    gate: report.gate || null,
    taskId: report.taskId || null,
    outcome,
    outcomeLabel: outcomeLabel(outcome),
    reviewed,
    findings: findings.map((finding) => ({
      id: finding.id,
      severity: finding.severity,
      message: finding.message,
      location: finding.location || null,
      requiresHuman: Boolean(finding.requiresHuman),
    })),
    humanReasons,
    event: nextEvent(outcome, report, decision),
  }
}

/**
 * 把 summary 打成给人看的 Markdown：审了哪些、结论、未通过或需人确认的原因。
 */
export function renderReviewSummaryMarkdown(summary) {
  const lines = [
    '# 审核结果',
    '',
    `- 对象：${summary.taskId || summary.gate || 'unknown'}`,
    `- 结论：${summary.outcomeLabel}`,
    `- 下一步：${summary.event.message}`,
    '',
    '## 审核了哪些',
    '',
  ]
  if (!summary.reviewed.length) {
    lines.push('- （报告里没有检查项）')
  } else {
    for (const item of summary.reviewed) {
      const evidence = item.evidence.length ? ` — ${item.evidence.join('；')}` : ''
      lines.push(`- ${item.id}：${item.result}${evidence}`)
    }
  }
  lines.push('', '## 未通过 / 无法确定的原因', '')
  if (summary.outcome === 'pass') {
    lines.push('- 无。已通过项见上。')
  } else if (summary.outcome === 'needs_human') {
    for (const reason of summary.humanReasons) lines.push(`- 需人确认：${reason}`)
  } else if (!summary.findings.length) {
    lines.push(`- ${summary.event.message}`)
  } else {
    for (const finding of summary.findings) {
      const loc = finding.location ? `（${finding.location}）` : ''
      lines.push(`- ${finding.severity} ${finding.id}${loc}：${finding.message}`)
    }
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}
