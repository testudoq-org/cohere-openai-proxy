import http from 'http';
import https from 'https';

const maxSockets = Number(process.env.OUTBOUND_MAX_SOCKETS) || 50;
export const httpAgent = new http.Agent({ keepAlive: true, maxSockets });
export const httpsAgent = new https.Agent({ keepAlive: true, maxSockets });

export function applyGlobalAgents() {
  try {
    http.globalAgent = httpAgent;
    https.globalAgent = httpsAgent;
  } catch (e) {
    // noop
  }
}
