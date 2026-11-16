/** 项目提供入口规则和准备脚本；工作流负责绑定参数、验证前提并保留脱敏观察。 */
import { createHash } from 'node:crypto'
import { readEvidenceFile } from './evidence-files.mjs'

const nonempty = value => typeof value === 'string' && value.trim().length > 0
const confined = value => nonempty(value) && !value.startsWith('/') && !value.split(/[\\/]/).includes('..')
const secretName = /token|password|cookie|authorization|ticket|secret/i
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

export async function loadTestRuntime(projectRoot, environment) {
  if (!environment.runtime) return null
  const { file, profile: profileId } = environment.runtime
  if (!confined(file)) throw new Error('Runtime config must be a project-relative file')
  const bytes = await readEvidenceFile(projectRoot, file)
  const config = JSON.parse(bytes)
  const profile = config.profiles?.[profileId]
  if (config.schemaVersion !== 1 || !profile || !profile.entries || !Array.isArray(profile.prerequisites) || !Array.isArray(profile.services)) throw new Error('Invalid runtime profile')
  for (const collection of [profile.services, profile.prerequisites]) {
    if (collection.some(item => !nonempty(item.id)) || new Set(collection.map(item => item.id)).size !== collection.length) throw new Error('Runtime prerequisite/service IDs must be unique')
  }
  for (const service of profile.services) {
    if (!nonempty(service.description) || !nonempty(service.readyURL)) throw new Error(`Service ${service.id} needs a readiness target and description`)
  }
  if ((profile.inputs || []).some(input => !confined(input))) throw new Error('Runtime inputs must be project-relative files')
  return { file, profileId, sha256: hash(bytes), profile }
}

function dataValue(data, source) {
  if (!nonempty(source) || source.split('.').some(part => ['__proto__', 'prototype', 'constructor'].includes(part))) throw new Error('Invalid binding source')
  return source.split('.').reduce((value, key) => value?.[key], data)
}

export function resolveTestEntry(runtime, environment, tc, data = {}) {
  const entry = runtime.profile.entries[tc.entry?.id]
  if (!entry || !nonempty(entry.url)) throw new Error(`${tc.id}: unknown runtime entry`)
  const values = {}
  const sources = {}
  for (const [name, binding] of Object.entries(tc.entry.bindings || {})) {
    if (!nonempty(binding.source)) throw new Error(`${tc.id}/${name}: binding requires its data source`)
    const value = dataValue(data, binding.source)
    if (value !== undefined && value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') throw new Error(`${name}: URL input must be scalar`)
    values[name] = value
    sources[name] = { source: binding.source, value: secretName.test(name) ? '[REDACTED]' : value }
  }
  // 缺参本身可能是受测行为，必须在用例中明确声明，不能自动猜值或跳过该反例。
  const omitted = tc.entry.omitInputs || []
  if (omitted.length && !nonempty(tc.entry.omissionReason)) throw new Error('Intentional missing inputs require a source-backed case reason')
  for (const name of entry.requiredInputs || []) {
    if (!omitted.includes(name) && (values[name] === undefined || values[name] === null || values[name] === '')) throw new Error(`Missing required runtime input: ${name}`)
  }
  const renderURL = (redacted = false) => {
    const url = new URL(entry.url.replace(/\{([^}]+)\}/g, (_, name) => {
      if (name === 'baseURL') return environment.baseURL.replace(/\/$/, '')
      if (omitted.includes(name)) return ''
      if (values[name] === undefined || values[name] === null) throw new Error(`Unresolved runtime input: ${name}`)
      return encodeURIComponent(redacted && secretName.test(name) ? '[REDACTED]' : String(values[name]))
    }), environment.baseURL)
    if (url.origin !== new URL(environment.baseURL).origin || url.username || url.password) throw new Error('Entry must use the declared browser origin')
    const templateURL = new URL(entry.url.replaceAll('{baseURL}', environment.baseURL.replace(/\/$/, '')), environment.baseURL)
    const removeOmitted = (params, templateParams) => {
      for (const [key, value] of templateParams) if (omitted.some(name => value.includes(`{${name}}`))) params.delete(key)
    }
    removeOmitted(url.searchParams, templateURL.searchParams)
    for (const name of omitted) {
      url.searchParams.delete(name)
      const index = url.hash.indexOf('?')
      if (index >= 0) {
        const params = new URLSearchParams(url.hash.slice(index + 1))
        const templateIndex = templateURL.hash.indexOf('?')
        removeOmitted(params, new URLSearchParams(templateURL.hash.slice(templateIndex + 1)))
        params.delete(name)
        url.hash = url.hash.slice(0, index) + (params.size ? `?${params}` : '')
      }
    }
    return url.href
  }
  return { url: renderURL(), redactedURL: redactRuntimeURL(renderURL(true)), bindings: sources, entryId: tc.entry.id }
}

