/**
 * Decide whether a Cursor stop hook should inject one review follow-up.
 * Does not spawn models. One follow-up per review_pending key.
 */

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export function reviewPendingKey(status) {
  const tasks = status?.runtime?.taskResults || {}
  for (const [taskId, result] of Object.entries(tasks)) {
    if (result?.status === 'review_pending') {
      return `${status.id}:${taskId}:${result.attemptId || 'unknown'}`
    }
  }
  return null
}

export function shouldInjectReviewFollowup(status, alreadyRequested = []) {
  const key = reviewPendingKey(status)
  if (!key) return { inject: false, key: null }
  if (alreadyRequested.includes(key)) return { inject: false, key }
  return { inject: true, key, taskId: key.split(':')[1] }
}

export function followupMessage(taskId) {
  return [
    `系统：任务 ${taskId} 已进入 review_pending。`,
    '立刻对用户说「正在启动 review 子 Agent」，然后用 Task/spawn 唤起 sdd-reviewer。',
    '不要在本对话自审。不要等人再说 /reviewer。',
    '子 Agent 必须回报：审核了哪些、通过/未通过/无法确定及原因。',
    '全部通过则 persist 后执行 next。无法确定必须把原因告诉用户。',
  ].join(' ')
}

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
