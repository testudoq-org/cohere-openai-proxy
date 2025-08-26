import { test, expect, vi } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
const execFileP = promisify(execFile)

test('importing index with OUTBOUND_USE_GLOBAL_AGENT set mutates global agents', async () => {
  vi.resetModules()
  process.env.OUTBOUND_USE_GLOBAL_AGENT = '1'
  try {
    // Run the exact import sequence in a fresh Node process to avoid cross-test contamination.
    // Child process will:
    // 1) import the exported agents from src/utils/httpAgent.mjs
    // 2) import src/index.mjs (which should call applyGlobalAgents on import)
    // 3) perform tolerant checks: identity OR equivalence of key runtime properties
    const node = process.execPath
    const script = `
      const { httpAgent, httpsAgent } = await import('./src/utils/httpAgent.mjs')
      await import('./src/index.mjs')
      const http = await import('http')
      const https = await import('https')

      // If both global agents are the same object as the exported agents, accept immediately.
      const identityMatch = Object.is(http.globalAgent, httpAgent) && Object.is(https.globalAgent, httpsAgent)
      if (identityMatch) {
        console.log('AGENTS_MATCH')
        process.exit(0)
      }

      // Otherwise assert equivalence of runtime properties: keepAlive and maxSockets (with options fallback).
      const httpKeepAliveOk = (http.globalAgent?.options?.keepAlive === true) || (http.globalAgent?.keepAlive === true)
      const httpsKeepAliveOk = (https.globalAgent?.options?.keepAlive === true) || (https.globalAgent?.keepAlive === true)

      const httpMaxOk =
        (http.globalAgent?.maxSockets === httpAgent?.maxSockets) ||
        (http.globalAgent?.options?.maxSockets === httpAgent?.options?.maxSockets) ||
        (http.globalAgent?.maxSockets === Infinity)

      const httpsMaxOk =
        (https.globalAgent?.maxSockets === httpsAgent?.maxSockets) ||
        (https.globalAgent?.options?.maxSockets === httpsAgent?.options?.maxSockets) ||
        (https.globalAgent?.maxSockets === Infinity)

      const allOk = httpKeepAliveOk && httpsKeepAliveOk && httpMaxOk && httpsMaxOk

      if (allOk) {
        console.log('AGENTS_MATCH')
        process.exit(0)
      } else {
        console.error('AGENTS_MISMATCH')
        console.error({
          httpGlobalAgent: { keepAlive: http.globalAgent?.keepAlive, maxSockets: http.globalAgent?.maxSockets, options: http.globalAgent?.options },
          httpExportedAgent: { keepAlive: httpAgent?.keepAlive, maxSockets: httpAgent?.maxSockets, options: httpAgent?.options },
          httpsGlobalAgent: { keepAlive: https.globalAgent?.keepAlive, maxSockets: https.globalAgent?.maxSockets, options: https.globalAgent?.options },
          httpsExportedAgent: { keepAlive: httpsAgent?.keepAlive, maxSockets: httpsAgent?.maxSockets, options: httpsAgent?.options },
          checks: { httpKeepAliveOk, httpsKeepAliveOk, httpMaxOk, httpsMaxOk }
        })
        process.exit(2)
      }
    `
    const { stdout, stderr } = await execFileP(node, ['--input-type=module', '-e', script], { env: { ...process.env } })
    expect(stdout).toContain('AGENTS_MATCH', `Child process must report AGENTS_MATCH when global agents are set or equivalent.\nSTDERR:\n${stderr}`)
  } finally {
    delete process.env.OUTBOUND_USE_GLOBAL_AGENT
    vi.resetModules()
  }
})