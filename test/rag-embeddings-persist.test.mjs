import { it, describe, expect, beforeEach, afterEach } from 'vitest';
import RAGDocumentManager from '../src/ragDocumentManager.mjs';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';

const TMP_EMB_DIR = path.join(process.cwd(), 'test-embeddings-dir');

describe('RAGDocumentManager embeddings persistence', () => {
  beforeEach(async () => { if (fsSync.existsSync(TMP_EMB_DIR)) fsSync.rmSync(TMP_EMB_DIR, { recursive: true, force: true }); });
  afterEach(async () => { if (fsSync.existsSync(TMP_EMB_DIR)) fsSync.rmSync(TMP_EMB_DIR, { recursive: true, force: true }); });

  it('persists embeddings to ndjson and loads them back', async () => {
    const calls = [];
    const fakeCohere = {
      embed: async ({ texts }) => {
        calls.push(texts);
        return { body: { embeddings: texts.map(() => [1, 2, 3]) } };
      }
    };
    const mgr = new RAGDocumentManager(fakeCohere, { logger: { warn: () => {}, info: () => {} } });
  mgr.persistEmbeddings = true;
  mgr.persistEmbeddingsDir = TMP_EMB_DIR;
  mgr.persistEmbSegmentSizeMB = 0.0001; // tiny so it writes quickly
  mgr.maxEmbeddingBatch = 2;
    // enqueue two items, allow worker to finish
    mgr.enqueueEmbedding('k1', 't1');
    mgr.enqueueEmbedding('k2', 't2');
    await new Promise((r) => {
      const check = () => { if (!mgr.embeddingWorkerRunning && mgr.embeddingQueue.length === 0) return r(); setTimeout(check, 20); };
      check();
    });

  // ensure directory and at least one segment exists
  const exists = fsSync.existsSync(TMP_EMB_DIR) && fsSync.readdirSync(TMP_EMB_DIR).length > 0;
  expect(exists).toBe(true);

    // create new manager and load embeddings
    const mgr2 = new RAGDocumentManager({ embed: async () => {} }, { logger: { warn: () => {}, info: () => {} } });
  mgr2.persistEmbeddings = true;
  mgr2.persistEmbeddingsDir = TMP_EMB_DIR;
  await mgr2._loadEmbeddings();

    const emb1 = mgr2.embeddingCache.get('k1');
    const emb2 = mgr2.embeddingCache.get('k2');
    expect(emb1).toBeDefined();
    expect(emb2).toBeDefined();
    expect(Array.isArray(emb1)).toBe(true);
    expect(Array.isArray(emb2)).toBe(true);
  });
});
