const elements = Object.fromEntries([
  'connection-text', 'project-breadcrumb', 'project-name', 'feature-select', 'feature-title', 'feature-id', 'feature-state',
  'load-error', 'refresh-button', 'stages', 'stage-description', 'progress-meta', 'active-count', 'active-list',
  'activity-list', 'more-button', 'next-text', 'current-task', 'artifact-state', 'last-updated', 'catalog-list',
  'artifact-count', 'artifact-nav', 'artifact-select', 'artifact-title', 'artifact-path', 'artifact-updated', 'artifact-content',
].map((id) => [id, document.getElementById(id)]))

const view = { data: null, featureId: null, selectedStage: null, stagePinned: false, filter: 'all', showAll: false, catalogSignature: '', optionsSignature: '', dataSignature: '', eventIndex: new Map(), loading: false, artifactPath: null, artifactNavSignature: '', artifactLoadedKey: '', artifactRequest: 0 }
const stateNames = {
  INGEST: '需求分析', SCOPE_REVIEW: '范围审核', SPEC_REVIEW: '方案审核', PLAN_REVIEW: '计划审核',
  IMPLEMENTING: '实施中', VERIFYING: '验证中', FINAL_REVIEW: '最终审核', COMPLETE: '已完成',
  BLOCKED: '已阻塞', UNREADABLE: '状态无法读取', UNKNOWN: '阶段待确认',
}
const statuses = { running: '运行中', completed: '已结束', failed: '执行失败', unknown: '状态待确认', recorded: '已记录' }
const sources = { script: '脚本执行记录', hook: 'Cursor Hook 记录', command: '验证命令记录', agent: 'Agent 上报', ledger: '工作流账本' }
const kindNames = { script: '脚本', command: '命令', skill: 'Skill', hook: 'Hook', ledger: '状态' }
const icons = { script: '›_', command: '›_', skill: '✦', hook: '↪', ledger: '✓' }
const gateNames = { scope: '范围', spec: '方案', plan: '计划', final: '最终' }

function node(tag, className, text) {
  const element = document.createElement(tag)
  if (className) element.className = className
  if (text !== undefined && text !== null) element.textContent = text
  return element
}

