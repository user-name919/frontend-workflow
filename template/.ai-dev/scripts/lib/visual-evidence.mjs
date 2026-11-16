import path from 'node:path'
import { mkdir, realpath } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { readEvidenceFile } from './evidence-files.mjs'

const segment = value => encodeURIComponent(String(value)).replaceAll('.', '%2E')

function assertPNG(bytes) {
  if (bytes.length < 45 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.toString('ascii', 12, 16) !== 'IHDR' || !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20) || bytes.toString('ascii', bytes.length - 8, bytes.length - 4) !== 'IEND') throw new Error('Screenshot must be a nonempty PNG image')
}

/** Playwright 与 ego-browser 都支持绝对 path；截图在断言对应状态保存，不用补拍替代历史画面。 */
export async function captureAcceptanceScreenshot(page, { caseId, expectationId, label = 'result', outputDir = process.env.WORKFLOW_VERIFICATION_DIR, screenshotOptions = {} }) {
  if (!caseId || !expectationId || !outputDir) throw new Error('Screenshot needs caseId, expectationId and the current run outputDir')
  const root = await realpath(outputDir)
  const relative = `screenshots/${segment(caseId)}/${segment(expectationId)}-${segment(label)}-${randomUUID()}.png`
  const directory = path.dirname(path.join(root, relative))
  await mkdir(directory, { recursive: true })
  if (!(await realpath(directory)).startsWith(root + path.sep)) throw new Error('Screenshot directory escapes current run')
  await page.screenshot({ ...screenshotOptions, path: path.join(root, relative) })
  assertPNG(await readEvidenceFile(root, relative))
  return relative
}

/** 只校验图片存在、归属和字节；图片内容是否对应业务预期仍由人/Reviewer 对照断言复核。 */
export async function collectVisualEvidence(tc, observations, outputDir, { required = false, passed = false } = {}) {
  const screenshots = []
  const missing = []
  const errors = []
  for (const expected of tc.expectations) {
    const observed = observations?.find(item => item.id === expected.id)
    const refs = observed?.screenshotRefs || []
    if (!Array.isArray(refs)) {
      errors.push(`${expected.id}: screenshotRefs must be an array`)
      continue
    }
    for (const file of new Set(refs)) {
      try {
        if (typeof file !== 'string' || !file.startsWith(`screenshots/${segment(tc.id)}/`) || !file.endsWith('.png')) throw new Error('Screenshot must belong to this case under screenshots/')
        assertPNG(await readEvidenceFile(outputDir, file))
        screenshots.push({ expectationId: expected.id, path: file })
      } catch (error) { errors.push(`${expected.id}: ${error.message}`) }
    }
    if (['ui', 'navigation'].includes(expected.observable) && !screenshots.some(item => item.expectationId === expected.id)) {
      missing.push(expected.id)
      if (required && (passed || observed?.result === 'passed')) errors.push(`${expected.id}: missing screenshot for a passing visual expectation`)
    }
  }
  return { screenshots, missing, errors }
}
