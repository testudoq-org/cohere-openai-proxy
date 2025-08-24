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
}

export default LruTtlCache;
