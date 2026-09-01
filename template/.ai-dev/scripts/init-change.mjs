#!/usr/bin/env node

import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const [, , rawSlug, ...titleParts] = process.argv

if (!rawSlug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(rawSlug)) {
  console.error('Usage: node .ai-dev/scripts/init-change.mjs <kebab-case-slug> [title]')
  process.exit(1)
}

const root = process.cwd()
const aiDir = path.join(root, '.ai-dev')
const templateDir = path.join(aiDir, 'templates')

if (!existsSync(templateDir)) {
  console.error(`Template directory not found: ${templateDir}`)
  process.exit(1)
}

const now = new Date()
const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
  .map((value, index) => (index === 0 ? String(value) : String(value).padStart(2, '0')))
  .join('')
const changeId = `${date}-${rawSlug}`
const changeDir = path.join(aiDir, 'changes', changeId)

if (existsSync(changeDir)) {
  console.error(`Change already exists: ${changeDir}`)
  process.exit(1)
}

await mkdir(path.dirname(changeDir), { recursive: true })
await cp(templateDir, changeDir, { recursive: true })

const statusPath = path.join(changeDir, 'status.json')
const title = titleParts.join(' ') || rawSlug
const createdAt = now.toISOString()
const status = JSON.parse(await readFile(statusPath, 'utf8'))
status.id = changeId
status.title = title
status.createdAt = createdAt
status.updatedAt = createdAt
await writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`)

console.log(path.relative(root, changeDir))
