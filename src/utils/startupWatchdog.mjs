export const STARTUP_TIMEOUT_MS = (() => {
  const parsed = Number(process.env.STARTUP_TIMEOUT_MS)
  // default: fail-fast, conservative 15s for CI containers
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 15000
})()

export function createStartupWatchdog({ timeoutMs = STARTUP_TIMEOUT_MS, intervalMs = 5000 } = {}) {
  // Default startup timeout is conservative but short to fail fast in CI or container restarts.
  let timer = null
  let started = false

  function start() {
    const startTs = Date.now()
    timer = setInterval(() => {
      const elapsed = Date.now() - startTs
      if (!started) {
        console.warn(`startupWatchdog: still starting after ${Math.round(elapsed/1000)}s`)
      }
      if (elapsed > timeoutMs && !started) {
        console.error(`startupWatchdog: failed to start within ${Math.round(timeoutMs/1000)}s, exiting`)
        // give logs a moment
        setTimeout(() => process.exit(1), 100)
      }
    }, intervalMs)
  }

  function clear() {
    started = true
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  return {start, clear}
}