function formattedTime(value, withDate = false) {
  const date = new Date(value)
  if (!value || Number.isNaN(date.getTime())) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', withDate
    ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
    : { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}

function timestampParts(value) {
  const date = new Date(value)
  if (!value || Number.isNaN(date.getTime())) return { date: '时间未知', time: '' }
  const pad = (part) => String(part).padStart(2, '0')
  return { date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`, time: `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` }
}

function fullTimestamp(value) {
  const parts = timestampParts(value)
  const date = new Date(value)
  const milliseconds = value && !Number.isNaN(date.getTime()) ? `.${String(date.getMilliseconds()).padStart(3, '0')}` : ''
  return [parts.date, parts.time ? parts.time + milliseconds : ''].filter(Boolean).join(' ')
}

function duration(event) {
  const milliseconds = Date.parse(event.endedAt) - Date.parse(event.startedAt)
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return ''
  if (milliseconds < 1000) return `${milliseconds} 毫秒`
  const seconds = Math.floor(milliseconds / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  return `${minutes} 分 ${seconds % 60} 秒`
}

function parentDescription(event) {
  const ancestors = []
  const visited = new Set([event.id])
  let parentId = event.parentId
  while (parentId && !visited.has(parentId) && ancestors.length < 8) {
    visited.add(parentId)
    const parent = view.eventIndex.get(parentId)
    if (!parent) break
    ancestors.unshift(parent)
    parentId = parent.parentId
  }
  if (!ancestors.length) return ''
  const chain = ancestors.map((item) => {
    const name = view.data.catalog.components[item.kind]?.[item.component]?.name
    return `${kindNames[item.kind] || '活动'} ${name ? `${name}（${item.component}）` : item.component}`
  }).join(' → ')
  const note = ancestors.some((item) => item.kind === 'skill') ? '（Skill 关联由 Agent 上报）' : ''
  return `调用来源：${chain}${note}`
}

function feature() {
  return view.data?.features.find((item) => item.id === view.featureId) || null
}

function stageName(id) {
  return view.data.catalog.stages.find((stage) => stage.id === id)?.name || '工作流阶段'
}

function eventDetails(event) {
  if (event.kind === 'ledger') {
    const task = event.taskId ? ` ${event.taskId}` : ''
    const descriptions = {
      'workflow.transition': ['阶段已更新', `工作流进入${stageName(event.stage)}。`],
      'workflow.approve': ['人工决定已登记', `${gateNames[event.gate] || '当前'}审核点的决定已记录。`],
      'workflow.block': ['工作流已阻塞', '当前需求需要补充信息或处理阻断原因。'],
      'workflow.resume': ['工作流已恢复', '工作流已从阻断状态恢复。'],
      'task.start': ['任务已开始', `已登记任务${task} 开始实施。`],
      'task.accept': ['实施结果已登记', `已接收任务${task}的实施结果，具体结论以工作流记录为准。`],
      'task.recover': ['任务已恢复', `已登记任务${task}的恢复操作。`],
      'review.accept': ['审核结果已登记', '独立审核报告已接收，具体结论以工作流记录为准。'],
      'verification.run': ['验证结果已登记', `已登记任务${task}的验证结果。`],
      'coding.record': ['代码改动已记录', '已更新修改文件清单和补丁。'],
      'consistency.mark': ['已标记受影响产物', '上游产物发生变更，相关下游产物需要同步。'],
      'consistency.resolve': ['产物刷新已登记', '已登记实际刷新的下游产物。'],
      'policy.delegate': ['审核授权已登记', '已记录本需求的独立审核授权。'],
      'policy.delegate.clear': ['审核授权已清除', '已清除本需求的独立审核授权。'],
    }
    const [name, description] = descriptions[event.component] || ['工作流状态已记录', '工作流账本记录了一次状态或产物变化。']
    return { name, description, code: event.component }
  }
  const definition = view.data.catalog.components[event.kind]?.[event.component]
  const name = definition?.name || (event.kind === 'skill' ? '使用工作流 Skill' : '执行工作流步骤')
  const description = definition?.actions?.[event.action] || definition?.description || '已记录此活动，具体用途尚未配置。'
  let code = [event.component, event.action].filter(Boolean).join(' ')
  if (event.kind === 'command' && event.command) code = `run-verification.mjs → ${event.command}`
  return { name, description, code }
}

function shownEvents(current) {
  const observations = view.data.observations.filter((event) => !event.featureId || event.featureId === current?.id)
  const ledger = current?.events || []
  return [...observations, ...ledger].sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))
}

function renderFeatureOptions() {
  const list = view.data.features
  const signature = JSON.stringify(list.map(({ id, title }) => [id, title]))
  if (signature !== view.optionsSignature) {
    elements['feature-select'].replaceChildren()
    if (!list.length) elements['feature-select'].append(node('option', '', '暂无需求'))
    for (const item of list) {
      const option = node('option', '', `${item.title} · ${item.id}`)
      option.value = item.id
      elements['feature-select'].append(option)
    }
    view.optionsSignature = signature
  }
  elements['feature-select'].disabled = !list.length
  if (view.featureId) elements['feature-select'].value = view.featureId
}

function renderHeader(current) {
  elements['project-name'].textContent = view.data.project
  elements['project-breadcrumb'].textContent = view.data.project
  elements['feature-title'].textContent = current?.title || '暂无需求'
  elements['feature-id'].textContent = current?.id || ''
  const badge = elements['feature-state']
  badge.textContent = current ? stateNames[current.state] || '阶段待确认' : '等待创建需求'
  badge.className = `status-pill ${current?.state === 'COMPLETE' ? 'done' : current?.state === 'BLOCKED' || current?.state === 'UNREADABLE' ? 'warning' : current ? '' : 'neutral'}`
}

function renderStages(current) {
  const stages = view.data.catalog.stages
  const currentState = current?.state === 'BLOCKED' ? current.suspendedFrom : current?.state
  const index = stages.findIndex((stage) => stage.id === currentState)
  if (!view.stagePinned || !stages.some((stage) => stage.id === view.selectedStage)) view.selectedStage = index >= 0 ? currentState : stages[0].id
  elements.stages.replaceChildren()
  stages.forEach((stage, position) => {
    const complete = index >= 0 && (position < index || current?.state === 'COMPLETE')
    const isCurrent = index === position && current?.state !== 'COMPLETE'
    const stageStatus = index < 0 && current ? '待确认' : isCurrent ? '当前' : complete ? '已完成' : '待进行'
    const item = node('button', `stage ${complete ? 'complete' : ''} ${isCurrent ? 'current' : ''} ${view.selectedStage === stage.id ? 'selected' : ''}`)
    item.type = 'button'
    item.dataset.stage = stage.id
    item.setAttribute('aria-label', `${stage.name}，${isCurrent ? '当前阶段' : stageStatus}`)
    if (isCurrent) item.setAttribute('aria-current', 'step')
    item.append(node('span', 'stage-icon', complete ? '✓' : String(position + 1)))
    item.append(node('span', 'stage-name', stage.name))
    item.append(node('span', 'stage-state', stageStatus))
    item.addEventListener('click', () => {
      view.selectedStage = stage.id
      view.stagePinned = true
      renderStages(feature())
      elements.stages.querySelector(`[data-stage="${stage.id}"]`)?.focus()
    })
    elements.stages.append(item)
  })
  const selected = stages.find((stage) => stage.id === view.selectedStage)
  elements['stage-description'].textContent = `${selected.name}：${selected.description}`
  elements['progress-meta'].textContent = current?.state === 'BLOCKED' ? '已阻塞，显示阻断前的阶段' : '阶段状态以工作流记录为准'
}

function makeEmpty(title, description) {
  const empty = node('div', 'empty')
  const first = node('p')
  first.append(node('strong', '', title))
  empty.append(first, node('p', '', description))
  return empty
}

function renderActive(current, events) {
  const active = events.filter((event) => event.kind !== 'ledger' && (event.status === 'running' || event.status === 'unknown'))
  elements['active-count'].textContent = active.length ? `${active.length} 项活动${active.some((event) => event.status === 'unknown') ? ' · 含待确认' : ''}` : '暂无运行记录'
  elements['active-list'].replaceChildren()
  if (!active.length) {
    if (current?.activeTaskId) elements['active-list'].append(makeEmpty(`任务 ${current.activeTaskId} 已登记为运行中`, '当前没有可确认的实时活动；执行者状态需要继续核实。'))
    else elements['active-list'].append(makeEmpty('当前没有可确认的运行活动', '脚本、Hook 或上报的 Skill 活动开始后会显示在这里。'))
    return
  }
  for (const event of active) {
    const { name, description, code } = eventDetails(event)
    const card = node('article', 'active-card')
    const icon = node('span', 'activity-icon', icons[event.kind] || '·')
    icon.setAttribute('aria-hidden', 'true')
    const content = node('div', 'active-content')
    const top = node('div', 'active-top')
    top.append(node('div', 'active-title', name), node('span', `badge ${event.status === 'unknown' ? 'unknown' : ''}`, statuses[event.status]))
    content.append(top, node('div', 'activity-code', code), node('p', 'activity-description', `${event.taskId ? `${event.taskId}：` : '作用：'}${description}`))
    content.append(node('p', 'activity-source', `记录来源：${sources[event.source] || '执行记录'}${event.featureId ? '' : ' · 项目级活动'}`))
    const parent = parentDescription(event)
    if (parent) content.append(node('p', 'row-parent', parent))
    content.append(node('p', 'row-timing', `开始时间：${fullTimestamp(event.startedAt)}`))
    card.append(icon, content)
    elements['active-list'].append(card)
  }
}

function renderActivity(events) {
  const filtered = events.filter((event) => view.filter === 'all' || event.kind === view.filter || (view.filter === 'script' && event.kind === 'command'))
  const visible = view.showAll ? filtered : filtered.slice(0, 12)
  elements['activity-list'].replaceChildren()
  if (!visible.length) {
    elements['activity-list'].append(makeEmpty('还没有对应的执行记录', '新的活动会自动显示；历史中没有记录的步骤不会被推测为已执行。'))
  }
  for (const event of visible) {
    const { name, description, code } = eventDetails(event)
    const row = node('article', 'activity-row')
    const time = node('time', 'activity-time')
    const parts = timestampParts(event.startedAt)
    if (event.startedAt) time.dateTime = event.startedAt
    time.append(node('span', '', parts.date), node('span', '', parts.time))
    row.append(time)
    const icon = node('span', `row-icon ${event.kind}`, icons[event.kind] || '·')
    icon.setAttribute('aria-hidden', 'true')
    const main = node('div', 'row-main')
    main.append(node('div', 'row-title', `${kindNames[event.kind] || '活动'} · ${name}`))
    main.append(node('p', 'row-description', `${event.taskId ? `${event.taskId}：` : ''}${description}`))
    main.append(node('div', 'row-meta', `${code} · ${sources[event.source] || '执行记录'}${event.featureId ? '' : ' · 项目级'}`))
    const parent = parentDescription(event)
    if (parent) main.append(node('div', 'row-parent', parent))
    const timing = [`开始：${fullTimestamp(event.startedAt)}`]
    if (event.endedAt) timing.push(`结束：${fullTimestamp(event.endedAt)}`)
    if (duration(event)) timing.push(`耗时 ${duration(event)}`)
    main.append(node('div', 'row-timing', timing.join(' · ')))
    row.append(icon, main, node('span', `row-status ${event.status}`, statuses[event.status] || '状态待确认'))
    elements['activity-list'].append(row)
  }
  elements['more-button'].hidden = filtered.length <= 12
  elements['more-button'].textContent = view.showAll ? '收起记录 ↑' : `查看全部记录（${filtered.length}）↓`
}

function nextMessage(current, events) {
  if (!current) return '创建需求工作区后，这里会显示根据工作流记录提供的下一步提示。'
  if (current.state === 'UNREADABLE') return '无法读取当前需求状态，请检查状态文件后重试。'
  if (current.state === 'BLOCKED') return current.blockedReason || '工作流已阻塞，请先查看并处理阻断原因。'
  if (current.staleCount) return `有 ${current.staleCount} 项产物已标记过期，请先同步并重新确认受影响的内容。`
  const command = events.find((item) => item.kind === 'command' && item.status === 'running' && item.featureId === current.id)
  if (command) return `${command.taskId || '当前任务'}的验证命令正在执行。完成后按工作流登记结果并继续处理。`
  const pending = current.tasks.find((task) => task.status === 'review_pending')
  if (pending) return `${pending.id} 已登记为待审核，请准备审核材料并发起独立审核。`
  if (current.activeTaskId) return `继续处理 ${current.activeTaskId}，并按任务计划验证和登记实施结果。`
  const suggestions = {
    INGEST: '整理需求资料与项目证据，完成范围分析后提交审核。',
    SCOPE_REVIEW: current.approvals.scope ? '范围批准已记录，可继续准备前端技术方案。' : '检查范围材料及审核记录，并处理待确认事项。',
    SPEC_REVIEW: current.approvals.spec ? '方案批准已记录，可继续准备实施计划。' : '检查方案和验收材料，并处理审核决定。',
    PLAN_REVIEW: current.approvals.plan ? '计划批准已记录，可按工作流进入实施。' : '检查任务拆分和验证计划，并处理审核决定。',
    IMPLEMENTING: '按任务依赖继续实施，任务完成后准备独立审核。',
    VERIFYING: '执行已确认的验证命令，整理最终代码改动。',
    FINAL_REVIEW: '检查最终审核材料和人工决定，完成后按工作流推进。',
    COMPLETE: '需求工作流已完成。',
  }
  return suggestions[current.state] || '请查看工作流账本，确认当前状态和下一步。'
}

function renderOverview(current, events) {
  elements['next-text'].textContent = nextMessage(current, events)
  const task = current?.tasks.find((item) => item.id === current.activeTaskId)
  elements['current-task'].textContent = task ? `${task.id}${task.title ? ` · ${task.title}` : ''}` : current?.activeTaskId || '暂无进行中任务'
  elements['artifact-state'].textContent = !current ? '暂无需求' : current.staleCount ? `${current.staleCount} 项待刷新` : '未记录过期产物'
  elements['last-updated'].textContent = current?.updatedAt ? formattedTime(current.updatedAt, true) : '暂无记录'
}

let markdownParser = null
let mermaidLoading = null

function artifactReference(reference, sourcePath) {
  try {
    const encodedPath = sourcePath.split('/').map(encodeURIComponent).join('/')
    const base = new URL(`/${encodedPath}`, 'https://workflow.invalid')
    const target = new URL(reference, base)
    if (target.origin !== base.origin) return null
    const relative = decodeURIComponent(target.pathname.slice(1))
    return /^(artifacts|revisions)\//.test(relative) ? relative : null
  } catch { return null }
}

function getMarkdownParser() {
  if (markdownParser) return markdownParser
  if (typeof window.markdownit !== 'function') throw new Error('Markdown 渲染组件未加载')
  const parser = window.markdownit({ html: false, linkify: false, breaks: false })
  const defaultImage = parser.renderer.rules.image
  const defaultLink = parser.renderer.rules.link_open || ((tokens, index, options, env, renderer) => renderer.renderToken(tokens, index, options))
  const defaultFence = parser.renderer.rules.fence
  const defaultHeading = parser.renderer.rules.heading_open || ((tokens, index, options, env, renderer) => renderer.renderToken(tokens, index, options))
  const slug = (value) => value.trim().toLowerCase().replace(/[^\p{Letter}\p{Number}\s_-]/gu, '').replace(/\s+/g, '-')

  parser.renderer.rules.heading_open = (tokens, index, options, env, renderer) => {
    const title = tokens[index + 1]?.content || ''
    const id = slug(title)
    if (id) {
      env.headingCounts ||= {}
      const count = env.headingCounts[id] || 0
      env.headingCounts[id] = count + 1
      tokens[index].attrSet('id', `md-heading-${id}${count ? `-${count}` : ''}`)
    }
    return defaultHeading(tokens, index, options, env, renderer)
  }
  parser.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
    const token = tokens[index]
    const href = token.attrGet('href') || ''
    if (href.startsWith('#')) {
      let fragment = href.slice(1)
      try { fragment = decodeURIComponent(fragment) } catch { /* Keep malformed fragments as text. */ }
      token.attrSet('href', `#md-heading-${slug(fragment)}`)
    }
    else if (/^https?:\/\//i.test(href)) {
      token.attrSet('target', '_blank')
      token.attrSet('rel', 'noopener noreferrer')
    } else {
      const target = artifactReference(href, env.artifactPath)
      if (target && /\.md$/i.test(target)) {
        token.attrSet('href', '#')
        token.attrSet('data-artifact', target)
      } else {
        token.attrSet('href', '#')
        token.attrSet('data-unavailable-link', 'true')
      }
    }
    return defaultLink(tokens, index, options, env, renderer)
  }
  parser.renderer.rules.image = (tokens, index, options, env, renderer) => {
    const token = tokens[index]
    const src = token.attrGet('src') || ''
    if (!/^data:image\/(?:png|gif|jpeg|webp);base64,/i.test(src)) {
      const target = artifactReference(src, env.artifactPath)
      if (!target) return `<span class="markdown-image-placeholder">[图片未自动加载：${parser.utils.escapeHtml(token.content || '外部图片')}]</span>`
      token.attrSet('src', `/api/artifact-image?${new URLSearchParams({ feature: env.featureId, path: target })}`)
    }
    token.attrSet('loading', 'lazy')
    return defaultImage(tokens, index, options, env, renderer)
  }
  parser.renderer.rules.fence = (tokens, index, options, env, renderer) => {
    const token = tokens[index]
    if (token.info.trim().split(/\s+/)[0].toLowerCase() === 'mermaid') return `<div class="mermaid">${parser.utils.escapeHtml(token.content)}</div>`
    return defaultFence(tokens, index, options, env, renderer)
  }
  parser.core.ruler.after('inline', 'workflow-task-list', (state) => {
    state.tokens.forEach((token, index) => {
      if (token.type !== 'inline' || state.tokens[index - 2]?.type !== 'list_item_open') return
      const first = token.children?.[0]
      const match = first?.type === 'text' && first.content.match(/^\[([ xX])\]\s+/)
      if (!match) return
      first.content = first.content.slice(match[0].length)
      const checkbox = new state.Token('workflow_checkbox', '', 0)
      checkbox.meta = { checked: match[1].toLowerCase() === 'x' }
      token.children.unshift(checkbox)
    })
  })
  parser.renderer.rules.workflow_checkbox = (tokens, index) => `<input type="checkbox" disabled${tokens[index].meta.checked ? ' checked' : ''}> `
  markdownParser = parser
  return parser
}

