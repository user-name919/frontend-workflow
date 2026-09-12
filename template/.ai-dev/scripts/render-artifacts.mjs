#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

import { validateIntake, renderIntake } from './lib/intake.mjs'
import { validateDelivery, renderDelivery } from './lib/delivery.mjs'
import { readFeature } from './lib/workspace-store.mjs'

async function writeAllOrNothing(featureDir, files) {
  const staging = path.join(featureDir, `.render-staging-${randomBytes(4).toString('hex')}`)
  await mkdir(staging, { recursive: true })
  try {
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(staging, relative)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, content)
    }
    for (const relative of Object.keys(files)) {
      const from = path.join(staging, relative)
      const to = path.join(featureDir, relative)
      await mkdir(path.dirname(to), { recursive: true })
      await rename(from, to)
    }
  } finally {
    // best-effort cleanup of staging leftovers
    try {
      const { rm } = await import('node:fs/promises')
      await rm(staging, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}

export async function renderFeatureArtifacts(featureDir, options = {}) {
  const resolved = path.resolve(featureDir)
  const intake = JSON.parse(await readFile(path.join(resolved, 'artifacts/analysis/intake.json'), 'utf8'))
  const intakeCheck = validateIntake(intake)
  if (!intakeCheck.ok) {
    const error = new Error(intakeCheck.errors.map((item) => item.message).join('; '))
    error.code = 'INVALID_INTAKE'
    error.errors = intakeCheck.errors
    throw error
  }

  const files = { ...renderIntake(intake) }

  const deliveryPath = path.join(resolved, 'artifacts/design/delivery.json')
  let delivery
  try {
    delivery = JSON.parse(await readFile(deliveryPath, 'utf8'))
  } catch {
    delivery = null
  }

  if (delivery) {
    const deliveryCheck = validateDelivery(intake, delivery, { phase: options.phase || 'plan' })
    if (!deliveryCheck.ok) {
      const error = new Error(deliveryCheck.errors.map((item) => item.message).join('; '))
      error.code = 'INVALID_DELIVERY'
      error.errors = deliveryCheck.errors
      throw error
    }
    let taskResults = {}
    try {
      const status = await readFeature(resolved)
      taskResults = status.runtime?.taskResults || {}
    } catch {
      taskResults = {}
    }
    Object.assign(files, renderDelivery(intake, delivery, taskResults))
  }

  await writeAllOrNothing(resolved, files)
  return Object.keys(files).sort()
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  const featureDir = process.argv[2]
  if (!featureDir) {
    console.error('Usage: node .ai-dev/scripts/render-artifacts.mjs <feature-dir>')
    process.exit(1)
  }
  try {
    const written = await renderFeatureArtifacts(featureDir)
    console.log(JSON.stringify({ ok: true, written }, null, 2))
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error.code || 'ERROR', message: error.message, errors: error.errors }, null, 2))
    process.exit(1)
  }
}
