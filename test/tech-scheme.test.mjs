import assert from 'node:assert/strict'
import test from 'node:test'

import { validateTechScheme } from '../template/.ai-dev/scripts/lib/tech-scheme.mjs'

const intake = {
  requirements: [
    { id: 'FR-1', disposition: 'included' },
    { id: 'FR-2', disposition: 'excluded' },
  ],
}

const complete = `# 技术方案

### FR-1
失败后展示重试。

\`\`\`mermaid
flowchart TD
  fail[失败] --> retry[重试]
\`\`\`

\`\`\`mermaid
sequenceDiagram
  User->>Page: 点击重试
  Page->>API: 再请求
\`\`\`
`

test('tech scheme requires mermaid flowchart and sequence, and cites included IDs', () => {
  assert.equal(validateTechScheme(complete, { intake }).ok, true)

  const missing = validateTechScheme('# 技术方案\n\n### FR-1\n行为。\n', { intake })
  assert.ok(missing.errors.some((e) => e.code === 'MISSING_DIAGRAM'))
  assert.ok(missing.errors.some((e) => e.code === 'MISSING_FLOWCHART'))
  assert.ok(missing.errors.some((e) => e.code === 'MISSING_SEQUENCE'))

  const flowOnly = validateTechScheme(
    '# 技术方案\n\n### FR-1\n\n```mermaid\nflowchart TD\n  A --> B\n```\n',
    { intake },
  )
  assert.ok(flowOnly.errors.some((e) => e.code === 'MISSING_SEQUENCE'))
  assert.ok(!flowOnly.errors.some((e) => e.code === 'MISSING_FLOWCHART'))

  const uncited = validateTechScheme(complete.replaceAll('FR-1', 'FR-X'), { intake })
  assert.ok(uncited.errors.some((e) => e.code === 'TECH_SCHEME_UNCITED'))

  const placeholder = validateTechScheme(`${complete}\n[TODO]\n`, { intake })
  assert.ok(placeholder.errors.some((e) => e.code === 'PLACEHOLDER_SPEC'))
})
