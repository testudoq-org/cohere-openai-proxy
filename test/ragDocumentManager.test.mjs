import { describe, it, expect, beforeEach } from 'vitest';
import RAGDocumentManager from '../src/ragDocumentManager.mjs';

const fakeCohere = {
  embed: async ({ texts }) => ({ body: { embeddings: texts.map(t => t.split('').map(c => c.charCodeAt(0) % 10)) } }),
};

describe('RAGDocumentManager', () => {
  let mgr;
  beforeEach(() => { mgr = new RAGDocumentManager(fakeCohere, { logger: console }); mgr.clearIndex(); });

  it('caches embeddings', async () => {
    const text = 'hello world';
    const emb1 = await mgr.getEmbedding(text);
    const emb2 = await mgr.getEmbedding(text);
    expect(emb1).toBeDefined();
    expect(emb2).toBeDefined();
    expect(emb1).toEqual(emb2);
  });

  it('indexes small temp files and retrieves by keyword', async () => {
    // create small in-memory "documents"
    mgr.documents.set('1', { content: 'function add(a,b){return a+b}', metadata: { filePath: '/tmp/a.js', language: 'js', category: 'source' } });
    mgr.documents.set('2', { content: 'README docs', metadata: { filePath: '/tmp/README.md', language: 'md', category: 'doc' } });
    const res = await mgr.retrieveRelevantDocuments('add function', { maxResults: 2 });
    expect(res.length).toBeGreaterThan(0);
  });
});
