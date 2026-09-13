import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveCapabilities, toNextCapabilities } from '../template/.ai-dev/scripts/lib/capabilities.mjs'

test('cursor host-capabilities resolve to autonomous-in-host', () => {
  const resolved = resolveCapabilities({
    hostName: 'cursor',
    features: { freshContextDispatch: 'supported', requestReview: 'supported' },
  })
  assert.equal(resolved.mode, 'autonomous-in-host')
  assert.equal(resolved.freshContextDispatch, true)
  assert.deepEqual(toNextCapabilities(resolved), { freshContextDispatch: true, requestReview: true })
})

test('unknown host without dispatch stays assisted', () => {
  const result = resolveCapabilities({})
  assert.equal(result.mode, 'assisted')
  assert.equal(result.freshContextDispatch, false)
  assert.ok(result.limitations.length > 0)
})
