import http from 'http';
import https from 'https';
import zlib from 'zlib';
import dns from 'dns';

// How long we should wait for an external API request before timing out (per-attempt).
// Prefer code default; can be overridden via env var EXTERNAL_API_TIMEOUT_MS.
export const EXTERNAL_API_TIMEOUT_MS = (() => {
  const env = process.env.EXTERNAL_API_TIMEOUT_MS;
  const parsed = Number.parseInt(env, 10);
  // default: fail-fast, conservative 3s
  return (Number.isFinite(parsed) && parsed > 0) ? parsed : 3000;
})();

export const OUTBOUND_MAX_SOCKETS = Number(process.env.OUTBOUND_MAX_SOCKETS) || 150;
const OUTBOUND_MAX_FREE_SOCKETS = Number(process.env.OUTBOUND_MAX_FREE_SOCKETS) || 20;
const AGENT_TIMEOUT_MS = 45000; // 45 seconds

export const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: OUTBOUND_MAX_SOCKETS,
  maxFreeSockets: OUTBOUND_MAX_FREE_SOCKETS,
  timeout: AGENT_TIMEOUT_MS
});
export const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: OUTBOUND_MAX_SOCKETS,
  maxFreeSockets: OUTBOUND_MAX_FREE_SOCKETS,
  timeout: AGENT_TIMEOUT_MS
});

// --- DNS cache implementation (simple, in-process) ---
export const DNS_CACHE_TTL_MS = Number(process.env.DNS_CACHE_TTL_MS) || 10 * 60 * 1000; // 10m default
const dnsCache = new Map(); // key -> { address, family, expiresAt }

function cachedLookup(hostname, options, callback) {
  // support signatures: (hostname, options, callback) or (hostname, callback)
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  options = Object.assign({}, options || {});
  const family = options.family || 4; // prefer IPv4 by default

  const key = `${hostname}:${family}`;
  const now = Date.now();
  const entry = dnsCache.get(key);
  if (entry && entry.expiresAt > now) {
    // return cached result on next tick to keep async semantics
    process.nextTick(() => callback(null, entry.address, entry.family));
    return;
  }

  // Fall back to system dns.lookup; store result in cache
  dns.lookup(hostname, { family }, (err, address, fam) => {
    if (!err && address) {
      dnsCache.set(key, { address, family: fam, expiresAt: now + DNS_CACHE_TTL_MS });
    }
    callback(err, address, fam);
  });
}

export function clearDnsCache() {
  dnsCache.clear();
}

export function getDnsCacheStats() {
  const now = Date.now();
  let entries = 0;
  for (const [k, v] of dnsCache.entries()) {
    if (v.expiresAt > now) entries++;
  }
  return { entries, ttlMs: DNS_CACHE_TTL_MS };
}

// --- Connection reuse tracking ---
function attachReuseTracking(agent) {
  agent._reuseStats = { totalRequests: 0, reusedConnections: 0 };

  const origAddRequest = agent.addRequest;
  agent.addRequest = function (req, options) {
    agent._reuseStats.totalRequests++;

    // Build a name similar to internal agent keying to detect free sockets.
    // This is a best-effort heuristic and mirrors common agent key shapes.
    const hostname = options.host || options.hostname || '';
    const port = options.port || (options.protocol === 'https:' ? 443 : 80) || '';
    const local = options.localAddress || '';
    const nameKey = `${hostname}:${port}:${local}`;

    const freeList = (agent.freeSockets && agent.freeSockets[nameKey]) || [];
    const willReuse = Array.isArray(freeList) && freeList.length > 0;
    if (willReuse) agent._reuseStats.reusedConnections++;

    return origAddRequest.call(agent, req, options);
  };
}

attachReuseTracking(httpAgent);
attachReuseTracking(httpsAgent);

export function getAgentReuseStats() {
  return {
    http: Object.assign({}, httpAgent._reuseStats || {}),
    https: Object.assign({}, httpsAgent._reuseStats || {})
  };
}

/**
 * Monkey-patch http(s).request to:
 *  - ensure outgoing requests include Accept-Encoding: gzip, deflate (unless already set)
 *  - set a default IPv4 preference (family: 4) unless overridden
 *  - use a cached DNS lookup function by default (unless options.lookup already provided)
 *  - automatically transparently decompress gzip/deflate responses so callers receive a decoded stream
 *
 * This is a best-effort global enhancement and is executed at module load so that any
 * outbound requests from SDKs using node's http/https will benefit.
 */
