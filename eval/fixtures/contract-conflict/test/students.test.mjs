import assert from 'node:assert/strict'
import test from 'node:test'
import { formatStudentRow, renderStudentTable } from '../src/students.mjs'

test('formatStudentRow joins id and name', () => {
  assert.equal(formatStudentRow({ id: 1, name: 'Lin' }), '1\tLin')
})

test('formatStudentRow rejects missing fields', () => {
  assert.throws(() => formatStudentRow({ id: 1 }), /id and name/)
})

test('renderStudentTable includes header', () => {
  const text = renderStudentTable([{ id: 2, name: 'Chen' }])
  assert.equal(text, 'ID\tName\n2\tChen')
})
