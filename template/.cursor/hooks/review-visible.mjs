#!/usr/bin/env node

process.stdout.write(
  `${JSON.stringify({
    permission: 'allow',
    user_message: 'review 子 Agent（sdd-reviewer）已启动。请在子 Agent 卡片里看过程；主对话稍后只收：审了哪些、通过/未通过/需人确认。',
  })}\n`,
)
