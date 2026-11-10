import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import * as api from '../.agents/skills/prepare-review/scripts/review-contract.mjs'
import { startSkillObservation } from '../template/.ai-dev/scripts/lib/monitor-events.mjs'

const execFile = promisify(execFileCallback)

function draft() {
  return {
    schemaVersion: 1, reviewId: 'R-1', stage: 'task', implementerId: 'writer-1',
    materials: [{id:'M1',path:'prd.md',role:'requirement'}, {id:'M2',path:'code.js',role:'implementation'}],
    requirements: [{id:'FR-1',text:'Skip occupied answers',status:'confirmed',basis:['M1']}],
    checks: [{id:'C1',kind:'acceptance',requirementIds:['FR-1'],basis:['M1'],scenario:'two occupied then free',expected:'return third',method:'inspection'}],
    questions: []
  }
}
function report(packet) {
  return {schemaVersion:1,reviewId:packet.reviewId,snapshotDigest:packet.snapshot.digest,
    reviewerId:'reader-2',independence:'independent',verdict:'pass',summary:'Matches inspected requirement',
    checks:[{checkId:'C1',result:'pass',evidence:[{materialId:'M2',location:'line 1',observation:'uses find'}]}],findings:[]}
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(),'review-contract-'))
  await writeFile(path.join(root,'prd.md'),'Skip occupied answers')
  await writeFile(path.join(root,'code.js'),'answers.find(a => !a.locked)')
  const packet = await api.sealPacket(draft(),root)
  return {root,packet}
}
test('contract API exists', () => assert.equal(typeof api.validatePacket,'function'))
test('standalone contract records its CLI use without loading code from the target project', async (t) => {
  const { root, packet } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const featureDir = path.join(root, '.ai-dev', 'features', 'REQ-1')
  const injectedModule = path.join(root, '.ai-dev', 'scripts', 'lib')
  await mkdir(featureDir, { recursive: true })
  await mkdir(injectedModule, { recursive: true })
  await writeFile(path.join(injectedModule, 'monitor-events.mjs'), 'throw new Error("untrusted project code must not run")')
  const packetFile = path.join(featureDir, 'sealed.json')
  await writeFile(packetFile, JSON.stringify(packet))
  const skillId = startSkillObservation(root, featureDir, 'prepare-review')
  const script = fileURLToPath(new URL('../.agents/skills/prepare-review/scripts/review-contract.mjs', import.meta.url))
  const result = await execFile(process.execPath, [script, 'check', packetFile, root], { env: { ...process.env, WORKFLOW_SKILL_RUN_ID: skillId } })
  assert.equal(JSON.parse(result.stdout).ok, true)
  const eventDir = path.join(root, '.ai-dev', 'runtime', 'dashboard', 'events')
  const eventNames = await readdir(eventDir)
  const events = await Promise.all(eventNames.map(async (name) => JSON.parse(await readFile(path.join(eventDir, name), 'utf8'))))
  const event = events.find((item) => item.component === 'review-contract.mjs')
  assert.equal(event.component, 'review-contract.mjs')
  assert.equal(event.action, 'check')
  assert.equal(event.featureId, 'REQ-1')
  assert.equal(event.parentId, skillId)
  assert.equal(event.status, 'completed')
})
test('valid packet has no errors', () => assert.deepEqual(api.validatePacket(draft()),[]))
test('missing acceptance coverage cannot look ready', () => {
  const p=draft(); p.checks[0].kind='engineering';p.checks[0].requirementIds=[]
  assert.ok(api.validatePacket(p).some(e=>e.code==='UNCOVERED_REQUIREMENT'))
})
test('implementation alone cannot authorize business requirements', () => {
  const p=draft();p.requirements[0].basis=['M2']
  assert.ok(api.validatePacket(p).some(e=>e.code==='UNSUPPORTED_REQUIREMENT'))
})
test('unknown material and duplicate IDs rejected', () => {
  const p=draft();p.checks[0].basis=['missing'];p.materials.push({...p.materials[0]})
  const codes=api.validatePacket(p).map(e=>e.code)
  assert.ok(codes.includes('DUPLICATE_ID'));assert.ok(codes.includes('UNKNOWN_MATERIAL'))
})
test('unconfirmed business requirement requires explicit blocking decision', () => {
  const p=draft();p.requirements.push({id:'FR-2',text:'retry three times',status:'unconfirmed',basis:[]})
  assert.ok(api.validatePacket(p).some(e=>e.code==='UNRESOLVED_REQUIREMENT'))
})
test('empty or malformed input rejected without crashing', () => {
  const malformed=draft();malformed.requirements[0].basis=3
  for(const input of [null,{},[],malformed,{...draft(),checks:[null]},{...draft(),requirements:[null]}])
    assert.ok(api.validatePacket(input).length)
})
test('snapshot detects source changes and metadata tampering', async () => {
  const {root,packet}=await fixture()
  assert.deepEqual(await api.verifyPacket(packet,root),[])
  const changed=structuredClone(packet);changed.checks[0].expected='first occupied'
  assert.ok((await api.verifyPacket(changed,root)).some(e=>e.code==='STALE_PACKET'))
  await writeFile(path.join(root,'code.js'),'answers[1]')
  assert.ok((await api.verifyPacket(packet,root)).some(e=>e.code==='STALE_PACKET'))
})
test('traversal and symlink escapes cannot be sealed', async () => {
  const {root}=await fixture();const p=draft();p.materials[0].path='../outside.md'
  await assert.rejects(api.sealPacket(p,root))
  const outside=await mkdtemp(path.join(os.tmpdir(),'review-outside-'))
  await writeFile(path.join(outside,'source.md'),'outside')
  await symlink(path.join(outside,'source.md'),path.join(root,'escape.md'))
  p.materials[0].path='escape.md';await assert.rejects(api.sealPacket(p,root),/outside/)
})
test('changed root cannot reuse snapshot', async () => {
  const {packet}=await fixture();const other=await mkdtemp(path.join(os.tmpdir(),'review-other-'))
  assert.ok((await api.verifyPacket(packet,other)).length)
})
test('valid independent report accepted', async () => {
  const {root,packet}=await fixture()
  assert.deepEqual(await api.validateReport(packet,report(packet),root),[])
})
test('self review cannot claim independent pass', async () => {
  const {root,packet}=await fixture();const r=report(packet);r.reviewerId='writer-1'
  assert.ok((await api.validateReport(packet,r,root)).some(e=>e.code==='NOT_INDEPENDENT'))
})
test('missing check or evidence rejects pass', async () => {
  const {root,packet}=await fixture();const r=report(packet);r.checks=[]
  assert.ok((await api.validateReport(packet,r,root)).some(e=>e.code==='MISSING_CHECK'))
  r.checks=report(packet).checks;r.checks[0].evidence=[]
  assert.ok((await api.validateReport(packet,r,root)).some(e=>e.code==='MISSING_EVIDENCE'))
})
test('failed check cannot receive passing verdict', async () => {
  const {root,packet}=await fixture();const r=report(packet);r.checks[0].result='fail'
  assert.ok((await api.validateReport(packet,r,root)).some(e=>e.code==='VERDICT_CONFLICT'))
})
test('known defect with repair finding can be revised without human', async () => {
  const {root,packet}=await fixture();const r=report(packet);r.verdict='revise';r.checks[0].result='fail'
  r.findings=[{id:'F1',checkId:'C1',severity:'major',message:'Stops after one occupied answer',action:'repair',evidence:r.checks[0].evidence}]
  assert.deepEqual(await api.validateReport(packet,r,root),[])
})
test('missing evidence and business decision have different verdicts', async () => {
  const {root}=await fixture()
  for(const [kind,verdict] of [['evidence','needs_evidence'],['decision','needs_human']]){
    const p=draft();p.questions=[{id:'Q1',kind,blocking:true,text:'Missing input',requirementIds:[],attempted:['read source']}]
    const packet=await api.sealPacket(p,root);const r=report(packet);r.verdict=verdict
    assert.deepEqual(await api.validateReport(packet,r,root),[])
    r.verdict='pass';assert.ok((await api.validateReport(packet,r,root)).some(e=>e.code==='VERDICT_CONFLICT'))
  }
})
test('runtime checks require passing execution evidence', async () => {
  const {root}=await fixture();const p=draft();p.checks[0].method='test'
  const packet=await api.sealPacket(p,root);const r=report(packet)
  assert.ok((await api.validateReport(packet,r,root)).some(e=>e.code==='MISSING_EXECUTION'))
})
test('malformed report and unknown references fail closed', async () => {
  const {root,packet}=await fixture()
  assert.ok((await api.validateReport(packet,null,root)).length)
  const r=report(packet);r.checks[0].evidence[0].materialId='M404'
  assert.ok((await api.validateReport(packet,r,root)).some(e=>e.code==='UNKNOWN_MATERIAL'))
})