function loadMermaid() {
  if (mermaidLoading) return mermaidLoading
  mermaidLoading = new Promise((resolve, reject) => {
    if (window.mermaid) { resolve(window.mermaid); return }
    const script = document.createElement('script')
    script.src = '/vendor/mermaid.min.js'
    script.onload = () => window.mermaid ? resolve(window.mermaid) : reject(new Error('Mermaid 未加载'))
    script.onerror = () => reject(new Error('Mermaid 未加载'))
    document.head.append(script)
  }).then((mermaid) => {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, maxTextSize: 10000, flowchart: { htmlLabels: false } })
    return mermaid
  })
  return mermaidLoading
}

async function renderDiagrams(container, requestId) {
  const diagrams = [...container.querySelectorAll('.mermaid')]
  if (!diagrams.length) return
  let mermaid
  try { mermaid = await loadMermaid() } catch { /* Show the original source below. */ }
  if (requestId !== view.artifactRequest) return
  for (const diagram of diagrams) {
    const source = diagram.textContent
    try {
      if (!mermaid) throw new Error('Mermaid unavailable')
      await mermaid.run({ nodes: [diagram], suppressErrors: true })
      const svg = diagram.querySelector('svg')
      const naturalWidth = svg?.viewBox?.baseVal?.width
      if (svg && naturalWidth) {
        const width = Math.max(420, Math.min(1400, Math.ceil(naturalWidth)))
        svg.style.width = `${width}px`
        svg.style.maxWidth = 'none'
        svg.style.height = 'auto'
        if (width > diagram.clientWidth) {
          diagram.tabIndex = 0
          diagram.setAttribute('aria-label', '流程图，可左右滚动查看')
          diagram.before(node('p', 'diagram-hint', '图较宽，可左右滚动查看。'))
        }
      }
    } catch {
      diagram.replaceChildren(node('div', 'diagram-fallback', '流程图暂时无法渲染，以下为原始内容。'), node('pre', '', source))
    }
  }
}

