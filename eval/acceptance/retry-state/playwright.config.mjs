import { defineConfig } from '@playwright/test'
import path from 'node:path'
const baseURL = process.env.WORKFLOW_BASE_URL || 'http://127.0.0.1:3117'
const environment = process.env.WORKFLOW_ENVIRONMENT_ID || 'mock'
export default defineConfig({
  testDir: './browser', workers: 1, retries: 0, timeout: 8000,
  expect: { timeout: 2500 },
  reporter: [['list'], ['json', { outputFile: process.env.PLAYWRIGHT_JSON_OUTPUT_FILE || 'test-results/report.json' }]],
  outputDir: path.join(process.env.WORKFLOW_VERIFICATION_DIR || 'test-results', 'evidence'),
  use: { baseURL, serviceWorkers: 'block', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: environment, testMatch: environment === 'live' ? 'live.spec.mjs' : 'retry.spec.mjs' }],
  webServer: { command: 'node server.mjs', url: baseURL, reuseExistingServer: false, timeout: 10000 },
})
