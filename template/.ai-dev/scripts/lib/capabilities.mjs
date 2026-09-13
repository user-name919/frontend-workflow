/**
 * 解决什么问题：宿主能不能独立派子 Agent，必须读声明，不能口头自称。
 * 通过什么方式解决：解析 host-capabilities.json 的 features.freshContextDispatch / requestReview。
 * 触发时机：computeNext / 协调器组装能力。
 * 被谁控制触发：orchestrator 读盘后传入；本模块不调模型、不 spawn。
 */

/**
 * 把 host-capabilities.json 的 features 收成模式。
 * freshContextDispatch 支持则为 autonomous-in-host，否则 assisted，并记下限制。
 */
export function resolveCapabilities(config = {}) {
  const features = config.features && typeof config.features === 'object' ? config.features : {}
  const dispatch = features.freshContextDispatch === 'supported' || features.freshContextDispatch === true
  const requestReview = dispatch || features.requestReview === 'supported' || features.requestReview === true
  const limitations = []
  if (!dispatch) {
    limitations.push('freshContextDispatch unsupported; do not claim independent review in this session')
  }
  return {
    hostName: typeof config.hostName === 'string' && config.hostName.trim() ? config.hostName : 'unknown',
    mode: dispatch ? 'autonomous-in-host' : 'assisted',
    freshContextDispatch: dispatch,
    requestReview,
    limitations,
  }
}

/**
 * 只抽出 next 决策需要的两个布尔，避免把整份宿主声明传进编排。
 */
export function toNextCapabilities(resolved) {
  return {
    freshContextDispatch: Boolean(resolved?.freshContextDispatch),
    requestReview: Boolean(resolved?.requestReview),
  }
}

/**
 * 测试或 CLI 覆盖。只有显式布尔 freshContextDispatch 才生效，否则回落到读盘结果。
 */
export function capabilitiesFromOverride(override) {
  if (!override || typeof override !== 'object') return null
  if (typeof override.freshContextDispatch === 'boolean') return override
  return null
}
