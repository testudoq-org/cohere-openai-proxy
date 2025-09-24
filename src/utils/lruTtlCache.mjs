class LruTtlCache {
  constructor({ ttlMs = 300000, maxSize = 500 } = {}) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
    this.map = new Map(); // preserves insertion order
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

  set(key, value) {
    const expiry = this._now() + this.ttlMs;
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiry });
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
  async getOrSetAsync(key, asyncFn) {
    const existing = this.get(key);
    if (typeof existing !== 'undefined') return existing;

    // Create a promise and insert immediately to prevent duplicate concurrent calls.
    const p = (async () => {
      try {
        const res = await asyncFn();
        // replace stored promise with the resolved value (preserve TTL)
        this.set(key, res);
        return res;
      } catch (err) {
        // remove failed promise so subsequent calls may retry
        this.delete(key);
        throw err;
      }
    })();

    // store the in-flight promise with TTL so other callers reuse it
    this.set(key, p);
    return p;
  }
}

export default LruTtlCache;