function enableAcceptEncodingAndAutoDecompress() {
  const origHttpRequest = http.request.bind(http);
  const origHttpsRequest = https.request.bind(https);

  const wrapRequest = (origRequest) => {
    return function patchedRequest(input, optsOrCallback, maybeCallback) {
      let options;
      let callback;

      // Normalize arguments (support signatures: (options[, callback]) and (url[, options][, callback]))
      if (typeof input === 'string' || input instanceof URL) {
        // input is URL/string
        const urlObj = (typeof input === 'string') ? new URL(input) : input;
        // optsOrCallback may be options or callback
        if (typeof optsOrCallback === 'function' && !maybeCallback) {
          options = {};
          callback = optsOrCallback;
        } else {
          options = Object.assign({}, optsOrCallback || {});
          callback = maybeCallback;
        }
        options.protocol = options.protocol || urlObj.protocol;
        options.hostname = options.hostname || urlObj.hostname;
        options.port = options.port || urlObj.port;
        options.path = options.path || `${urlObj.pathname || ''}${urlObj.search || ''}`;
      } else {
        // input is options object
        options = Object.assign({}, input || {});
        if (typeof optsOrCallback === 'function') {
          callback = optsOrCallback;
        } else {
          // optsOrCallback may be undefined (no callback) or an options-like object (rare)
          if (optsOrCallback && typeof optsOrCallback === 'object') {
            options = Object.assign(options, optsOrCallback);
            callback = maybeCallback;
          } else {
            callback = maybeCallback;
          }
        }
      }

      // Ensure headers object exists and add Accept-Encoding if not provided (case-insensitive)
      options.headers = Object.assign({}, options.headers || {});
      const hasAcceptEncoding = Object.keys(options.headers).some(h => String(h).toLowerCase() === 'accept-encoding');
      if (!hasAcceptEncoding) {
        options.headers['Accept-Encoding'] = 'gzip, deflate';
      }

      // Prefer IPv4 by default unless caller explicitly sets family
      if (options.family == null) options.family = 4;

      // Use our cached DNS lookup by default unless a custom lookup is provided
      if (!options.lookup) options.lookup = cachedLookup;

      // Make the actual request. We provide our own callback so we can transparently
      // replace a compressed response with a decoded stream before returning it to callers.
      const req = origRequest(options, (res) => {
        const rawEncoding = (res.headers && (res.headers['content-encoding'] || res.headers['Content-Encoding'])) || '';
        const encoding = String(rawEncoding).toLowerCase();

        if (encoding === 'gzip' || encoding === 'x-gzip') {
          const gunzip = zlib.createGunzip();
          // Pipe the compressed response into the gunzip stream
          res.pipe(gunzip);
          // Copy important properties from original response onto the decoded stream so callers can inspect them
          const decoded = gunzip;
          decoded.statusCode = res.statusCode;
          decoded.headers = Object.assign({}, res.headers);
          // Remove content-encoding since data is now decoded
          delete decoded.headers['content-encoding'];
          delete decoded.headers['Content-Encoding'];
          decoded.httpVersion = res.httpVersion;
          decoded.rawHeaders = res.rawHeaders;
          decoded.url = res.url;
          decoded.socket = res.socket;
          decoded.setEncoding = res.setEncoding?.bind(res);

          if (typeof callback === 'function') callback(decoded);
          // Ensure listeners attached via req.on('response', ...) still receive the decoded stream
          process.nextTick(() => req.emit('response', decoded));
          return;
        }

        if (encoding === 'deflate' || encoding === 'x-deflate') {
          const inflate = zlib.createInflate();
          res.pipe(inflate);
          const decoded = inflate;
          decoded.statusCode = res.statusCode;
          decoded.headers = Object.assign({}, res.headers);
          delete decoded.headers['content-encoding'];
          delete decoded.headers['Content-Encoding'];
          decoded.httpVersion = res.httpVersion;
          decoded.rawHeaders = res.rawHeaders;
          decoded.url = res.url;
          decoded.socket = res.socket;
          decoded.setEncoding = res.setEncoding?.bind(res);

          if (typeof callback === 'function') callback(decoded);
          process.nextTick(() => req.emit('response', decoded));
          return;
        }

        // No recognized content-encoding, return original response as-is
        if (typeof callback === 'function') callback(res);
        process.nextTick(() => req.emit('response', res));
      });

      return req;
    };
  };

  http.request = wrapRequest(origHttpRequest);
  https.request = wrapRequest(origHttpsRequest);
}

// Enable the patch at module load so outbound calls benefit without additional changes.
enableAcceptEncodingAndAutoDecompress();

/**
 * Apply the pre-created agents to Node's globalAgent values.
 * This mutates global state and therefore is opt-in. By default this is a no-op
 * unless the environment variable OUTBOUND_USE_GLOBAL_AGENT is truthy or the
 * optional `force` flag is passed.
 *
 * @param {boolean} [force=false] - force applying agents regardless of env var
 */
export function applyGlobalAgents(force = false) {
  const envVal = process.env.OUTBOUND_USE_GLOBAL_AGENT;
  const envEnabled = envVal === '1' || String(envVal || '').toLowerCase() === 'true';
  const inProduction = process.env.NODE_ENV === 'production';
  const enabled = force || envEnabled || inProduction;
  if (!enabled) return;

  try {
    http.globalAgent = httpAgent;
    https.globalAgent = httpsAgent;
  } catch (e) {
    // noop
  }
}
