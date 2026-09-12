import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequestController } from '../src/request.mjs'

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body
    },
  }
}

test('load returns JSON on success', async () => {
  const controller = createRequestController(async () => jsonResponse({ name: 'Ada' }))
  const data = await controller.load('/api/profile')
  assert.deepEqual(data, { name: 'Ada' })
})

test('load rejects on HTTP failure', async () => {
  const controller = createRequestController(async () => jsonResponse({ error: 'boom' }, 500))
  await assert.rejects(() => controller.load('/api/profile'), /500/)
})

test('concurrent load reuses in-flight promise', async () => {
  let calls = 0
  const controller = createRequestController(async () => {
    calls += 1
    await new Promise((resolve) => setTimeout(resolve, 20))
    return jsonResponse({ name: 'Ada' })
  })

  const [a, b] = await Promise.all([
    controller.load('/api/profile'),
    controller.load('/api/profile'),
  ])
  assert.deepEqual(a, b)
  assert.equal(calls, 1)
})
