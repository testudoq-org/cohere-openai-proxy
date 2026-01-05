import promClient from 'prom-client';
const retryAttemptsCounter = new promClient.Counter({
  name: 'retry_attempts_total',
  help: 'Total retry attempts scheduled'
});
const retryTimeoutsCounter = new promClient.Counter({
  name: 'retry_timeouts_total',
  help: 'Retry attempts that timed out'
});

// Expose embedding-specific retry attempts (env override allowed)
export const EMBEDDING_RETRY_ATTEMPTS = Number(process.env.EMBEDDING_RETRY_ATTEMPTS) || 6;

export async function retry(fn, options = {}) {
  // Backwards-compat: callers may pass (fn, attempts, baseDelayMs, extras?)
  // so normalize arguments. Support an optional 4th arg with extra options
  // to keep legacy callers compatible while allowing injection in tests.
  let _fromLegacy = false;
  if (typeof options === 'number') {
    // legacy: (fn, attempts, baseDelayMs?, extras?)
    _fromLegacy = true;
    const attempts = options;
    const maybeBase = arguments[2];
    const maybeExtras = arguments[3];
    options = { maxAttempts: attempts };
    if (typeof maybeBase === 'number') options.baseDelayMs = maybeBase;
    if (maybeExtras && typeof maybeExtras === 'object') {
      // merge any injected helpers (waitFn, rng, timeoutFactory, etc.)
      options = { ...options, ...maybeExtras };
    }
  }

  // If called using legacy positional args, prefer preserving exact base delays
  // by disabling jitter unless explicitly provided by the legacy extras.
  if (_fromLegacy) {
    options.jitter = options.jitter ?? false;
  }

  // Defaults per new API
  const {
    maxAttempts = 3,
    baseDelayMs = 200,
    maxDelayMs = 2000,
    // jitter: true (boolean) or (delay) => number
    jitter = true,
    perAttemptTimeoutMs = 1500,
    // predicate to decide whether to retry given an error
    retryOn,
    // injectable helpers for testability
    rng = Math.random,
    waitFn = (ms) => new Promise((res) => setTimeout(res, ms)),
    // injectable timeout factory for per-attempt timeout: returns { promise, clear }
    timeoutFactory = (ms) => {
      let id;
      const p = new Promise((_, reject) => {
        id = setTimeout(() => {
          const err = new Error('per-attempt timeout');
          err.code = 'ETIMEDOUT';
          err.isTimeout = true;
          reject(err);
        }, ms);
      });
      return { promise: p, clear: () => clearTimeout(id) };
    },
  } = options || {};

  // default retryOn: treat 429 as retryable, retry on 5xx, and network errors (err.code)
  const defaultRetryOn = (err) => {
    if (!err) return false;
    const status = (typeof err.status === 'number') ? err.status : (typeof err.statusCode === 'number' ? err.statusCode : undefined);
    // Treat 429 (rate limit) as retryable
    if (status === 429) return true;
    // retry on 5xx
    if (typeof status === 'number') return status >= 500;
    // if there's a code (e.g., ECONNRESET) treat as retryable
    if (err.code) return true;
    return false;
  };

  // If called via legacy signature, tests and older callers expect *any* error to be retried
  // unless an explicit retryOn predicate was provided. Honor explicit retryOn but default to
  // always-retry for legacy callers for backwards compatibility.
  let shouldRetry;
  if (_fromLegacy && typeof retryOn === 'undefined') {
    shouldRetry = () => true;
  } else {
    shouldRetry = typeof retryOn === 'function' ? retryOn : defaultRetryOn;
  }

  let lastErr;

  // attempts are 1..maxAttempts
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // per-attempt timeout wrapper using injectable timeoutFactory for determinism in tests
      const result = await (async () => {
        const timeout = timeoutFactory(perAttemptTimeoutMs);
        // start fn (ensure it's invoked immediately)
        const fnPromise = Promise.resolve().then(() => fn());
        try {
          const res = await Promise.race([fnPromise, timeout.promise]);
          // if fn finished, clear timeout and return
          if (timeout && typeof timeout.clear === 'function') timeout.clear();
          return res;
        } catch (err) {
          // ensure timeout cleared if needed
          if (timeout && typeof timeout.clear === 'function') timeout.clear();
          throw err;
        }
      })();

      return result;
    } catch (err) {
      lastErr = err;
      // if should not retry (predicate false) or this was the last attempt, rethrow
      const willRetry = attempt < maxAttempts && shouldRetry(err);
      if (!willRetry) {
        throw lastErr;
      }

      // record timeout metric when applicable
      if (err && err.isTimeout) {
        try { retryTimeoutsCounter.inc(); } catch (e) { /* ignore metric errors */ }
      }

      // compute exponential backoff delay for attempt n (n starts at 1)
      const exp = Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)));

      // apply jitter
      let delay;
      if (typeof jitter === 'function') {
        // allow custom jitter function to compute delay
        delay = jitter(exp, { rng });
      } else if (jitter === false) {
        delay = exp;
      } else {
        // default jitter: center-biased jitter producing multiplier in [0.5,1.5)
        // this keeps delays away from zero and aligns with test expectations
        delay = (0.5 + rng() * 1.0) * exp;
      }

      // ensure non-negative and clamp to maxDelayMs
      delay = Math.max(0, Math.min(delay, maxDelayMs));

      // increment retry attempts metric for this scheduled retry
      try { retryAttemptsCounter.inc(); } catch (e) { /* ignore metric errors */ }

      // wait before next attempt (use injected waitFn for test determinism)
      // small comment: using await ensures sequential retries
      await waitFn(delay);
      // continue to next attempt
    }
  }

  // if loop exits, throw last error
  throw lastErr;
}
