#!/usr/bin/env node

/**
 * 解决什么问题：审核子 Agent 已经启动，用户可能不知道该去哪看过程。
 * 通过什么方式解决：返回 permission: allow，并写 user_message，引导用户去子 Agent 卡片看过程。
 * 触发时机：Cursor subagentStart，匹配到 sdd-reviewer 时。
 * 被谁控制触发：Cursor 宿主 hooks 配置；本脚本不拉起子 Agent。
 */

// 子 Agent 已由宿主拉起，这里只提示用户看卡片。
// 主对话稍后只收审核摘要，不在这里展示过程细节。
// permission 固定 allow，不拦截子 Agent 继续跑。
process.stdout.write(
  `${JSON.stringify({
    permission: 'allow',
    user_message: 'review 子 Agent（sdd-reviewer）已启动。请在子 Agent 卡片里看过程；主对话稍后只收：审了哪些、通过/未通过/需人确认。',
  })}\n`,
)
