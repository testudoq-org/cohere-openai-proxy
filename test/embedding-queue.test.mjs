import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import embeddingQueue from '../src/services/embeddingQueue.mjs';
import * as cohereClientFactory from '../src/utils/cohereClientFactory.mjs';

function create429Then200Embed(retryCount = 2, embedding = [0.1, 0.2, 0.3]) {
  let callCount = 0;
  const fn = vi.fn(async () => {
    callCount++;
    if (callCount <= retryCount) {
      const err = new Error('TooManyRequestsError');
      err.status = 429;
      throw err;
    }
    return { body: { embeddings: [embedding] } };
  });
  fn.getCallCount = () => callCount;
  return fn;
}

describe('embeddingQueue', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries on 429 and eventually resolves with embedding', async () => {
    const embed = create429Then200Embed(2);
    vi.spyOn(cohereClientFactory, 'createCohereClient').mockResolvedValue({ client: { embed } });
    const result = await embeddingQueue.enqueueEmbedding({ input: ['test'], options: { model: 'embed-english-v3.0' } });
    expect(result.body.embeddings[0]).toEqual([0.1, 0.2, 0.3]);
    expect(embed.getCallCount()).toBeGreaterThanOrEqual(3);
  });

  it('limits concurrency to EMBEDDING_CONCURRENCY=2', async () => {
    process.env.EMBEDDING_CONCURRENCY = '2';
    let active = 0;
    let maxActive = 0;
    const embed = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 50));
      active--;
      return { body: { embeddings: [[0.1, 0.2, 0.3]] } };
    });
    vi.spyOn(cohereClientFactory, 'createCohereClient').mockResolvedValue({ client: { embed } });
    await Promise.all([
      embeddingQueue.enqueueEmbedding({ input: ['a'], options: { model: 'embed-english-v3.0' } }),
      embeddingQueue.enqueueEmbedding({ input: ['b'], options: { model: 'embed-english-v3.0' } }),
      embeddingQueue.enqueueEmbedding({ input: ['c'], options: { model: 'embed-english-v3.0' } })
    ]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it('uses exponential backoff for retries', async () => {
    const delays = [];
    let last = Date.now();
    const embed = create429Then200Embed(3);
    vi.spyOn(cohereClientFactory, 'createCohereClient').mockResolvedValue({ client: { embed } });
    const origSetTimeout = global.setTimeout;
    vi.spyOn(global, 'setTimeout').mockImplementation((fn, ms) => {
      delays.push(ms);
      return origSetTimeout(fn, 0); // fast-forward
    });
    await embeddingQueue.enqueueEmbedding({ input: ['backoff'], options: { model: 'embed-english-v3.0' } });
    expect(delays.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...delays)).toBeGreaterThanOrEqual(100); // at least some backoff
  });
});
