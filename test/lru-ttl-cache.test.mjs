import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import LruTtlCache from '../src/utils/lruTtlCache.mjs';

describe('LruTtlCache', () => {
  let cache;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new LruTtlCache({ ttlMs: 1000, maxSize: 3 });
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  describe('Basic cache operations', () => {
    it('stores and retrieves values', () => {
      cache.set('key1', 'value1');
      expect(cache.get('key1')).toBe('value1');
    });

    it('returns undefined for non-existent keys', () => {
      expect(cache.get('nonexistent')).toBeUndefined();
    });

    it('expires entries after TTL', () => {
      cache.set('key1', 'value1');
      expect(cache.get('key1')).toBe('value1');

      vi.advanceTimersByTime(1001);
      expect(cache.get('key1')).toBeUndefined();
    });

    it('refreshes LRU order on access', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.set('key3', 'value3');

      // Access key1 to refresh its LRU position
      cache.get('key1');

      // Add fourth item, should evict key2 (least recently used)
      cache.set('key4', 'value4');

      expect(cache.get('key1')).toBe('value1');
      expect(cache.get('key2')).toBeUndefined();
      expect(cache.get('key3')).toBe('value3');
      expect(cache.get('key4')).toBe('value4');
    });

    it('enforces max size by evicting oldest entries', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.set('key3', 'value3');
      cache.set('key4', 'value4'); // Should evict key1

      expect(cache.get('key1')).toBeUndefined();
      expect(cache.get('key2')).toBe('value2');
      expect(cache.get('key3')).toBe('value3');
      expect(cache.get('key4')).toBe('value4');
    });
  });

  describe('Embeddings caching', () => {
    it('caches embeddings with appropriate key structure', () => {
      const embedKey = 'embed:embed-english-v3.0:["text1","text2"]';
      const embeddings = [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]];

      cache.set(embedKey, embeddings);
      expect(cache.get(embedKey)).toEqual(embeddings);
    });

    it('handles different embedding models separately', () => {
      const key1 = 'embed:embed-english-v3.0:["hello"]';
      const key2 = 'embed:embed-multilingual-v3.0:["hello"]';

      cache.set(key1, [[1, 2, 3]]);
      cache.set(key2, [[4, 5, 6]]);

      expect(cache.get(key1)).toEqual([[1, 2, 3]]);
      expect(cache.get(key2)).toEqual([[4, 5, 6]]);
    });

    it('expires embedding cache entries', () => {
      const embedKey = 'embed:embed-english-v3.0:["test"]';
      cache.set(embedKey, [[1, 2, 3]]);

      vi.advanceTimersByTime(500);
      expect(cache.get(embedKey)).toEqual([[1, 2, 3]]);

      vi.advanceTimersByTime(501);
      expect(cache.get(embedKey)).toBeUndefined();
    });
  });

  describe('Reranking caching', () => {
    it('caches reranking results with query and documents', () => {
      const rerankKey = 'rerank:rerank-multilingual-v3.0:"query text":["doc1","doc2","doc3"]';
      const results = [
        { index: 0, relevance_score: 0.9 },
        { index: 1, relevance_score: 0.7 },
        { index: 2, relevance_score: 0.5 }
      ];

      cache.set(rerankKey, results);
      expect(cache.get(rerankKey)).toEqual(results);
    });

    it('maintains separate cache for different queries', () => {
      const key1 = 'rerank:rerank-multilingual-v3.0:"query1":["doc"]';
      const key2 = 'rerank:rerank-multilingual-v3.0:"query2":["doc"]';

      cache.set(key1, [{ index: 0, relevance_score: 0.8 }]);
      cache.set(key2, [{ index: 0, relevance_score: 0.6 }]);

      expect(cache.get(key1)[0].relevance_score).toBe(0.8);
      expect(cache.get(key2)[0].relevance_score).toBe(0.6);
    });

    it('handles reranking cache eviction under memory pressure', () => {
      const keys = [];
      for (let i = 0; i < 5; i++) {
        const key = `rerank:rerank-multilingual-v3.0:"query${i}":["doc"]`;
        keys.push(key);
        cache.set(key, [{ index: 0, relevance_score: 0.1 * i }]);
      }

      // First key should be evicted
      expect(cache.get(keys[0])).toBeUndefined();
      expect(cache.get(keys[4])).toEqual([{ index: 0, relevance_score: 0.4 }]);
    });
  });

  describe('Async operations', () => {
    it('getOrSetAsync caches successful async results', async () => {
      const key = 'async-test';
      let callCount = 0;

      const asyncFn = async () => {
        callCount++;
        return `result-${callCount}`;
      };

      const result1 = await cache.getOrSetAsync(key, asyncFn);
      expect(result1).toBe('result-1');
      expect(callCount).toBe(1);

      const result2 = await cache.getOrSetAsync(key, asyncFn);
      expect(result2).toBe('result-1'); // Cached result
      expect(callCount).toBe(1); // Function not called again
    });

    it('getOrSetAsync handles concurrent requests with single execution', async () => {
      const key = 'concurrent-test';
      let executionCount = 0;

      const slowAsyncFn = async () => {
        executionCount++;
        await new Promise(resolve => setTimeout(resolve, 100));
        return `executed-${executionCount}`;
      };

      // Start multiple concurrent requests
      const promises = [
        cache.getOrSetAsync(key, slowAsyncFn),
        cache.getOrSetAsync(key, slowAsyncFn),
        cache.getOrSetAsync(key, slowAsyncFn)
      ];

      const results = await Promise.all(promises);

      // All should get the same result
      expect(results).toEqual(['executed-1', 'executed-1', 'executed-1']);
      // Function should only execute once
      expect(executionCount).toBe(1);
    });

    it('getOrSetAsync removes failed promises from cache', async () => {
      const key = 'failed-async-test';
      let callCount = 0;

      const failingAsyncFn = async () => {
        callCount++;
        throw new Error('Async failure');
      };

      await expect(cache.getOrSetAsync(key, failingAsyncFn)).rejects.toThrow('Async failure');
      expect(callCount).toBe(1);

      // Should retry on next call since failed promise was removed
      await expect(cache.getOrSetAsync(key, failingAsyncFn)).rejects.toThrow('Async failure');
      expect(callCount).toBe(2);
    });
  });

  describe('Cache management', () => {
    it('clear removes all entries', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.clear();

      expect(cache.get('key1')).toBeUndefined();
      expect(cache.get('key2')).toBeUndefined();
    });

    it('delete removes specific entries', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');

      cache.delete('key1');

      expect(cache.get('key1')).toBeUndefined();
      expect(cache.get('key2')).toBe('value2');
    });
  });
});