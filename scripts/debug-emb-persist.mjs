import RAGDocumentManager from '../src/ragDocumentManager.mjs';
import fsSync from 'fs';
import path from 'path';

(async () => {
  const TMP_EMB_DIR = path.join(process.cwd(), 'test-embeddings-dir');
  if (fsSync.existsSync(TMP_EMB_DIR)) fsSync.rmSync(TMP_EMB_DIR, { recursive: true, force: true });
  const fakeCohere = { embed: async ({ texts }) => ({ body: { embeddings: texts.map(() => [1,2,3]) } }) };
  const mgr = new RAGDocumentManager(fakeCohere, { logger: { warn: (...a) => console.log('WARN', ...a), info: (...a) => console.log('INFO', ...a) } });
  mgr.persistEmbeddings = true;
  mgr.persistEmbeddingsDir = TMP_EMB_DIR;
  mgr.persistEmbSegmentSizeMB = 0.0001;
  mgr.maxEmbeddingBatch = 2;

  mgr.enqueueEmbedding('k1', 't1');
  mgr.enqueueEmbedding('k2', 't2');

  await new Promise((r) => {
    const check = () => { if (!mgr.embeddingWorkerRunning && mgr.embeddingQueue.length === 0) return r(); setTimeout(check, 20); };
    check();
  });

  console.log('Worker finished. Listing dir:');
  if (fsSync.existsSync(TMP_EMB_DIR)) {
    for (const f of fsSync.readdirSync(TMP_EMB_DIR)) {
      try { const s = fsSync.statSync(path.join(TMP_EMB_DIR, f)); console.log('  ', f, s.size); } catch (e) { console.log('  ', f, 'stat failed', e.message); }
    }
    const manifestPath = path.join(TMP_EMB_DIR, 'segments.json');
    if (fsSync.existsSync(manifestPath)) {
      console.log('Manifest:', fsSync.readFileSync(manifestPath, 'utf8'));
    } else console.log('No manifest');
  } else console.log('No dir');

  // try loading into new manager
  const mgr2 = new RAGDocumentManager({ embed: async () => {} }, { logger: { warn: (...a) => console.log('WARN2', ...a), info: (...a) => console.log('INFO2', ...a) } });
  mgr2.persistEmbeddings = true;
  mgr2.persistEmbeddingsDir = TMP_EMB_DIR;
  await mgr2._loadEmbeddings();
  console.log('Loaded keys:', Array.from(mgr2.embeddingCache.map?.keys?.() || []));
})();