async function loadArtifact(current, artifact) {
  const key = `${current.id}:${artifact.path}:${artifact.updatedAt}`
  if (key === view.artifactLoadedKey) return
  view.artifactLoadedKey = key
  const requestId = ++view.artifactRequest
  elements['artifact-content'].replaceChildren(makeEmpty('正在读取产物', '请稍候。'))
  try {
    const response = await fetch(`/api/artifact?${new URLSearchParams({ feature: current.id, path: artifact.path })}`, { cache: 'no-store' })
    if (!response.ok) throw new Error('read failed')
    const result = await response.json()
    if (requestId !== view.artifactRequest) return
    const parser = getMarkdownParser()
    elements['artifact-content'].innerHTML = parser.render(result.content, { artifactPath: artifact.path, featureId: current.id })
    if (!result.content.trim()) elements['artifact-content'].append(makeEmpty('产物内容为空', '工作流写入内容后会自动刷新。'))
    await renderDiagrams(elements['artifact-content'], requestId)
  } catch {
    if (requestId !== view.artifactRequest) return
    view.artifactLoadedKey = ''
    elements['artifact-content'].replaceChildren(makeEmpty('无法读取或渲染产物', '请检查文件是否存在、可读取并位于当前需求工作区。'))
  }
}

function chooseArtifact(path) {
  view.artifactPath = path
  renderArtifacts(feature())
}

