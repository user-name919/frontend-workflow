import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { REVIEW_SCHEME, REVIEW_SYNC, CONSISTENCY_CHECKS, reviewSchemeDigests } from '../../template/.ai-dev/scripts/lib/review-scheme.mjs'

export const readableScheme = `# 重试技术方案

## 目标
失败后可重试，沿用当前页面与接口，不增加后台规则。

## 架构图
\`\`\`mermaid
flowchart LR
  Page[现有页面] --> API[现有接口]
\`\`\`

## 流程图
\`\`\`mermaid
flowchart TD
  Failure[请求失败] --> Retry[点击重试]
  Retry --> Request[重新请求]
\`\`\`
`
export async function writeReviewScheme(featureDir) {
  const intake = JSON.parse(await readFile(path.join(featureDir, 'artifacts/analysis/intake.json'), 'utf8'))
  const delivery = JSON.parse(await readFile(path.join(featureDir, 'artifacts/design/delivery.json'), 'utf8'))
  await writeFile(path.join(featureDir, REVIEW_SCHEME), readableScheme)
  const record = {
    schemaVersion: 1, checkedBy: 'fixture-reviewer',
    coverage: Object.fromEntries([...intake.requirements.filter(item => item.disposition === 'included'), ...delivery.acceptance].map(item => [item.id, { section: '目标', evidence: '编号版重试与阅读版目标、流程一致' }])),
    checks: Object.fromEntries(CONSISTENCY_CHECKS.map(key => [key, { result: 'pass', evidence: '对照编号版与目标、架构图及流程图，重试行为一致' }])),
    digests: await reviewSchemeDigests(featureDir),
  }
  await writeFile(path.join(featureDir, REVIEW_SYNC), JSON.stringify(record))
  return record
}
