import { it, describe, expect, beforeEach, afterEach } from 'vitest';
import RAGDocumentManager from '../src/ragDocumentManager.mjs';
import fsSync from 'fs';
import fs from 'fs/promises';
import path from 'path';

const OUT_DIR = path.join(process.cwd(), 'test-emb-manifest-race');

async function clean() {
  if (fsSync.existsSync(OUT_DIR)) fsSync.rmSync(OUT_DIR, { recursive: true, force: true });
}

describe('RAGDocumentManager manifest race resilience', () => {
  beforeEach(async () => { await clean(); });
  afterEach(async () => { await clean(); });

  it('ignores corrupted manifest entries and loads valid segments', async () => {
    // create directory and a valid ndjson segment
    await fs.mkdir(OUT_DIR, { recursive: true });
    const valid = JSON.stringify({ key: 'good1', embedding: [1,2,3] }) + '\n';
    const segPath = path.join(OUT_DIR, 'segment-good.ndjson');
    await fs.writeFile(segPath, valid, 'utf8');

    // create a manifest with one valid entry and one corrupted (bad filename with CR)
    const manifest = { segments: [ { file: 'segment-good.ndjson', size: valid.length, createdAt: Date.now() }, { file: 'segment-missing.ndjson\r', size: 10, createdAt: Date.now() } ] };
    await fs.writeFile(path.join(OUT_DIR, 'segments.json'), JSON.stringify(manifest), 'utf8');

    // create manager and load embeddings
    const mgr = new RAGDocumentManager({ embed: async () => {} }, { logger: { warn: () => {}, info: () => {} } });
    mgr.persistEmbeddings = true;
    mgr.persistEmbeddingsDir = OUT_DIR;

    await mgr._loadEmbeddings();

    // should have loaded the valid key and ignored missing/corrupt entry
    const loaded = mgr.embeddingCache.get('good1');
    expect(Array.isArray(loaded)).toBe(true);
  });
});
