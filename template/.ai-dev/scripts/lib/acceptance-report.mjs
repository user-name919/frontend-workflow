/** 面向人的派生阅读视图；准入继续读取原始报告、图片指纹和候选快照。 */
import { redactRuntimeURL } from './test-runtime.mjs'

const labels = { passed: '通过', failed: '失败', blocked: '阻塞', flaky: '不稳定', pending: '待确认', not_run: '未执行', not_verified: '未验收', stale: '已过期', running: '执行中', interrupted: '已中断', unverified: '缺少有效证据', met: '满足', unmet: '不满足' }
const methods = { browser: '浏览器自动测试', inspection: '静态检查', manual: '人工验收' }
const kinds = { 'contract-mock': 'Mock 契约（接口替换）', 'live-test': '真实接口', local: '本地工程检查' }
const state = value => labels[value] || value || '未记录'
export function reviewText(value) {
  return String(value ?? '').replace(/\u001b\[[0-9;]*m/g, '').replace(/https?:\/\/[^\s<>"']+/g, value => {
    try { const url = new URL(redactRuntimeURL(value)); url.username = ''; url.password = ''; return url.href } catch { return '[无效 URL]' }
  }).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
}
const h = value => reviewText(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
const href = value => String(value).split('/').map(encodeURIComponent).join('/')
const link = (file, text) => `<a href="${h(href(file))}">${h(text)}</a>`
const badge = value => `<span class="badge ${['passed','failed','blocked','stale'].includes(value) ? value : ''}">${h(state(value))}</span>`
const table = (headings, rows) => `<div class="scroll"><table><thead><tr>${headings.map(v => `<th>${h(v)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(v => `<td>${v}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
const list = values => `<ul>${values.map(v => `<li>${h(v)}</li>`).join('')}</ul>`

function document(title, body) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'"><title>${h(title)}</title><style>
body{margin:0;background:#f4f6f9;color:#202b3d;font:15px/1.65 system-ui,-apple-system,sans-serif}main{max-width:1120px;margin:40px auto;padding:0 24px 48px}h1{font-size:28px;line-height:1.3}h2{font-size:21px;margin-top:32px}h3{font-size:17px}a{color:#174faa;overflow-wrap:anywhere}p,li,td{overflow-wrap:anywhere}small,.muted{color:#58657b}.notice{background:#fff5db;border-left:4px solid #c58b13;padding:14px 18px}.card{background:white;border:1px solid #dbe1eb;border-radius:12px;padding:22px;margin:18px 0}.badge{display:inline-block;border-radius:6px;padding:2px 9px;background:#e9edf5;white-space:nowrap}.passed{background:#ddf3e6;color:#145d34}.failed{background:#ffe2e1;color:#9d2222}.blocked,.stale{background:#fff0ce;color:#7b5100}.scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;background:white}th,td{padding:12px;border-bottom:1px solid #dbe1eb;text-align:left;vertical-align:top}th{background:#eaf0f7}td:first-child{min-width:90px}details{margin:12px 0}summary{cursor:pointer;font-weight:600}.shots{display:flex;flex-wrap:wrap;gap:14px}figure{margin:8px 0;max-width:400px}img{display:block;max-width:100%;max-height:300px;border:1px solid #dbe1eb;object-fit:contain}figcaption{font-size:13px;color:#58657b}code{overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere}@media(max-width:600px){main{margin:20px auto;padding:0 14px}.card{padding:14px}h1{font-size:24px}}
</style></head><body><main>${body}</main></body></html>\n`
}

function sources(tc, delivery, intake) {
  return tc.acceptanceIds.flatMap(id => {
    const ac = delivery.acceptance.find(item => item.id === id)
    return (ac?.requirementIds || []).map(id => {
      const rule = intake.requirements.find(item => item.id === id)
      const origins = (rule?.evidenceIds || []).map(id => {
        const evidence = intake.evidence.find(item => item.id === id)
        const source = intake.sources.find(item => item.id === evidence?.sourceId)
        return [source?.locator, evidence?.location].filter(Boolean).join(' · ')
      }).filter(Boolean)
      return `${id}：${rule?.statement || '需求来源未找到'}${origins.length ? '（' + origins.join('；') + '）' : ''}`
    })
  })
}

function caseDetail(tc, actual, delivery, intake) {
  const observations = actual?.expectationResults || actual?.context?.expectationResults || []
  const preconditions = actual?.preconditionResults || actual?.context?.preconditionResults || []
  const pictures = actual?.visualEvidence?.screenshots || []
  const runtime = actual?.context?.runtime
  const errors = [...(actual?.errors || []), ...(actual?.attempts || []).flatMap(attempt => (attempt.errors || []).map(error => error.message || String(error)))]
  return `<section class="card" id="${h(tc.id)}"><h2>${h(tc.id)} ${badge(actual?.status || 'not_run')}</h2>
<p>${h(methods[tc.method])} · ${h(tc.environmentId)} · ${h(tc.implementation?.file || '')}</p>
<details><summary>需求依据与计划操作</summary>${list(sources(tc, delivery, intake))}<p class="muted">以下为计划步骤；是否真正执行，请对照下方观察、截图和测试代码。</p><ol>${tc.steps.map(step => `<li>${h(step)}</li>`).join('')}</ol></details>
${runtime ? `<p>入口：${h(runtime.entryURL || '未就绪')} · 配置：${h(runtime.profileId)}</p><p>候选版本观察：${h(runtime.candidateObservation || '未记录')}</p>${list([...(runtime.services || []), ...(runtime.prerequisites || [])].map(item => `${item.id}：${state(item.result)} — ${item.observation}`))}` : ''}
${table(['前提', '实际观察'], tc.preconditions.map((expected, index) => { const p = preconditions.find(p => p.index === index); return [h(expected), `${badge(p?.result)} ${h(p?.observation || '未记录')}`] }))}
${tc.expectations.map(expected => {
    const observed = observations.find(item => item.id === expected.id)
    const screenshots = pictures.filter(item => item.expectationId === expected.id)
    return `<h3>${h(expected.id)} ${badge(observed?.result)}</h3><p><b>预期：</b>${h(expected.expected)}</p><p><b>实际：</b>${h(observed?.observation || '未执行或未提供观察')}</p>
${screenshots.length ? `<div class="shots">${screenshots.map((item, index) => `<figure><a href="${h(href(item.path))}"><img loading="lazy" src="${h(href(item.path))}" alt="${h(tc.id)} / ${h(expected.id)} 实际页面 ${index + 1}"></a><figcaption>${h(tc.id)} / ${h(expected.id)} · 点击查看原图</figcaption></figure>`).join('')}</div>` : `<p class="muted">${['ui','navigation'].includes(expected.observable) ? '无截图，不能凭此报告目视复核该状态。' : '此项主要依靠请求、存储等断言，截图不能替代断言。'}</p>`}`
  }).join('')}${errors.length ? `<details open><summary>失败或证据问题</summary>${list(errors)}</details>` : ''}</section>`
}

export function renderRunReview(record, delivery, intake) {
  const check = delivery.verification.checks.find(item => item.id === record.checkId)
  const environment = delivery.verification.environments.find(item => item.id === record.environmentId)
  const cases = delivery.testCases.filter(tc => check?.caseIds.includes(tc.id))
  const screenshotCount = new Set((record.cases || []).flatMap(tc => (tc.visualEvidence?.screenshots || []).map(item => item.path))).size
  return document('验收运行报告', `<p>${link('../../../artifacts/verification/index.html', '返回需求验收总览')}</p><h1>验收运行报告 ${badge(record.status)}</h1>
<p>${h(record.scope === 'task' ? `任务 ${record.taskId} · DONE 交审前` : '最终候选版本 · 整单验收')} · ${h(check?.id)} · ${h(kinds[environment?.kind] || environment?.kind)}</p>
<p>${h(record.startedAt)} → ${h(record.endedAt)} · ${cases.length} 个业务用例 · ${screenshotCount} 张截图</p>
<p>运行：${h(record.id)}<br>候选快照：${h(record.inputSnapshotId)}<br>测试入口：${h(environment?.baseURL || '本地命令')}</p>
<p class="notice">这是本次运行结束时的记录。代码变化后需重新执行；当前有效性见总览。${environment?.kind === 'contract-mock' ? '本次使用接口替换，只证明受控条件下的前端行为，不代表后端联调通过。' : ''} 截图辅助人审查，不能替代业务断言。</p>
${record.summary ? `<p>${h(record.summary)}</p>` : ''}
<p>${link('record.json','运行记录')} · ${record.rawReportPath ? link('raw-report.json','原始测试报告') + ' · ' : ''}${link('stdout.log','标准输出')} · ${link('stderr.log','错误与浏览器输出')}</p>
${cases.length ? table(['用例', '检查内容', '结果'], cases.map(tc => [`<a href="#${h(tc.id)}">${h(tc.id)}</a>`, h(tc.expectations.map(e => e.expected).join('；')), badge(record.cases.find(item => item.caseId === tc.id)?.status || 'not_run')])) : '<p>本次是工程检查，不计为业务验收用例。</p>'}
${cases.map(tc => caseDetail(tc, record.cases.find(item => item.caseId === tc.id), delivery, intake)).join('')}`)
}

export function renderAcceptanceOverview(summary, status, delivery) {
  const plannedCases = Array.isArray(delivery.testCases) ? delivery.testCases : []
  const environments = Array.isArray(delivery.verification?.environments) ? delivery.verification.environments : []
  const plannedChecks = Array.isArray(delivery.verification?.checks) ? delivery.verification.checks : []
  const runs = Object.values(status.runtime?.verifications || {}).sort((a,b) => b.sequence - a.sequence)
  const viewLink = run => run ? link(`../../${run.reportPath || run.recordRef}`, run.reportPath ? '查看步骤、结果和截图' : '历史原始记录（无截图报告）') : '尚未执行'
  const caseRows = summary.cases.map(item => {
    const tc = plannedCases.find(tc => tc.id === item.caseId)
    const check = summary.checks.find(check => plannedChecks.find(c => c.id === check.checkId)?.caseIds?.includes(item.caseId))
    const effective = item.status === 'not_verified' && check?.status !== 'passed' ? check?.status || item.status : item.status
    return [h(tc.id), h(tc.expectations.map(e => e.expected).join('；')), h(methods[tc.method]), h(kinds[environments.find(env => env.id === tc.environmentId)?.kind] || tc.environmentId), badge(effective), tc.method === 'browser' ? viewLink(runs.find(run => run.id === check?.runId)) : item.recordRef ? link(`../../${item.recordRef}`, '观察记录') : '待补证据']
  })
  const hasLive = plannedCases.some(tc => tc?.method === 'browser' && environments.find(env => env?.id === tc.environmentId)?.kind === 'live-test')
  return document('需求验收总览', `<h1>需求验收总览</h1><p>${h(status.title || status.featureId || status.id)} · 工作流状态 ${h(status.state)}</p>
<p class="notice">${summary.ok ? '当前计划内验收证据齐备；独立审核与人工最终批准请以工作流状态为准。' : '当前仍有失败、缺证据、阻塞、过期或待确认项，不能据此宣称整单通过。'} 这是生成时的校验结果；打开静态文件不会重新检查代码。代码变化后运行 refresh-acceptance 刷新。</p>
<p>最后工作流更新时间：${h(status.updatedAt)}。页面展示 delivery 中计划的用例，不能证明原始需求没有遗漏。</p>
<p>${hasLive ? '真实接口与 Mock 的结果分别展示。' : '未配置真实接口浏览器验收，本报告不证明真实后端联调通过。'} 浏览器测试 ${summary.cases.filter(tc => tc.method === 'browser').length} 项 · 静态检查 ${summary.cases.filter(tc => tc.method === 'inspection').length} 项 · 人工验收 ${summary.cases.filter(tc => tc.method === 'manual').length} 项。</p>
<h2>最终候选版本的业务验收</h2>${table(['用例','验收内容','方式','环境','当前结果','证据'],caseRows)}
<h2>最终候选版本的检查命令</h2>${table(['检查','类型','结果','证据'],summary.checks.map(check => [h(check.checkId), plannedChecks.find(c => c.id === check.checkId)?.kind === 'engineering' ? '工程检查（不计业务用例）' : '业务验收',badge(check.status),viewLink(runs.find(run => run.id === check.runId))]))}
${summary.errors.length ? `<h2>仍需处理</h2>${list(summary.errors.map(error => error.message))}` : ''}
<details><summary>全部运行记录（含任务测试、失败与重跑）</summary><p>任务阶段通过不能替代最终候选版本验收。历史结果不代表当前代码通过。</p>${table(['范围','检查','当时结果','证据'],runs.map(run => [h(run.scope === 'task' ? `任务 ${run.taskId}` : '最终候选版本'),h(run.checkId),badge(run.status),viewLink(run)]))}</details>`)
}

export function formatVerificationProgress(event) {
  const environment = kinds[event.environment?.kind] || '本地工程检查'
  if (event.phase === 'start') return `开始${event.check.kind === 'acceptance' ? '需求自动验收' : '工程检查'}｜${event.scope === 'task' ? `任务 ${event.taskId} 交审前` : '最终候选版本'}｜${environment}｜${event.check.id}｜${event.caseCount} 个业务用例`
  if (event.phase === 'running') return `测试仍在执行｜${event.checkId}｜已运行 ${event.elapsedSeconds} 秒；尚未得出结论`
  const r = event.record
  const counts = ['passed','failed','blocked','flaky'].map(value => `${state(value)} ${r.cases.filter(tc => tc.status === value).length}`).join(' / ')
  return `测试结束｜${state(r.status)}｜${r.cases.length ? counts : '工程检查，不计为业务验收'}\n报告：${event.reportPath}\n验收总览：${event.overviewPath}${r.summary ? '\n原因：' + reviewText(r.summary) : ''}`
}