function renderArtifacts(current) {
  const artifacts = current?.artifacts || []
  elements['artifact-count'].textContent = current?.artifactsError ? '读取失败' : `${artifacts.length} 个 Markdown 产物`
  if (!artifacts.some((item) => item.path === view.artifactPath)) view.artifactPath = artifacts.find((item) => item.path.endsWith('/scope.md'))?.path || artifacts[0]?.path || null
  const signature = JSON.stringify([current?.id, artifacts.map(({ path, name, group }) => [path, name, group])])
  if (signature !== view.artifactNavSignature) {
    view.artifactNavSignature = signature
    elements['artifact-nav'].replaceChildren()
    elements['artifact-select'].replaceChildren()
    if (!artifacts.length) elements['artifact-select'].append(node('option', '', '暂无产物'))
    let group = ''
    let optionGroup
    for (const artifact of artifacts) {
      if (group !== artifact.group) {
        group = artifact.group
        elements['artifact-nav'].append(node('p', 'artifact-group', group))
        optionGroup = node('optgroup')
        optionGroup.label = group
        elements['artifact-select'].append(optionGroup)
      }
      const choice = node('button', 'artifact-choice')
      choice.type = 'button'
      choice.dataset.artifactPath = artifact.path
      choice.append(node('span', '', artifact.name), node('small', '', artifact.path.replace(/^(artifacts|revisions)\//, '')))
      choice.addEventListener('click', () => chooseArtifact(artifact.path))
      elements['artifact-nav'].append(choice)
      const option = node('option', '', `${artifact.name} · ${artifact.path}`)
      option.value = artifact.path
      optionGroup.append(option)
    }
  }
  elements['artifact-select'].disabled = !artifacts.length
  if (view.artifactPath) elements['artifact-select'].value = view.artifactPath
  elements['artifact-nav'].querySelectorAll('.artifact-choice').forEach((choice) => {
    const selected = choice.dataset.artifactPath === view.artifactPath
    choice.classList.toggle('selected', selected)
    choice.setAttribute('aria-pressed', String(selected))
  })
  const artifact = artifacts.find((item) => item.path === view.artifactPath)
  if (!artifact) {
    view.artifactRequest += 1
    view.artifactLoadedKey = ''
    elements['artifact-title'].textContent = '暂无可展示的产物'
    elements['artifact-path'].textContent = ''
    elements['artifact-updated'].textContent = ''
    elements['artifact-content'].replaceChildren(makeEmpty(current?.artifactsError ? '无法读取产物目录' : '还没有 Markdown 产物', current?.artifactsError ? '请检查当前需求目录的读取权限。' : '工作流生成文档后会自动显示在这里。'))
    return
  }
  elements['artifact-title'].textContent = artifact.name
  elements['artifact-path'].textContent = artifact.path
  elements['artifact-updated'].textContent = `更新于 ${formattedTime(artifact.updatedAt, true)}`
  loadArtifact(current, artifact)
}

function renderCatalog() {
  const groups = [['skill', 'Skills'], ['script', '工作流脚本'], ['hook', 'Cursor Hooks'], ['module', '内部模块']]
  const signature = JSON.stringify(view.data.catalog.components)
  if (view.catalogSignature === signature) return
  view.catalogSignature = signature
  elements['catalog-list'].replaceChildren()
  for (const [kind, label] of groups) {
    const entries = Object.entries(view.data.catalog.components[kind] || {})
    const details = node('details')
    details.append(node('summary', '', `${label} · ${entries.length}`))
    for (const [name, item] of entries) {
      const entry = node('div', 'catalog-entry')
      entry.append(node('strong', '', item.name), node('code', '', name), node('p', '', item.description))
      details.append(entry)
    }
    elements['catalog-list'].append(details)
  }
}

function render() {
  renderFeatureOptions()
  const current = feature()
  const events = shownEvents(current)
  renderHeader(current)
  renderStages(current)
  renderActive(current, events)
  renderActivity(events)
  renderOverview(current, events)
  renderArtifacts(current)
  renderCatalog()
}

async function refresh() {
  if (view.loading) return
  view.loading = true
  try {
    const response = await fetch('/api/workflow', { cache: 'no-store' })
    if (!response.ok) throw new Error('读取失败')
    view.data = await response.json()
    view.eventIndex = new Map(view.data.observations.map((item) => [item.id, item]))
    if (!view.data.features.some((item) => item.id === view.featureId)) {
      view.featureId = view.data.features[0]?.id || null
      view.selectedStage = null
      view.stagePinned = false
    }
    elements['load-error'].hidden = true
    elements['connection-text'].parentElement.classList.remove('offline')
    elements['connection-text'].textContent = `本地查看 · ${formattedTime(view.data.refreshedAt)} 更新`
    // Heartbeats and the refresh clock do not change the visible timeline;
    // avoid replacing focused controls every two seconds.
    const observations = view.data.observations.map(({ updatedAt, ...event }) => event)
    const signature = JSON.stringify({ features: view.data.features, observations, catalog: view.data.catalog, project: view.data.project })
    if (signature !== view.dataSignature) {
      view.dataSignature = signature
      render()
    }
  } catch {
    elements['load-error'].textContent = '暂时无法读取工作流数据，请确认本地看板服务仍在运行。'
    elements['load-error'].hidden = false
    elements['connection-text'].textContent = '连接已断开'
    elements['connection-text'].parentElement.classList.add('offline')
  } finally {
    view.loading = false
  }
}

elements['feature-select'].addEventListener('change', (event) => {
  view.featureId = event.target.value
  view.selectedStage = null
  view.stagePinned = false
  view.artifactPath = null
  view.artifactLoadedKey = ''
  view.showAll = false
  render()
})
elements['artifact-select'].addEventListener('change', (event) => chooseArtifact(event.target.value))
elements['artifact-content'].addEventListener('click', (event) => {
  const link = event.target.closest('a')
  if (!link) return
  if (link.dataset.artifact) {
    event.preventDefault()
    if (feature()?.artifacts.some((item) => item.path === link.dataset.artifact)) chooseArtifact(link.dataset.artifact)
  } else if (link.dataset.unavailableLink) event.preventDefault()
})
elements['refresh-button'].addEventListener('click', refresh)
elements['more-button'].addEventListener('click', () => { view.showAll = !view.showAll; renderActivity(shownEvents(feature())) })
document.querySelectorAll('.filter').forEach((button) => button.addEventListener('click', () => {
  view.filter = button.dataset.filter
  view.showAll = false
  document.querySelectorAll('.filter').forEach((item) => {
    const selected = item === button
    item.classList.toggle('selected', selected)
    item.setAttribute('aria-pressed', String(selected))
  })
  renderActivity(shownEvents(feature()))
}))
refresh()
setInterval(refresh, 2000)
