// Simple in-memory TTL cache for prompt responses

class MemoryCache {
  constructor(ttlMs = 300000, maxSize = 500) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  _now() {
    return Date.now();
  }

  _prune() {
    if (this.cache.size > this.maxSize) {
      // Remove oldest entries
      const keys = Array.from(this.cache.keys());
      for (let i = 0; i < this.cache.size - this.maxSize; i++) {
        this.cache.delete(keys[i]);
      }
    }
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (this._now() > entry.expiry) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value) {
    const expiry = this._now() + this.ttlMs;
    this.cache.set(key, { value, expiry });
    this._prune();
  }

  delete(key) {
    this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }
}

module.exports = MemoryCache;