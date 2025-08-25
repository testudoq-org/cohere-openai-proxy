# LRU+TTL Cache (brief)

Location: `src/utils/lruTtlCache.mjs`

Purpose: lightweight in-process LRU cache with TTL for embeddings and small prompt results.

Tuning knobs:
- maxSize: maximum number of entries to hold (evicts least-recently-used)
- ttlMs: time-to-live in milliseconds for each entry

Recommendations:
- For a single-instance dev server: maxSize=1000, ttlMs=24*60*60*1000 (24h) is acceptable.
- For production or multi-instance: use Redis for distributed caching; set shorter TTL (e.g., 1h) and smaller maxSize.

Note: This in-memory cache is intentionally simple and should not be used as a replacement for a persistent vector DB or distributed cache in multi-node deployments.
