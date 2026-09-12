import assert from 'node:assert/strict'
import test from 'node:test'
import { createNotice, renderNotice } from '../src/notice.mjs'

test('createNotice trims title', () => {
  assert.deepEqual(createNotice({ title: '  Hello  ' }), { title: 'Hello' })
})

test('createNotice rejects empty title', () => {
  assert.throws(() => createNotice({ title: '   ' }), /title is required/)
})

test('renderNotice shows title line', () => {
  assert.equal(renderNotice({ title: 'Hello' }), 'Title: Hello')
})
