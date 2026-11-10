#!/usr/bin/env node

/**
 * 解决什么问题：独立审核需要一份可复核的 v1 材料包与报告，避免口头交接或把结构合格当成门禁通过。
 * 通过什么方式解决：提供 seal / check / report：校验字段与引用、给材料盖指纹、对照仓库验过期、核对报告完整性与 verdict。
 * 触发时机：prepare-review 制包后 seal/check；review-delivery 审完后 report。
 * 被谁控制触发：Skill 或 CLI 显式传入 action 与路径；ok 只表示契约校验通过，不等于工作流门禁已放行。
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const object = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const text = v => typeof v === 'string' && v.trim().length > 0
const contains = (v, id) => Array.isArray(v) && v.includes(id)
const hash = v => createHash('sha256').update(v).digest('hex')
const error = (errors, code, message) => errors.push({ code, message })
function list(value, name, errors, nonempty = false) {
  if (!Array.isArray(value) || (nonempty && !value.length)) {
    error(errors, 'INVALID_FIELD', `${name} must be ${nonempty ? 'a nonempty' : 'an'} array`)
    return []
  }
  return value
}
function rows(value, name, errors, nonempty = false) {
  const result = list(value, name, errors, nonempty)
  const ids = new Set()
  for (const row of result) {
    if (!object(row) || !text(row.id)) error(errors, 'INVALID_FIELD', `${name}: object with id required`)
    else if (ids.has(row.id)) error(errors, 'DUPLICATE_ID', `${name}: duplicate ${row.id}`)
    else ids.add(row.id)
  }
  return result.filter(object)
}
function choice(value, values, name, errors) {
  if (!values.includes(value)) error(errors, 'INVALID_FIELD', `${name}: expected ${values.join('|')}`)
}
function strings(row, fields, errors) {
  for (const key of fields) if (!text(row[key])) error(errors, 'INVALID_FIELD', `${key}: nonempty string required`)
}
function materialRefs(refs, materials, errors, nonempty = true) {
  for (const id of list(refs, 'material references', errors, nonempty)) {
    if (!materials.some(m => m.id === id)) error(errors, 'UNKNOWN_MATERIAL', String(id))
  }
}
// 对外校验 packet 结构：schema、阶段、材料路径、需求覆盖与问题引用。
// 只保证包能被独立复核，不表示需求抽对或允许进入下一阶段。
export function validatePacket(p) {
  const errors = []
  if (!object(p)) return [{code:'INVALID_PACKET',message:'Expected packet object'}]
  if (p.schemaVersion !== 1) error(errors, 'INVALID_SCHEMA', 'schemaVersion must be 1')
  strings(p, ['reviewId','implementerId'], errors)
  choice(p.stage,['scope','spec','plan','task','final'],'stage',errors)
  const materials = rows(p.materials,'materials',errors,true)
  const requirements = rows(p.requirements,'requirements',errors,true)
  const checks = rows(p.checks,'checks',errors,true)
  const questions = rows(p.questions,'questions',errors)
  for (const m of materials) {
    strings(m,['path'],errors)
    choice(m.role,['requirement','decision','contract','project-rule','implementation','verification'],'material.role',errors)
    if (text(m.path) && (path.isAbsolute(m.path) || m.path.split(/[\\/]/).includes('..')))
      error(errors,'INVALID_PATH',m.path)
  }
  for (const q of questions) {
    strings(q,['text'],errors)
    choice(q.kind,['evidence','decision'],'question.kind',errors)
    if (typeof q.blocking !== 'boolean') error(errors,'INVALID_FIELD','question.blocking must be boolean')
    list(q.attempted,'question.attempted',errors)
    for (const id of list(q.requirementIds,'question.requirementIds',errors))
      if (!requirements.some(r=>r.id===id)) error(errors,'UNKNOWN_REQUIREMENT',String(id))
  }
  for (const r of requirements) {
    strings(r,['text'],errors)
    choice(r.status,['confirmed','unconfirmed','excluded'],'requirement.status',errors)
    materialRefs(r.basis,materials,errors,r.status==='confirmed')
    if (r.status === 'confirmed' && !materials.some(m=>contains(r.basis,m.id) && ['requirement','decision','contract'].includes(m.role)))
      error(errors,'UNSUPPORTED_REQUIREMENT',r.id)
    if (r.status === 'confirmed' && !checks.some(c=>c.kind==='acceptance' && contains(c.requirementIds,r.id)))
      error(errors,'UNCOVERED_REQUIREMENT',r.id)
    if (r.status === 'unconfirmed' && !questions.some(q=>q.kind==='decision' && q.blocking && contains(q.requirementIds,r.id)))
      error(errors,'UNRESOLVED_REQUIREMENT',r.id)
    if (r.status === 'excluded' && !text(r.reason)) error(errors,'INVALID_FIELD','Excluded requirement needs reason')
  }
  for (const c of checks) {
    strings(c,['scenario','expected'],errors)
    choice(c.kind,['acceptance','engineering'],'check.kind',errors)
    choice(c.method,['inspection','test','manual'],'check.method',errors)
    materialRefs(c.basis,materials,errors)
    for (const id of list(c.requirementIds,'check.requirementIds',errors,c.kind==='acceptance')) {
      const r=requirements.find(r=>r.id===id)
      if (!r) error(errors,'UNKNOWN_REQUIREMENT',String(id))
      else if (r.status !== 'confirmed') error(errors,'UNCONFIRMED_CHECK',String(id))
    }
  }
  return errors
}

async function fingerprints(p, root) {
  const resolvedRoot = await realpath(root)
  const files=[]
  for (const m of p.materials) {
    const file = await realpath(path.resolve(resolvedRoot,m.path))
    const relative = path.relative(resolvedRoot,file)
    if (!relative || relative==='..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error(`Material outside project: ${m.path}`)
    if (!(await stat(file)).isFile()) throw new Error(`Not a file: ${m.path}`)
    files.push({id:m.id,sha256:hash(await readFile(file))})
  }
  const { snapshot, ...content } = p
  return {root:resolvedRoot,files,digest:hash(JSON.stringify({root:resolvedRoot,content,files}))}
}
// seal 在结构通过后计算材料 sha256 与整体 digest，把 snapshot 写回包。
// check/verify 对照当前项目根重算指纹；report 再核独立性、检查项覆盖和 verdict。
// CLI 的 ok 只表示这套校验没有错误，不授权 next / 改状态机。
export async function sealPacket(p, root) {
  const errors=validatePacket(p)
  if(errors.length) throw new Error(JSON.stringify(errors))
  const snapshot=await fingerprints(p,root)
  return {...p,snapshot}
}
export async function verifyPacket(p, root) {
  const errors=validatePacket(p)
  if(errors.length) return errors
  if(!object(p.snapshot) || !text(p.snapshot.digest)) return [{code:'UNSEALED_PACKET',message:'Seal the packet before review'}]
  try {
    const actual=await fingerprints(p,root)
    if(JSON.stringify(actual)!==JSON.stringify(p.snapshot)) error(errors,'STALE_PACKET','Inputs or packet changed; prepare a new review')
  } catch(e) { error(errors,'UNREADABLE_INPUT',e.message) }
  return errors
}
function evidence(items,p,errors) {
  for(const e of list(items,'evidence',errors,true)) {
    if(!object(e)) { error(errors,'MISSING_EVIDENCE','Expected evidence object');continue }
    strings(e,['materialId','location','observation'],errors)
    materialRefs([e.materialId],p.materials,errors)
  }
  if(!Array.isArray(items)||!items.length) error(errors,'MISSING_EVIDENCE','Evidence is required')
}
export async function validateReport(p,r,root) {
  const errors=await verifyPacket(p,root)
  if(errors.length) return errors
  if(!object(r)) return [{code:'INVALID_REPORT',message:'Expected report object'}]
  if(r.schemaVersion!==1) error(errors,'INVALID_SCHEMA','Report schemaVersion must be 1')
  strings(r,['reviewerId','summary'],errors)
  if(r.reviewId!==p.reviewId || r.snapshotDigest!==p.snapshot.digest) error(errors,'REPORT_MISMATCH','Wrong request or version')
  choice(r.independence,['independent','self_check'],'independence',errors)
  choice(r.verdict,['pass','revise','needs_evidence','needs_human'],'verdict',errors)
  if(r.independence!=='independent' || r.reviewerId===p.implementerId) error(errors,'NOT_INDEPENDENT','Independent review required; identity is declared, not authenticated')
  const checks=list(r.checks,'report.checks',errors).filter(object)
  const findings=rows(r.findings,'findings',errors)
  const seen=new Set()
  for(const c of checks) {
    if(seen.has(c.checkId)) error(errors,'DUPLICATE_ID',String(c.checkId))
    seen.add(c.checkId)
    const required=p.checks.find(x=>x.id===c.checkId)
    if(!required) { error(errors,'UNKNOWN_CHECK',String(c.checkId));continue }
    choice(c.result,['pass','fail','unknown'],'result',errors)
    if(c.result==='unknown') strings(c,['reason'],errors)
    else evidence(c.evidence,p,errors)
    if(c.result==='pass' && required.method==='test') {
      const x=c.execution
      if(!object(x) || !text(x.command) || x.exitCode!==0 || !p.materials.some(m=>m.id===x.outputMaterialId && m.role==='verification'))
        error(errors,'MISSING_EXECUTION',c.checkId)
    }
    if(c.result==='pass' && required.method==='manual' && !text(c.confirmationRef))
      error(errors,'MISSING_CONFIRMATION',c.checkId)
  }
  for(const required of p.checks) if(!seen.has(required.id)) error(errors,'MISSING_CHECK',required.id)
  for(const f of findings) {
    strings(f,['message','checkId'],errors)
    if(!p.checks.some(c=>c.id===f.checkId)) error(errors,'UNKNOWN_CHECK',f.checkId)
    choice(f.severity,['blocking','major','minor'],'severity',errors)
    choice(f.action,['repair','collect_evidence','ask_human'],'action',errors)
    evidence(f.evidence,p,errors)
  }
  for(const c of checks) if(c.result==='fail' && !findings.some(f=>f.checkId===c.checkId))
    error(errors,'MISSING_FINDING',c.checkId)
  const requiredVerdict = p.questions.some(q=>q.blocking && q.kind==='decision') || findings.some(f=>f.action==='ask_human') ? 'needs_human'
    : p.questions.some(q=>q.blocking && q.kind==='evidence') || checks.some(c=>c.result==='unknown') || findings.some(f=>f.action==='collect_evidence') ? 'needs_evidence'
    : checks.some(c=>c.result==='fail') || findings.some(f=>['blocking','major'].includes(f.severity)) ? 'revise' : 'pass'
  if(r.verdict!==requiredVerdict) error(errors,'VERDICT_CONFLICT',`Expected ${requiredVerdict}`)
  return errors
}

// This skill is also installed independently, so do not import code from the
// target project. Observation is optional and must not change CLI output.
function observeContract(projectRoot, packetFile, action) {
  if (!projectRoot || !existsSync(path.join(projectRoot, '.ai-dev'))) return
  try {
    const root = path.resolve(projectRoot)
    const runtime = path.join(root, '.ai-dev', 'runtime', 'dashboard')
    const directory = path.join(runtime, 'events')
    mkdirSync(directory, { recursive: true })
    try { writeFileSync(path.join(runtime, '.gitignore'), '*\n', { flag: 'wx' }) } catch (e) { if (e.code !== 'EEXIST') throw e }
    const relative = path.relative(path.join(root, '.ai-dev', 'features'), path.resolve(packetFile || '.'))
    const candidate = !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.split(path.sep)[0] : ''
    let featureId = /^[\w.-]{1,100}$/.test(candidate) ? candidate : null
    let parentId = null
    const requestedParent = process.env.WORKFLOW_SKILL_RUN_ID
    if (/^[a-f0-9-]{36}$/.test(requestedParent || '')) {
      try {
        const parent = JSON.parse(readFileSync(path.join(directory, `${requestedParent}.json`), 'utf8'))
        if (parent.id === requestedParent && parent.kind === 'skill' && parent.source === 'agent' && parent.status === 'running' && (!featureId || !parent.featureId || parent.featureId === featureId)) {
          parentId = parent.id
          featureId = featureId || parent.featureId
        }
      } catch {}
    }
    const now = new Date().toISOString()
    const event = { schemaVersion: 1, id: randomUUID(), kind: 'script', component: 'review-contract.mjs',
      action: ['seal','check','report'].includes(action) ? action : null, featureId,
      taskId: null, attemptId: null, parentId, command: null, source: 'script', status: 'running',
      startedAt: now, updatedAt: now, endedAt: null, exitCode: null }
    const save = () => {
      const temporary = path.join(directory, `.${event.id}-${randomUUID()}.tmp`)
      writeFileSync(temporary, `${JSON.stringify(event)}\n`, { mode: 0o600 })
      renameSync(temporary, path.join(directory, `${event.id}.json`))
    }
    save()
    const timer = setInterval(() => { event.updatedAt = new Date().toISOString(); try { save() } catch {} }, 15000)
    timer.unref()
    process.once('exit', code => {
      clearInterval(timer)
      event.updatedAt = event.endedAt = new Date().toISOString()
      event.exitCode = code
      event.status = code === 0 ? 'completed' : 'failed'
      try { save() } catch {}
    })
  } catch {} // A read-only reviewer or absent dashboard must still work.
}

// 直接当脚本跑时：seal 打印封装后的包；check 只验 packet；report 再验报告。
// 有错误则打印 {ok,errors} 并设 exitCode=1。ok 不是业务批准。
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  observeContract(process.argv[4], process.argv[3], process.argv[2])
  try {
    const [action,packetFile,root,reportFile]=process.argv.slice(2)
    if(!['seal','check','report'].includes(action)||!packetFile||!root||(action==='report'&&!reportFile))
      throw new Error('Usage: node review-contract.mjs seal|check <packet.json> <project-root>; report <packet.json> <project-root> <report.json>')
    const packet=JSON.parse(await readFile(packetFile,'utf8'))
    if(action==='seal') console.log(JSON.stringify(await sealPacket(packet,root),null,2))
    else {
      const errors=action==='check'?await verifyPacket(packet,root):await validateReport(packet,JSON.parse(await readFile(reportFile,'utf8')),root)
      console.log(JSON.stringify({ok:errors.length===0,errors},null,2));if(errors.length)process.exitCode=1
    }
  } catch(e) { console.error(e.message);process.exitCode=1 }
}
