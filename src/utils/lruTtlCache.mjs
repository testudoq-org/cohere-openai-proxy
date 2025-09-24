import crypto from 'crypto';

class LruTtlCache {
  constructor({ ttlMs = 300000, maxSize = 500, enableDedup = false } = {}) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
    this.map = new Map(); // preserves insertion order
    this.enableDedup = !!enableDedup;
    this._inFlight = new Map();
    this.metrics = { dedup_hits: 0, dedup_misses: 0, dedup_active: 0 };
  }

  /**
   * Helper to build a stable embed cache key.
   * model: string model id
   * input: string or array of strings
   */
  static makeEmbedKey(model, input) {
    const arr = Array.isArray(input) ? input : [input];
    return `embed:${model}:${JSON.stringify(arr)}`;
  }

  /**
   * Helper to build a stable rerank cache key.
   * model: string model id
   * query: string
   * documents: array of strings
   */
  static makeRerankKey(model, query, documents) {
    const docs = Array.isArray(documents) ? documents : [documents];
    return `rerank:${model}:${JSON.stringify(query)}:${JSON.stringify(docs)}`;
  }

  /**
   * Helper to build a stable vision cache key.
   * model: string model id
   * input: string (base64 image) or array of images
   */
  static makeVisionKey(model, input) {
    const arr = Array.isArray(input) ? input : [input];
    return `vision:${model}:${arr.map(i => typeof i === 'string' ? i.slice(0, 32) : '').join('|')}`;
  }

  /**
   * Canonicalize and hash a payload for deduplication.
   * - Sorts object keys recursively, removes undefined, handles Buffer/Uint8Array.
   * - Returns a hex SHA-256 digest.
   */
  static makeDedupKey(payload) {
    function canonicalize(val) {
      if (val === undefined) return undefined;
      if (val === null) return null;
      if (typeof val === 'object') {
        if (Buffer.isBuffer(val) || val instanceof Uint8Array) {
          // Convert Buffer/Uint8Array to hex string
          return { __bin: Buffer.from(val).toString('hex') };
        }
        if (Array.isArray(val)) {
          return val.map(canonicalize);
        }
        // Object: sort keys, remove undefined
        const out = {};
        for (const k of Object.keys(val).sort()) {
          const v = canonicalize(val[k]);
          if (v !== undefined) out[k] = v;
        }
        return out;
      }
      return val;
    }
    const canon = canonicalize(payload);
    const str = JSON.stringify(canon);
    return crypto.createHash('sha256').update(str).digest('hex');
  }

  _now() { return Date.now(); }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (this._now() > entry.expiry) { this.map.delete(key); return undefined; }
    // refresh LRU order
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value, { expiry } = {}) {
    const realExpiry = typeof expiry === 'number' ? expiry : this._now() + this.ttlMs;
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiry: realExpiry });
    // prune
    while (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  delete(key) { this.map.delete(key); }
  clear() { this.map.clear(); }

  /**
   * Helper to atomically get a cached value or compute & cache an async value.
   * If a concurrent caller triggers the same key, the in-flight promise is cached
   * so only a single upstream request will be performed.
   *
   * Usage:
   *   const result = await cache.getOrSetAsync(key, () => fetchSomething());
   */
  /**
   * Atomically get a cached value or compute & cache an async value.
   * Supports request deduplication via dedupKey if enabled.
   * Options:
   *   - dedup: boolean (default true if enableDedup), bypasses dedup if false
   *   - dedupPayload: object to use for deduplication key (defaults to key)
   */
  async getOrSetAsync(key, asyncFn, { dedup = undefined, dedupPayload = undefined } = {}) {
    // If deduplication is enabled and not bypassed
    const useDedup = (dedup === undefined ? this.enableDedup : dedup);
    if (useDedup) {
      const payload = dedupPayload !== undefined ? dedupPayload : key;
      const dedupKey = LruTtlCache.makeDedupKey(payload);
      if (this._inFlight.has(dedupKey)) {
        this.metrics.dedup_hits++;
        this.metrics.dedup_active = this._inFlight.size;
        return this._inFlight.get(dedupKey);
      }
      this.metrics.dedup_misses++;
      const promise = (async () => {
        try {
          const entry = this.map.get(key);
          if (entry) {
            if (this._now() > entry.expiry && !(entry.value && typeof entry.value.then === 'function')) {
              this.map.delete(key);
            } else {
              return entry.value;
            }
          }
          const res = await asyncFn();
          this.set(key, res);
          return res;
        } finally {
          this._inFlight.delete(dedupKey);
          this.metrics.dedup_active = this._inFlight.size;
        }
      })();
      // Only cache the promise, not the result or rejection
      this._inFlight.set(dedupKey, promise);
      this.metrics.dedup_active = this._inFlight.size;
      try {
        return await promise;
      } catch (err) {
        // Do not cache rejects
        throw err;
      }
    } else {
      // Two behaviors for non-dedup:
      // - If dedup === false (explicit per-call bypass): do NOT share in-flight promises.
      // - If dedup is undefined and enableDedup === false (global disabled): share in-flight promise in map (legacy).
      const explicitBypass = dedup === false;
      const globalDisabled = dedup === undefined && !this.enableDedup;

      if (explicitBypass) {
        this.metrics.dedup_misses++;
        const entry = this.map.get(key);
        if (entry) {
          if (this._now() > entry.expiry && !(entry.value && typeof entry.value.then === 'function')) {
            this.map.delete(key);
          } else {
            return entry.value;
          }
        }
        try {
          const res = await asyncFn();
          this.set(key, res);
          return res;
        } catch (err) {
          this.delete(key);
          throw err;
        }
      }

      if (globalDisabled) {
        // Check if there's already an in-flight promise
        const existing = this.map.get(key);
        if (existing && existing.value && typeof existing.value.then === 'function' && this._now() <= existing.expiry) {
          return existing.value;
        }
        let resolveP, rejectP;
        const p = new Promise((resolve, reject) => {
          resolveP = resolve;
          rejectP = reject;
        });
        this.set(key, p, { expiry: Number.POSITIVE_INFINITY });
        (async () => {
          try {
            const current = this.map.get(key);
            if (current && current.value !== p) {
              if (this._now() <= current.expiry || (current.value && typeof current.value.then === 'function')) {
                resolveP(current.value);
                return;
              } else {
                this.map.delete(key);
              }
            }
            const res = await asyncFn();
            this.set(key, res);
            resolveP(res);
          } catch (err) {
            this.delete(key);
            rejectP(err);
          }
        })();
        return p;
      }

      // Fallback: behave like explicit bypass.
      this.metrics.dedup_misses++;
      const entry = this.map.get(key);
      if (entry) {
        if (this._now() > entry.expiry && !(entry.value && typeof entry.value.then === 'function')) {
          this.map.delete(key);
        } else {
          return entry.value;
        }
      }
      try {
        const res = await asyncFn();
        this.set(key, res);
        return res;
      } catch (err) {
        this.delete(key);
        throw err;
      }
    }
  }
}

export default LruTtlCache;
