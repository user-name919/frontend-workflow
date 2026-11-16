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
