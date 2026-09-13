#!/usr/bin/env node

process.stdout.write(
  `${JSON.stringify({
    followup_message:
      'sdd-reviewer 已结束。把报告 adapt/decide/accept，向用户展示审核了哪些、结论（通过/未通过/无法确定）和原因。通过则立刻 next；无法确定必须把原因告诉用户，不要代决。',
  })}\n`,
)
