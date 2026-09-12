/**
 * Minimal request helper used by the demo page.
 * Baseline: success and failure paths only — no retry API yet.
 */

export function createRequestController(fetchImpl = fetch) {
  let inFlight = null

  async function load(url, { signal } = {}) {
    if (inFlight) {
      return inFlight
    }

    const run = (async () => {
      const response = await fetchImpl(url, { signal })
      if (!response.ok) {
        const error = new Error(`Request failed with ${response.status}`)
        error.status = response.status
        throw error
      }
      return response.json()
    })()

    inFlight = run.finally(() => {
      inFlight = null
    })

    return inFlight
  }

  return {
    load,
    isLoading() {
      return inFlight !== null
    },
  }
}
