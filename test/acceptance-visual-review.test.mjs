import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { acceptanceFixture, protocolPNG } from './helpers/acceptance.mjs'
import { runVerification } from '../template/.ai-dev/scripts/lib/verification.mjs'
import { acceptanceReadiness, refreshAcceptanceResults, writeJsonAtomic } from '../template/.ai-dev/scripts/lib/acceptance.mjs'
import { readPlaywrightReport, readBrowserReport } from '../template/.ai-dev/scripts/lib/verification-report.mjs'
import { captureAcceptanceScreenshot, collectVisualEvidence } from '../template/.ai-dev/scripts/lib/visual-evidence.mjs'
import { browserCase } from '../template/.ai-dev/scripts/lib/browser-case.mjs'
import { formatVerificationProgress, renderRunReview } from '../template/.ai-dev/scripts/lib/acceptance-report.mjs'

test('new runs bind visual evidence, retain reports and expose human-readable progress', async () => {
  const f = await acceptanceFixture()
  const events = []
  const record = await runVerification(f.featureDir, { checkId: 'browser', scope: 'feature' }, { onProgress: event => events.push(event) })
  assert.equal(record.status, 'passed', record.summary)
  assert.equal(record.visualEvidenceVersion, 1)
  const image = record.cases[0].visualEvidence.screenshots[0]
  assert.ok(record.files.some(file => file.path.endsWith(image.path)))
  assert.ok(record.files.some(file => file.path === record.reportPath))
  const report = await readFile(path.join(f.featureDir, record.reportPath), 'utf8')
  assert.ok(report.includes(image.path))
  assert.match(report, /Ada is displayed/)
  assert.match(report, /Synthetic reporter assertion/)
  assert.match(report, /只证明受控条件下的前端行为/)
  const index = await readFile(path.join(f.featureDir, 'artifacts/verification/index.html'), 'utf8')
  assert.match(index, /工程检查（不计业务用例）/)
  assert.match(index, /未执行/)
  assert.deepEqual(events.map(e => e.phase), ['start','finish'])
  assert.match(formatVerificationProgress(events[0]), /最终候选版本.*Mock.*1 个业务用例/)
  assert.match(formatVerificationProgress(events[1]), /通过 1.*失败 0/)
  assert.ok(formatVerificationProgress(events[1]).includes(path.join(f.featureDir, record.reportPath)))
  await writeFile(path.join(f.featureDir, 'revisions/verifications', record.id, image.path), 'changed')
  const readiness = await acceptanceReadiness(f.featureDir)
  assert.match(readiness.checks[0].status, /evidence changed/)
})

test('missing screenshots reject a new passing run without rewriting legacy report policy', async () => {
  const f = await acceptanceFixture()
  const options = { check: f.delivery.verification.checks[0], cases: f.delivery.testCases, environment: f.delivery.verification.environments[0], projectRoot: f.root, outputDir: f.featureDir }
  assert.deepEqual((await readPlaywrightReport(f.report, options)).errors, [])
  assert.match(JSON.stringify((await readPlaywrightReport(f.report, { ...options, requireScreenshots: true })).errors), /complete environment evidence/)
  f.delivery.verification.checks[0].args = ['-e', `require('fs').writeFileSync(process.env.WORKFLOW_JSON_OUTPUT_FILE,${JSON.stringify(JSON.stringify(f.report))})`]
  await writeJsonAtomic(path.join(f.featureDir, 'artifacts/design/delivery.json'), f.delivery)
  const run = await runVerification(f.featureDir, { scope:'feature', checkId:'browser' })
  assert.equal(run.status, 'failed')
  assert.match(JSON.stringify(run.cases), /missing screenshot/)
  const report = await readFile(path.join(f.featureDir, run.reportPath), 'utf8')
  assert.match(report, /无截图，不能凭此报告目视复核/)
  assert.match(report, /Synthetic reporter assertion/)
})

test('browser adapter binds actual assertion screenshot and rejects missing, wrong-case, non-image and escaped files', async () => {
  const f = await acceptanceFixture()
  const tc = f.delivery.testCases[0]
  const outputDir = path.join(f.featureDir, 'ver-browser')
  await mkdir(outputDir)
  const png = Buffer.from(protocolPNG, 'base64')
  const page = { screenshot: async ({ path: destination }) => writeFile(destination, png) }
  const shot = await captureAcceptanceScreenshot(page, { caseId: tc.id, expectationId:'E1', outputDir })
  const ctx = { environmentId:'mock', baseURL:'http://127.0.0.1:3000', mockedRoutes:['profile'], mockHits:{profile:1} }
  const actor = browserCase(tc,ctx)
  actor.require(0,true,'Synthetic protocol precondition')
  actor.equal('E1', 'Ada', 'Ada', 'Synthetic protocol observation', { screenshotRefs:[shot] })
  const report = {schemaVersion:1,engine:'ego-browser',runId:'ver-browser',cases:[actor.record]}
  const options = { check:f.delivery.verification.checks[0], cases:[tc], environment:f.delivery.verification.environments[0], projectRoot:f.root, outputDir, requireScreenshots:true }
  assert.deepEqual((await readBrowserReport(report,options)).errors,[])
  assert.ok((await readBrowserReport(report,options)).evidencePaths.includes(shot))
  for (const ref of ['screenshots/TC-other/E1.png', 'screenshots/TC-1/../../../outside.png', '/tmp/outside.png', 'screenshots/TC-1/missing.png']) {
    const bad=structuredClone(report);bad.cases[0].expectationResults[0].screenshotRefs=[ref]
    assert.equal((await readBrowserReport(bad,options)).cases[0].status,'failed')
  }
  await writeFile(path.join(f.root,'outside.png'),png)
  await symlink(path.join(f.root,'outside.png'),path.join(outputDir,'screenshots/TC-1/escape.png'))
  const escaped = await collectVisualEvidence(tc,[{id:'E1',result:'passed',screenshotRefs:['screenshots/TC-1/escape.png']}],outputDir,{required:true,passed:true})
  assert.match(escaped.errors.join(' '), /escapes root/)
  await writeFile(path.join(outputDir,shot),'<html>not an image</html>')
  assert.match((await readBrowserReport(report,options)).cases[0].errors.join(' '), /PNG/)
})

