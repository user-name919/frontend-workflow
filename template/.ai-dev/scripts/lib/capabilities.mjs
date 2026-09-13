/**
 * Host capability contract. Node still does not spawn models.
 * When freshContextDispatch is supported, the coordinator must launch sub-agents.
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

export function toNextCapabilities(resolved) {
  return {
    freshContextDispatch: Boolean(resolved?.freshContextDispatch),
    requestReview: Boolean(resolved?.requestReview),
  }
}

export function capabilitiesFromOverride(override) {
  if (!override || typeof override !== 'object') return null
  if (typeof override.freshContextDispatch === 'boolean') return override
  return null
}
