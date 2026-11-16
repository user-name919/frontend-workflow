import assert from 'node:assert/strict'

/** 供项目浏览器脚本调用：只有实际执行的断言才会留下 passing 记录。 */
export function browserCase(tc, context) {
  const record = { caseId: tc.id, file: tc.implementation.file, testId: tc.implementation.testId, attempts: 1, result: 'passed', preconditionResults: [], expectationResults: [], context, attachments: [] }
  return {
    record,
    require(index, condition, observation) {
      record.preconditionResults.push({ index, result: condition ? 'met' : 'unmet', observation })
      if (!condition) {
        record.result = 'blocked'
        throw new Error(`Precondition ${index + 1}: ${observation}`)
      }
    },
    equal(id, actual, expected, observation, { screenshotRefs } = {}) {
      const item = { id, result: 'failed', observation, ...(screenshotRefs ? { screenshotRefs } : {}) }
      record.expectationResults.push(item)
      try { assert.deepEqual(actual, expected); item.result = 'passed' }
      catch (error) { record.result = 'failed'; throw error }
    },
    async run(body) {
      try { await body(this) }
      catch (error) {
        if (record.result !== 'blocked') record.result = 'failed'
        // 原始错误可能带 Cookie/URL；持久化报告只保留项目提供的脱敏观察和错误类型。
        record.errorType = error.name
      }
      return record
    },
  }
}
