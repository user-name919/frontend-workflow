/**
 * 解决什么问题：主 Agent 停在 review_pending 却没派子 Agent 时，要再催一次。
 * 通过什么方式解决：用 feature:task:attempt 做键，alreadyRequested 已含则不再注入。不调模型、不 spawn。
 * 触发时机：Cursor stop hook。
 * 被谁控制触发：stop hook 脚本。
 */

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * 找到第一个 review_pending 任务，键为 featureId:taskId:attemptId。
 * 没有待审任务则返回 null。
 */
export function reviewPendingKey(status) {
  const tasks = status?.runtime?.taskResults || {}
  for (const [taskId, result] of Object.entries(tasks)) {
    if (result?.status === 'review_pending') {
      return `${status.id}:${taskId}:${result.attemptId || 'unknown'}`
    }
  }
  return null
}

/**
 * 该键未催过才 inject。每个 feature:task:attempt 只催一次。
 * 已在 alreadyRequested 里则只回 key，不再插入。
 */
export function shouldInjectReviewFollowup(status, alreadyRequested = []) {
  const key = reviewPendingKey(status)
  if (!key) return { inject: false, key: null }
  if (alreadyRequested.includes(key)) return { inject: false, key }
  return { inject: true, key, taskId: key.split(':')[1] }
}

/**
 * 插入给主 Agent 的固定催促文案：立刻宣告并唤起 sdd-reviewer，禁止本对话自审。
 */
export function followupMessage(taskId) {
  return [
    `系统：任务 ${taskId} 已进入 review_pending。`,
    '立刻对用户说「正在启动 review 子 Agent」，然后用 Task/spawn 唤起 sdd-reviewer。',
    '不要在本对话自审。不要等人再说 /reviewer。',
    '子 Agent 必须回报：审核了哪些、通过/未通过/无法确定及原因。',
    '全部通过则 persist 后执行 next。无法确定必须把原因告诉用户。',
  ].join(' ')
}

/**
 * 扫描项目下各 feature 的 status.json，列出仍 review_pending 的仓。
 * 读失败的工作区跳过，不抛。
 */
export async function scanReviewPendingFeatures(projectRoot) {
  const featuresRoot = path.join(projectRoot, '.ai-dev/features')
  let names = []
  try {
    names = await readdir(featuresRoot)
  } catch {
    return []
  }
  const pending = []
  for (const name of names) {
    try {
      const status = JSON.parse(await readFile(path.join(featuresRoot, name, 'status.json'), 'utf8'))
      const key = reviewPendingKey(status)
      if (key) pending.push({ featureDir: path.join(featuresRoot, name), status, key })
    } catch {
      // skip unreadable workspaces
    }
  }
  return pending
}