export function redactRuntimeURL(value) {
  const url = new URL(value)
  const clean = params => { for (const key of params.keys()) if (secretName.test(key)) params.set(key, '[REDACTED]') }
  clean(url.searchParams)
  const index = url.hash.indexOf('?')
  if (index >= 0) {
    const params = new URLSearchParams(url.hash.slice(index + 1)); clean(params)
    url.hash = url.hash.slice(0, index) + `?${params}`
  }
  return url.href
}

/** 宿主/项目适配器负责实际启动与探测；通用层保证任何失败都停在业务测试之前。 */
export async function prepareTestEntry(runtime, environment, tc, adapter) {
  const observed = { profileId: runtime.profileId, configDigest: runtime.sha256, entryId: tc.entry.id, services: [], prerequisites: [] }
  let preparing = 'entry inputs'
  try {
    for (const [kind, definitions] of [['services', runtime.profile.services], ['prerequisites', runtime.profile.prerequisites]]) {
      for (const definition of definitions) {
        preparing = `${kind}/${definition.id}`
        const result = await adapter[kind](definition)
        observed[kind].push({ ...result, id: definition.id })
        if (result.result !== 'met' || !nonempty(result.observation)) return { status: 'blocked', reason: `${kind}/${definition.id}`, runtime: observed }
      }
    }
    preparing = 'entry inputs'
    const entry = resolveTestEntry(runtime, environment, tc, await adapter.data(tc))
    observed.entryURL = entry.redactedURL
    observed.bindings = entry.bindings
    observed.candidateObservation = await adapter.candidate()
    if (!nonempty(observed.candidateObservation)) return { status: 'blocked', reason: 'candidate not identified', runtime: observed }
    return { status: 'ready', url: entry.url, runtime: observed }
  } catch (error) {
    return { status: 'blocked', reason: `${preparing} unavailable (${error.name})`, runtime: observed }
  }
}

export function runtimeEvidenceErrors(runtime, tc, context) {
  if (!runtime) return []
  const r = context.runtime
  const errors = []
  if (!r || r.profileId !== runtime.profileId || r.configDigest !== runtime.sha256 || r.entryId !== tc.entry?.id) return ['Missing/wrong runtime profile, config digest or entry']
  for (const [name, definitions] of [['services', runtime.profile.services], ['prerequisites', runtime.profile.prerequisites]]) {
    for (const item of definitions) {
      const observations = (r[name] || []).filter(observation => observation.id === item.id)
      if (observations.length !== 1 || observations[0].result !== 'met' || !nonempty(observations[0].observation)) errors.push(`Runtime ${name}/${item.id} was not verified`)
    }
  }
  for (const name of runtime.profile.entries[tc.entry?.id]?.requiredInputs || []) {
    if (!(tc.entry.omitInputs || []).includes(name) && (!r.bindings?.[name] || r.bindings[name].value === undefined || r.bindings[name].value === '' || !nonempty(r.bindings[name].source))) errors.push(`Missing observed binding ${name}`)
  }
  try {
    if (new URL(r.entryURL).origin !== new URL(context.baseURL).origin || !nonempty(r.candidateObservation)) errors.push('Runtime entry/candidate not observed')
    if (redactRuntimeURL(r.entryURL) !== r.entryURL) errors.push('Runtime URL contains unredacted credentials')
    const data = {}
    for (const [name, binding] of Object.entries(tc.entry.bindings)) {
      if ((tc.entry.omitInputs || []).includes(name)) continue
      const actual = r.bindings?.[name]
      if (actual?.source !== binding.source) throw new Error('Binding provenance changed')
      const parts = binding.source.split('.')
      if (parts.some(part => ['__proto__', 'prototype', 'constructor'].includes(part))) throw new Error('Unsafe binding')
      let target = data
      for (const part of parts.slice(0, -1)) target = target[part] ||= {}
      target[parts.at(-1)] = actual?.value
    }
    if (resolveTestEntry(runtime, context, tc, data).redactedURL !== r.entryURL) errors.push('Observed entry does not match its declared inputs')
  } catch { errors.push('Missing observed entry URL') }
  return errors
}
