export function createStartupWatchdog({timeoutMs = 30000, intervalMs = 5000} = {}) {
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
