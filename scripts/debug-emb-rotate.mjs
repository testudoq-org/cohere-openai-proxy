import RAGDocumentManager from '../src/ragDocumentManager.mjs';
import fsSync from 'fs';
import path from 'path';

const OUT_DIR = path.join(process.cwd(), 'test-emb-rot');
(async ()=>{
  if (fsSync.existsSync(OUT_DIR)) fsSync.rmSync(OUT_DIR,{recursive:true,force:true});
  const fakeCohere = { embed: async ({ texts }) => ({ body: { embeddings: texts.map(() => [9,9,9]) } }) };
  const mgr = new RAGDocumentManager(fakeCohere, { logger: { warn: (...a)=>console.log('WARN',...a), info: (...a)=>console.log('INFO',...a) } });
  mgr.persistEmbeddings = true;
  mgr.persistEmbeddingsDir = OUT_DIR;
  mgr.persistEmbSegmentSizeMB = 0.0001;
  mgr.maxEmbeddingBatch = 1;
  for (let i=0;i<5;i++) mgr.enqueueEmbedding(`rk${i}`, `rt${i}`);
  await new Promise(r=>{ const check=()=>{ if(!mgr.embeddingWorkerRunning && mgr.embeddingQueue.length===0) return r(); setTimeout(check,20); }; check(); });
  console.log('DIR LIST:'); if (fsSync.existsSync(OUT_DIR)) { for (const f of fsSync.readdirSync(OUT_DIR)) console.log('  ', JSON.stringify(f)); }
  const manifestPath = path.join(OUT_DIR,'segments.json');
  console.log('MANIFEST EXISTS', fsSync.existsSync(manifestPath));
  if (fsSync.existsSync(manifestPath)) console.log('MANIFEST', fsSync.readFileSync(manifestPath,'utf8'));
  // create mgr2
  const mgr2 = new RAGDocumentManager({ embed: async ()=>{} }, { logger: { warn: (...a)=>console.log('WARN2',...a), info: (...a)=>console.log('INFO2',...a) } });
  mgr2.persistEmbeddings = true; mgr2.persistEmbeddingsDir = OUT_DIR;
  await mgr2._loadEmbeddings();
  console.log('LOADED KEYS:', Array.from(mgr2.embeddingCache.map?.keys?.() || []));
})();
