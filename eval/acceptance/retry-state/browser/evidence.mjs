import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdir } from 'node:fs/promises'

const helper = process.env.WORKFLOW_FEATURE_DIR
  ? pathToFileURL(path.resolve(process.env.WORKFLOW_FEATURE_DIR, '../../scripts/lib/visual-evidence.mjs'))
  : new URL('../../../../template/.ai-dev/scripts/lib/visual-evidence.mjs', import.meta.url)
const { captureAcceptanceScreenshot } = await import(helper.href)

export async function capture(page, testInfo, label) {
  const outputDir = path.resolve(process.env.WORKFLOW_VERIFICATION_DIR || 'test-results')
  await mkdir(outputDir, { recursive: true })
  return captureAcceptanceScreenshot(page, { caseId: testInfo.title.match(/^\[([^\]]+)\]/)[1], expectationId: 'E1', label, outputDir })
}

/** 从实际页面读取观察，再写成业务描述；失败时也不复述预期冒充结果。 */
export async function observePage(page) {
  const [state, data, error, retryVisible] = await Promise.all([
    page.locator('#status').textContent().catch(() => null),
    page.locator('#data').textContent().catch(() => null),
    page.getByRole('alert').textContent().catch(() => null),
    page.getByRole('button', { name: '重试', exact: true }).isVisible().catch(() => null),
  ])
  const stateText = { idle: '尚未加载', loading: '加载中', success: '加载成功', failed: '加载失败' }[state] || `无法确认（${state ?? '未能读取'}）`
  let dataText = data === null ? '未能读取' : data ? data : '尚未展示资料'
  try {
    const value = JSON.parse(data)
    if (value && typeof value === 'object' && 'name' in value && 'revision' in value) dataText = `${value.name}（版本 ${value.revision}）`
  } catch { /* 非 JSON 内容按页面原文保留。 */ }
  const errorText = error === null ? '未能读取' : error || '无错误提示'
  const retryText = retryVisible === null ? '未能读取' : retryVisible ? '可见' : '已隐藏'
  return `页面状态：${stateText}；展示资料：${dataText}；错误提示：${errorText}；重试按钮：${retryText}。`
}
