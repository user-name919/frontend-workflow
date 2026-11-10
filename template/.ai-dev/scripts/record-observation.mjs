#!/usr/bin/env node

import path from 'node:path'
import { finishSkillObservation, startSkillObservation, traceContext } from './lib/monitor-events.mjs'

function parseArgs(args) {
  const [action, ...rest] = args
  const values = {}
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]
    if (!['--skill', '--feature-dir', '--task', '--id', '--project-root'].includes(key) || !rest[index + 1]) {
      throw new Error('Usage: record-observation.mjs start --skill <name> (--feature-dir <dir> | --project-root <dir>) [--task <id>] | finish --id <id> [--project-root <dir>]')
    }
    values[key.slice(2)] = rest[index + 1]
  }
  return { action, values }
}

try {
  const { action, values } = parseArgs(process.argv.slice(2))
  if (action === 'start') {
    if (!values.skill || (!values['feature-dir'] && !values['project-root'])) throw new Error('start requires --skill and either --feature-dir or --project-root')
    const context = traceContext(values['feature-dir'], values['project-root'] || process.cwd())
    if (values['feature-dir'] && !context.featureId) throw new Error('feature-dir must be a workflow feature workspace')
    const id = startSkillObservation(context.projectRoot, values['feature-dir'], values.skill, values.task)
    console.log(JSON.stringify({ ok: true, id, source: 'agent' }))
  } else if (action === 'finish') {
    const root = path.resolve(values['project-root'] || process.cwd())
    const event = finishSkillObservation(root, values.id)
    console.log(JSON.stringify({ ok: true, id: event.id, status: event.status }))
  } else {
    throw new Error('Expected start or finish')
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, message: error.message }))
  process.exitCode = 1
}
