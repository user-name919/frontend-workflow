import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { writeFile } from 'node:fs/promises'
import { acceptanceFixture } from './helpers/acceptance.mjs'
import { loadTestRuntime, resolveTestEntry, runtimeEvidenceErrors, redactRuntimeURL, prepareTestEntry } from '../template/.ai-dev/scripts/lib/test-runtime.mjs'
import { observedCaseErrors } from '../template/.ai-dev/scripts/lib/case-evidence.mjs'
import { validateDelivery } from '../template/.ai-dev/scripts/lib/delivery.mjs'
import { readBrowserReport } from '../template/.ai-dev/scripts/lib/verification-report.mjs'

async function fixture() {
  const f = await acceptanceFixture()
  const env = f.delivery.verification.environments[0]
  env.runtime = { file: 'runtime.json', profile: 'pre' }
  const config = { schemaVersion: 1, profiles: { pre: { services: [{ id: 'app', description: 'current checkout', readyURL: env.baseURL }], prerequisites: [{ id: 'login', description: 'authorized test role' }], entries: { detail: { url: '{baseURL}/#/tasks/{taskId}?classId={classId}', requiredInputs: ['taskId', 'classId'] } } } } }
  await writeFile(path.join(f.root, 'runtime.json'), JSON.stringify(config))
  const tc = f.delivery.testCases[0]
  tc.entry = { id: 'detail', bindings: { taskId: { source: 'task.id' }, classId: { source: 'task.classId' } } }
  const runtime = await loadTestRuntime(f.root, env)
  return { ...f, env, tc, runtime }
}

test('entries bind path/hash/query values from actual data and reject missing/cross-origin inputs', async () => {
  const {runtime,env,tc} = await fixture()
  const result = resolveTestEntry(runtime, env, tc, { task: { id: 'a/b', classId: 'group & 1' } })
  assert.equal(result.url, env.baseURL + '/#/tasks/a%2Fb?classId=group%20%26%201')
  assert.throws(() => resolveTestEntry(runtime, env, tc, { task: { id: 42 } }), /classId/)
  tc.entry.omitInputs = ['classId']; tc.entry.omissionReason = 'PRD: missing class shows error'
  assert.equal(resolveTestEntry(runtime, env, tc, { task: { id: 42 } }).url, env.baseURL + '/#/tasks/42')
  runtime.profile.entries.detail.url='{baseURL}/?class={classId}#/tasks/{taskId}?group={classId}'
  assert.equal(resolveTestEntry(runtime,env,tc,{task:{id:42}}).url,env.baseURL+'/#/tasks/42')
  runtime.profile.entries.detail.url = 'https://unrelated.example/{taskId}'
  assert.throws(() => resolveTestEntry(runtime, env, tc, { task: { id: 42 } }), /origin/)
  assert.equal(redactRuntimeURL('http://localhost/?sysToken=secret#/detail?ticket=secret&id=1'), 'http://localhost/?sysToken=%5BREDACTED%5D#/detail?ticket=%5BREDACTED%5D&id=1')
})

test('all-manual shortcut and static evidence for network expectations fail plan admission', async () => {
  const f = await acceptanceFixture()
  f.delivery.acceptance[0].verification = 'manual'
  f.delivery.testCases[0].method = 'manual'
  f.delivery.verification.checks = [f.delivery.verification.checks[1]]
  f.delivery.verification.finalCheckIds = f.delivery.tasks[0].verifyIds = ['lint']
  assert.ok(validateDelivery(f.intake,f.delivery).errors.some(e => e.code === 'MANUAL_REASON_REQUIRED'))
  f.delivery.acceptance[0].verification = 'inspection'
  f.delivery.testCases[0].method = 'inspection'
  f.delivery.testCases[0].expectations[0].observable = 'network'
  assert.ok(validateDelivery(f.intake,f.delivery).errors.some(e => e.code === 'STATIC_AS_RUNTIME'))
})

test('empty data, a missing assertion and login-only consent cannot become manual pass', async () => {
  const tc = { id:'TC-M', method:'manual', preconditions:['has populated list'], expectations:[{id:'rows'},{id:'copy'}] }
  const r = { result:'passed', preconditionResults:[{index:0,result:'unmet',observation:'empty list'}], expectationResults:[{id:'rows',result:'passed',observation:'empty state visible'}], confirmationRef:'login-message', confirmation:{kind:'login',sourceRef:'login-message'} }
  const errors = observedCaseErrors(tc,r)
  assert.ok(errors.some(e=>e.includes('Precondition')))
  assert.ok(errors.some(e=>e.includes('copy')))
  assert.ok(errors.some(e=>e.includes('acceptance confirmation')))
})