test('blocked setup does not need invented images; failed assertions retain their actual screenshot', async () => {
  const f = await acceptanceFixture()
  const tc=f.delivery.testCases[0], dir=f.featureDir
  const shot=await captureAcceptanceScreenshot({screenshot:async({path:file})=>writeFile(file,Buffer.from(protocolPNG,'base64'))},{caseId:tc.id,expectationId:'E1',outputDir:dir})
  const context={environmentId:'mock',baseURL:'http://127.0.0.1:3000',mockedRoutes:['profile'],mockHits:{profile:1}}
  const failed=browserCase(tc,context)
  await failed.run(async c=>{ c.require(0,true,'Synthetic fixture');c.equal('E1','wrong','Ada','Actual wrong value',{screenshotRefs:[shot]}) })
  const options={check:f.delivery.verification.checks[0],cases:[tc],environment:f.delivery.verification.environments[0],projectRoot:f.root,outputDir:dir,requireScreenshots:true}
  const report={schemaVersion:1,engine:'ego-browser',runId:path.basename(dir),cases:[failed.record]}
  const parsed=await readBrowserReport(report,options)
  assert.equal(parsed.cases[0].status,'failed')
  assert.equal(parsed.cases[0].visualEvidence.screenshots.length,1)
  const blocked=browserCase(tc,context)
  await blocked.run(async c=>c.require(0,false,'No populated data'))
  report.cases=[blocked.record]
  assert.equal((await readBrowserReport(report,options)).cases[0].status,'blocked')
})

test('overview marks stale candidate while immutable run report preserves its historical result', async () => {
  const f=await acceptanceFixture()
  const run=await runVerification(f.featureDir,{scope:'feature',checkId:'browser'})
  const original=await readFile(path.join(f.featureDir,run.reportPath),'utf8')
  await writeFile(path.join(f.root,'app.js'),'// new candidate\n')
  await refreshAcceptanceResults(f.featureDir)
  const index=await readFile(path.join(f.featureDir,'artifacts/verification/index.html'),'utf8')
  assert.match(index,/已过期/)
  assert.match(index,/历史结果不代表当前代码通过/)
  assert.equal(await readFile(path.join(f.featureDir,run.reportPath),'utf8'),original)
})

test('legacy or invalid deliveries retain actionable readiness errors instead of crashing the report view', async () => {
  const f=await acceptanceFixture()
  f.delivery.schemaVersion=1
  await writeJsonAtomic(path.join(f.featureDir,'artifacts/design/delivery.json'),f.delivery)
  assert.equal((await refreshAcceptanceResults(f.featureDir)).errors[0].code,'ACCEPTANCE_MIGRATION_REQUIRED')
  const legacy=await readFile(path.join(f.featureDir,'artifacts/verification/verification.md'),'utf8')
  assert.equal(legacy.includes('](index.html)'),false)
  f.delivery.schemaVersion=2;delete f.delivery.testCases
  await writeJsonAtomic(path.join(f.featureDir,'artifacts/design/delivery.json'),f.delivery)
  assert.equal((await refreshAcceptanceResults(f.featureDir)).ok,false)
  assert.match(await readFile(path.join(f.featureDir,'artifacts/verification/index.html'),'utf8'),/不能据此宣称整单通过/)
})

test('HTML escapes observations and redacts URL credentials while CLI keeps machine JSON on stdout', async () => {
  const f=await acceptanceFixture()
  await writeFile(path.join(f.root,'request.json'),JSON.stringify({scope:'feature',checkId:'browser'}))
  const result=spawnSync(process.execPath,[path.resolve('template/.ai-dev/scripts/run-verification.mjs'),f.featureDir,'--request',path.join(f.root,'request.json')],{encoding:'utf8'})
  assert.equal(result.status,0,result.stderr)
  assert.match(result.stderr,/开始需求自动验收/)
  assert.match(result.stderr,/测试结束｜通过/)
  const {result:run}=JSON.parse(result.stdout)
  assert.equal(run.status,'passed')
  run.cases[0].context.expectationResults[0].observation='<script>alert(1)</script> http://localhost/?sysToken=TOP_SECRET#/detail?ticket=SECRET2'
  const html=renderRunReview(run,f.delivery,f.intake)
  assert.equal(html.includes('<script>'),false)
  assert.equal(html.includes('TOP_SECRET'),false)
  assert.equal(html.includes('SECRET2'),false)
  assert.match(html,/&lt;script&gt;/)
})
