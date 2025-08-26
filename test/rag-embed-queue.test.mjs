import { it, describe, expect, vi, beforeEach } from 'vitest';
import RAGDocumentManager from '../src/ragDocumentManager.mjs';
import LruTtlCache from '../src/utils/lruTtlCache.mjs';

describe('RAGDocumentManager embedding queue', () => {
  let fakeCohere;
  let mgr;

  beforeEach(() => {
    fakeCohere = {
      // record last payloads
      _calls: [],
      embed: async function (payload) {
        this._calls.push(payload);
        // echo an embedding of correct length (simple numeric vector)
        const embeddings = (payload.texts || payload.text || []).map(() => [0.1, 0.2, 0.3]);
        return { body: { embeddings } };
      },
    };
    mgr = new RAGDocumentManager(fakeCohere, { logger: { warn: () => {}, info: () => {}, error: () => {} } });
    // speed up worker delays for test
    mgr.maxEmbeddingBatch = 3;
    mgr.embeddingWorkerDelayMs = 10;
  });

  it('processes enqueued items in batches and caches embeddings', async () => {
    // enqueue 5 items -> expect two batches (3 + 2)
    for (let i = 0; i < 5; i++) {
      mgr.enqueueEmbedding(`k${i}`, `text-${i}`);
    }

    // wait until worker finishes
    await new Promise((resolve) => {
      const check = () => {
        if (!mgr.embeddingWorkerRunning && mgr.embeddingQueue.length === 0) return resolve();
        setTimeout(check, 20);
      };
      check();
    });

    // verify cache entries
    for (let i = 0; i < 5; i++) {
      const emb = mgr.embeddingCache.get(`k${i}`);
      expect(Array.isArray(emb)).toBe(true);
      expect(emb.length).toBe(3);
    }

    // verify cohere client was called at least twice
    expect(fakeCohere._calls.length).toBeGreaterThanOrEqual(2);
    // verify batch sizes
    const sizes = fakeCohere._calls.map(c => (c.texts || c.text || []).length);
    expect(sizes.reduce((a,b)=>a+b,0)).toBe(5);
  });
});
