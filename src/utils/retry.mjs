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
    perAttemptTimeoutMs = 3000,
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

  // default retryOn: retry on network-like errors (no status) or 5xx status codes or when error.code exists
  const defaultRetryOn = (err) => {
    if (!err) return false;
    // if there's a numeric status, retry on 5xx
    if (typeof err.status === 'number') return err.status >= 500;
    if (typeof err.statusCode === 'number') return err.statusCode >= 500;
    // if there's a code (e.g., ECONNRESET) treat as retryable
    if (err.code) return true;
    // otherwise assume network error -> retry
    return true;
  };

  const shouldRetry = typeof retryOn === 'function' ? retryOn : defaultRetryOn;

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
        // default jitter: randomize between 50% and 150% of exp
        const multiplier = 0.5 + rng() * 1.0; // [0.5, 1.5)
        delay = exp * multiplier;
      }

      // ensure non-negative and clamp to maxDelayMs
      delay = Math.max(0, Math.min(delay, maxDelayMs));

      // wait before next attempt (use injected waitFn for test determinism)
      // small comment: using await ensures sequential retries
      await waitFn(delay);
      // continue to next attempt
    }
  }

  // if loop exits, throw last error
  throw lastErr;
}
