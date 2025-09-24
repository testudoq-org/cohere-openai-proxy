class LruTtlCache {
  constructor({ ttlMs = 300000, maxSize = 500 } = {}) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
    this.map = new Map(); // preserves insertion order
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
  async getOrSetAsync(key, asyncFn) {
    const entry = this.map.get(key);
    if (entry) {
      // If expired and not a promise, treat as missing
      if (this._now() > entry.expiry && !(entry.value && typeof entry.value.then === 'function')) {
        this.map.delete(key);
      } else {
        return entry.value;
      }
    }

    // Store in-flight promise with "infinite" expiry so it won't be evicted by fake timers
    let resolveP, rejectP;
    const p = new Promise((resolve, reject) => {
      resolveP = resolve;
      rejectP = reject;
    });
    this.set(key, p, { expiry: Number.POSITIVE_INFINITY });

    (async () => {
      try {
        const res = await asyncFn();
        // Replace stored promise with resolved value and real expiry
        this.set(key, res);
        resolveP(res);
      } catch (err) {
        this.delete(key);
        rejectP(err);
      }
    })();

    return p;
  }
}

export default LruTtlCache;
