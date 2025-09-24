import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import LruTtlCache from '../src/utils/lruTtlCache.mjs';

describe('LRU TTL Cache - Vision and Expiry', () => {
  let cache;

  beforeEach(() => {
    cache = new LruTtlCache({ ttlMs: 100, maxSize: 10 });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('makeVisionKey generates stable key for array input', () => {
    const key1 = LruTtlCache.makeVisionKey('model1', ['input1', 'input2']);
    const key2 = LruTtlCache.makeVisionKey('model1', ['input1', 'input2']);
    expect(key1).toBe(key2);
    expect(key1).toBe('vision:model1:input1|input2');
  });

  it('getOrSetAsync handles expired promise scenario and cleans up in-flight entry', async () => {
    let resolvePromise;
    const asyncFn = vi.fn(() => new Promise(resolve => { resolvePromise = resolve; }));

    // Start an async operation
    const promise1 = cache.getOrSetAsync('key1', asyncFn);
    expect(asyncFn).toHaveBeenCalledTimes(1);

    // Advance time to expire the in-flight promise (but it's stored with infinite expiry)
    vi.advanceTimersByTime(200);

    // Another call should not trigger new asyncFn since promise is in-flight
    const promise2 = cache.getOrSetAsync('key1', asyncFn);
    expect(asyncFn).toHaveBeenCalledTimes(1); // Still 1

    // Resolve the first promise
    resolvePromise('result');

    // Both promises should resolve
    await expect(promise1).resolves.toBe('result');
    await expect(promise2).resolves.toBe('result');

    // Now the result should be cached with normal expiry
    const cached = cache.get('key1');
    expect(cached).toBe('result');
  });

  it('makeEmbedKey generates correct key for string and array inputs', () => {
    const key1 = LruTtlCache.makeEmbedKey('model1', 'input1');
    expect(key1).toBe('embed:model1:["input1"]');

    const key2 = LruTtlCache.makeEmbedKey('model2', ['input1', 'input2']);
    expect(key2).toBe('embed:model2:["input1","input2"]');
  });

  it('makeRerankKey generates correct key for query and documents', () => {
    const key1 = LruTtlCache.makeRerankKey('model1', 'query1', 'doc1');
    expect(key1).toBe('rerank:model1:"query1":["doc1"]');

    const key2 = LruTtlCache.makeRerankKey('model2', 'query2', ['doc1', 'doc2']);
    expect(key2).toBe('rerank:model2:"query2":["doc1","doc2"]');
  });

  it('set triggers pruning when maxSize is exceeded', () => {
    const smallCache = new LruTtlCache({ ttlMs: 100, maxSize: 2 });
    smallCache.set('key1', 'value1');
    smallCache.set('key2', 'value2');
    smallCache.set('key3', 'value3'); // Should prune oldest (key1)
    expect(smallCache.map.has('key1')).toBe(false);
    expect(smallCache.map.has('key2')).toBe(true);
    expect(smallCache.map.has('key3')).toBe(true);
  });

  it('get deletes expired entries', () => {
    const cache = new LruTtlCache({ ttlMs: 100, maxSize: 10 });
    cache.set('key1', 'value1');
    vi.advanceTimersByTime(150); // Expire
    const result = cache.get('key1');
    expect(result).toBeUndefined();
    expect(cache.map.has('key1')).toBe(false);
  });

  it('getOrSetAsync handles asyncFn that throws', async () => {
    const cache = new LruTtlCache({ ttlMs: 100, maxSize: 10 });
    const asyncFn = vi.fn(() => Promise.reject(new Error('async error')));
    await expect(cache.getOrSetAsync('key1', asyncFn)).rejects.toThrow('async error');
    expect(asyncFn).toHaveBeenCalledTimes(1);
  });

  it('getOrSetAsync treats expired non-promise entry as missing and calls asyncFn', async () => {
    // 'cache' is created in beforeEach
    // Manually insert an expired non-promise value
    cache.set('k-expire', 'old-value', { expiry: Date.now() - 1000 });
    const asyncFn = vi.fn(async () => 'fresh-value');
    const result = await cache.getOrSetAsync('k-expire', asyncFn);
    expect(asyncFn).toHaveBeenCalledTimes(1);
    expect(result).toBe('fresh-value');
  });
});