test('browser reports require per-expectation results, actual runtime entry and current configuration', async () => {
  const f=await fixture()
  const entry=resolveTestEntry(f.runtime,f.env,f.tc,{task:{id:42,classId:9}})
  const context={environmentId:f.env.id,baseURL:f.env.baseURL,mockedRoutes:['profile'],mockHits:{profile:1},runtime:{profileId:'pre',configDigest:f.runtime.sha256,entryId:'detail',entryURL:entry.url,bindings:entry.bindings,services:[{id:'app',result:'met',observation:'current app served'}],prerequisites:[{id:'login',result:'met',observation:'test role visible'}],candidateObservation:'current project process and compiled app'}}
  assert.deepEqual(runtimeEvidenceErrors(f.runtime,f.tc,context),[])
  const report={schemaVersion:1,engine:'ego-browser',runId:'ver-test',cases:[{caseId:f.tc.id,file:f.tc.implementation.file,testId:f.tc.implementation.testId,attempts:1,result:'passed',preconditionResults:[{index:0,result:'met',observation:'fixture available'}],expectationResults:[{id:'E1',result:'passed',observation:'Ada visible in actual UI'}],context}]}
  const options={check:f.delivery.verification.checks[0],cases:f.delivery.testCases,environment:f.env,projectRoot:f.root,outputDir:path.join(f.featureDir,'ver-test')}
  assert.deepEqual((await readBrowserReport(report,options)).errors,[])
  for(const mutate of [r=>{r.cases[0].expectationResults=[]},r=>{r.cases[0].preconditionResults[0].result='unmet'},r=>{r.cases[0].context.runtime.entryURL=f.env.baseURL+'/'},r=>{r.cases[0].context.runtime.configDigest='old'},r=>{r.cases[0].attempts=2}]) {
    const copy=structuredClone(report);mutate(copy)
    assert.ok((await readBrowserReport(copy,options)).errors.length)
  }
  const blocked=structuredClone(report);blocked.cases[0].result='blocked';blocked.cases[0].expectationResults=[];blocked.cases[0].preconditionResults[0].result='unmet'
  assert.equal((await readBrowserReport(blocked,options)).cases[0].status,'blocked')
  blocked.cases[0].file='wrong.mjs'
  assert.equal((await readBrowserReport(blocked,options)).cases[0].status,'failed')
})

test('setup adapter failures block and sensitive path bindings are redacted', async () => {
  const f=await fixture()
  const adapter={services:async()=>{throw new Error('ECONNREFUSED')},prerequisites:async()=>({result:'met',observation:'login visible'}),data:async()=>({task:{id:42,classId:9}}),candidate:async()=>'local checkout'}
  const blocked=await prepareTestEntry(f.runtime,f.env,f.tc,adapter)
  assert.equal(blocked.status,'blocked');assert.match(blocked.reason,/services\/app/)
  f.runtime.profile.entries.detail={url:'{baseURL}/invite/{ticket}',requiredInputs:['ticket']}
  f.tc.entry.bindings={ticket:{source:'session.ticket'}}
  adapter.services=async()=>({result:'met',observation:'service ready'})
  adapter.data=async()=>({session:{ticket:'SYNTHETIC_SECRET'}})
  const prepared=await prepareTestEntry(f.runtime,f.env,f.tc,adapter)
  assert.equal(prepared.status,'ready');assert.match(prepared.url,/SYNTHETIC_SECRET/)
  assert.equal(JSON.stringify(prepared.runtime).includes('SYNTHETIC_SECRET'),false)
  assert.deepEqual(runtimeEvidenceErrors(f.runtime,f.tc,{...f.env,runtime:prepared.runtime}),[])
  f.runtime.profile.entries.detail={url:'{baseURL}/invite/{ticket}?taskId={taskId}',requiredInputs:['ticket','taskId']}
  f.tc.entry.bindings.taskId={source:'task.id'}
  adapter.data=async()=>({session:{ticket:'42'},task:{id:42}})
  const sameValue=await prepareTestEntry(f.runtime,f.env,f.tc,adapter)
  assert.equal(sameValue.runtime.entryURL,f.env.baseURL+'/invite/%5BREDACTED%5D?taskId=42')
  assert.deepEqual(runtimeEvidenceErrors(f.runtime,f.tc,{...f.env,runtime:sameValue.runtime}),[])
})
