import http from 'http';
import https from 'https';

export const OUTBOUND_MAX_SOCKETS = Number(process.env.OUTBOUND_MAX_SOCKETS) || 50;
export const httpAgent = new http.Agent({ keepAlive: true, maxSockets: OUTBOUND_MAX_SOCKETS });
export const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: OUTBOUND_MAX_SOCKETS });

/**
 * Apply the pre-created agents to Node's globalAgent values.
 * This mutates global state and therefore is opt-in. By default this is a no-op
 * unless the environment variable OUTBOUND_USE_GLOBAL_AGENT is truthy or the
 * optional `force` flag is passed.
 *
 * @param {boolean} [force=false] - force applying agents regardless of env var
 */
export function applyGlobalAgents(force = false) {
  const enabled = force || (process.env.OUTBOUND_USE_GLOBAL_AGENT === '1' || String(process.env.OUTBOUND_USE_GLOBAL_AGENT || '').toLowerCase() === 'true');
  if (!enabled) return;

  try {
    http.globalAgent = httpAgent;
    https.globalAgent = httpsAgent;
  } catch (e) {
    // noop
  }
}
