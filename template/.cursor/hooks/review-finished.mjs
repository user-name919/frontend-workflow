#!/usr/bin/env node

/**
 * 解决什么问题：审核子 Agent 结束后，主 Agent 可能不落盘、不展示结论，用户看不到审了什么。
 * 通过什么方式解决：向宿主写 followup_message，提醒主 Agent 把报告 adapt/decide/accept 并展示 summary。
 * 触发时机：Cursor subagentStop，sdd-reviewer 线程结束时。
 * 被谁控制触发：Cursor 宿主 hooks 配置；本脚本不改状态机、不写 summary.md。
 */

import { startActivity } from '../../.ai-dev/scripts/lib/monitor-events.mjs'

const trace = startActivity({ kind: 'hook', component: 'review-finished.mjs', projectRoot: process.cwd() })
process.once('exit', (code) => trace.finish(code))

// 子 Agent 已停，本脚本只跟一句，不替主 Agent 落盘。
// 主 Agent 必须 adapt/decide/accept，并向用户展示审了哪些、结论和原因。
// 通过则立刻 next；无法确定必须把原因告诉用户，不要代决。
process.stdout.write(
  `${JSON.stringify({
    followup_message:
      'sdd-reviewer 已结束。把报告 adapt/decide/accept，向用户展示审核了哪些、结论（通过/未通过/无法确定）和原因。通过则立刻 next；无法确定必须把原因告诉用户，不要代决。',
  })}\n`,
)
