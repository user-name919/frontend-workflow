#!/usr/bin/env node

import { ConflictError, runCli } from '../src/installer.mjs'

try {
  const result = await runCli(process.argv.slice(2))
  if (result.ok === false) process.exitCode = 1
} catch (error) {
  console.error(error.message)
  if (error instanceof ConflictError) {
    console.error('\nNothing was changed. Review the files or rerun with --force to create backups and replace them.')
  }
  process.exitCode = 1
}
