export function createRequestController(fetchImpl = fetch, timeoutMs = 1500) {
  let inFlight = null
  function load(url) {
    if (inFlight) return inFlight
    const abort = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; abort.abort() }, timeoutMs)
    const run = (async () => {
      try {
        const response = await fetchImpl(url, { signal: abort.signal })
        if (!response.ok) throw new Error(`Request failed with ${response.status}`)
        const data = await response.json()
        if (data.error) throw new Error(data.error.message)
        return data
      } catch (error) {
        if (timedOut) throw new Error('请求超时，请重试')
        throw error
      } finally {
        clearTimeout(timer)
      }
    })()
    inFlight = run.finally(() => { inFlight = null })
    return inFlight
  }
  return { load, isLoading: () => inFlight !== null }
}
