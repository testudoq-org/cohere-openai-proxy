import { it, describe, expect, beforeEach, afterEach } from 'vitest';
import RAGDocumentManager from '../src/ragDocumentManager.mjs';
import fsSync from 'fs';
import path from 'path';

const OUT_DIR = path.join(process.cwd(), 'test-emb-rot');

async function clean() {
  if (fsSync.existsSync(OUT_DIR)) {
    for (const f of fsSync.readdirSync(OUT_DIR)) fsSync.unlinkSync(path.join(OUT_DIR, f));
    fsSync.rmdirSync(OUT_DIR);
  }
}

describe('RAGDocumentManager embeddings rotation', () => {
  beforeEach(async () => { await clean(); });
  afterEach(async () => { await clean(); });

  it('rotates segments and loads gzipped segments', async () => {
    const fakeCohere = { embed: async ({ texts }) => ({ body: { embeddings: texts.map(() => [9,9,9]) } }) };
    const mgr = new RAGDocumentManager(fakeCohere, { logger: { warn: () => {}, info: () => {} } });
    mgr.persistEmbeddings = true;
    mgr.persistEmbeddingsDir = OUT_DIR;
    mgr.persistEmbSegmentSizeMB = 0.0001; // tiny to force rotation quickly
    mgr.maxEmbeddingBatch = 1;

    // enqueue several items to trigger multiple segments
    for (let i = 0; i < 5; i++) mgr.enqueueEmbedding(`rk${i}`, `rt${i}`);

    await new Promise((r) => {
      const check = () => { if (!mgr.embeddingWorkerRunning && mgr.embeddingQueue.length === 0) return r(); setTimeout(check, 20); };
      check();
    });

    // rotated files should exist (.gz) and/or ndjson
    const files = fsSync.existsSync(OUT_DIR) ? fsSync.readdirSync(OUT_DIR) : [];
    expect(files.length).toBeGreaterThan(0);
    // manifest should exist and contain entries
    const manifestPath = path.join(OUT_DIR, 'segments.json');
    expect(fsSync.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fsSync.readFileSync(manifestPath, 'utf8'));
    expect(Array.isArray(manifest.segments)).toBe(true);
    expect(manifest.segments.length).toBeGreaterThan(0);
    // now create new manager to load embeddings
    const mgr2 = new RAGDocumentManager({ embed: async () => {} }, { logger: { warn: () => {}, info: () => {} } });
    mgr2.persistEmbeddings = true;
    mgr2.persistEmbeddingsDir = OUT_DIR;
    await mgr2._loadEmbeddings();

    // expect embeddings loaded
    for (let i = 0; i < 5; i++) {
      expect(Array.isArray(mgr2.embeddingCache.get(`rk${i}`))).toBe(true);
    }
  });
});
