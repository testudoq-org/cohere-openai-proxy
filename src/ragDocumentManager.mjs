import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import LruTtlCache from './utils/lruTtlCache.mjs';

class RAGDocumentManager {
  constructor(cohereClient, { logger = console } = {}) {
    this.cohere = cohereClient;
    this.documents = new Map();
    this.embeddingCache = new LruTtlCache({ ttlMs: 60 * 60 * 1000, maxSize: 5000 });
    this.documentIndex = new Map();
    this.logger = logger;
    this.supportedExtensions = new Set(['.js', '.ts', '.py', '.java', '.md', '.json', '.yaml', '.yml', '.html', '.css', '.sql', '.sh']);
    this.indexingQueue = [];
    this.indexing = false;
  }

  async indexCodebase(projectPath, options = {}) {
    if (!projectPath) throw new Error('projectPath required');
    const absPath = path.resolve(projectPath);
    // enqueue job and return job id
    const jobId = crypto.randomBytes(8).toString('hex');
    this.indexingQueue.push({ jobId, absPath, options });
    this._processQueue();
    return { jobId, status: 'queued' };
  }

  async _processQueue() {
    if (this.indexing) return;
    this.indexing = true;
    while (this.indexingQueue.length > 0) {
      const job = this.indexingQueue.shift();
      try {
        await this._doIndex(job.absPath, job.options);
        this.logger.info({ jobId: job.jobId }, 'Index job completed');
      } catch (err) {
        this.logger.error({ err, jobId: job.jobId }, 'Index job failed');
      }
    }
    this.indexing = false;
  }

  async _doIndex(absPath, options = {}) {
    const files = await this._scanDirectory(absPath, options.excludeDirs || ['node_modules', '.git', 'dist', 'build']);
    for (const fp of files) {
      try {
        const stat = await fs.stat(fp);
        if (!stat.isFile()) continue;
        if (stat.size > (options.maxFileSize || 500 * 1024)) continue;
        const ext = path.extname(fp).toLowerCase();
        if (!this.supportedExtensions.has(ext)) continue;
        const content = await fs.readFile(fp, 'utf8');
        const chunks = this._splitIntoChunks(content, 1200);
        for (const c of chunks) {
          const id = crypto.createHash('md5').update(fp + c).digest('hex');
          const metadata = { filePath: fp, language: ext.replace('.', ''), category: this._categorizeFile(fp) };
          this.documents.set(id, { content: c, metadata });
          this._indexByCategory(metadata.category, id);
          // async get embedding but don't await for each chunk to avoid blocking
          this.getEmbedding(c).catch((e) => this.logger.warn({ e }, 'Embedding failed (async)'));
        }
      } catch (err) {
        this.logger.warn({ err, file: fp }, 'Skipping file');
      }
    }
    return { indexed: files.length };
  }

  async retrieveRelevantDocuments(query, options = {}) {
    // Try semantic search first using embedding similarity
    if (!query) return [];
    const useSemantic = options.useSemanticSearch !== false;
    let results = [];
    if (useSemantic && this.documents.size > 0) {
      try {
        results = await this.semanticSearch(query, { maxResults: options.maxResults || 5, minSimilarity: options.minSimilarity || 0.3 });
      } catch (err) {
        this.logger.warn({ err }, 'Semantic search failed, falling back to keyword');
      }
    }
    if (results.length === 0) {
      results = this._keywordSearch(query, options);
    }
    return results.slice(0, options.maxResults || 5);
  }

  async semanticSearch(query, { maxResults = 10, minSimilarity = 0.3 } = {}) {
    const queryEmbedding = await this.getEmbedding(query);
    if (!queryEmbedding) throw new Error('Failed to get query embedding');
    const scores = [];
    for (const [id, doc] of this.documents) {
      const cached = this.embeddingCache.get(id);
      if (!cached) continue;
      const score = this._cosineSimilarity(queryEmbedding, cached);
      if (score >= minSimilarity) scores.push({ id, score, document: doc });
    }
    return scores.sort((a, b) => b.score - a.score).slice(0, maxResults).map(s => ({ document: s.document, score: s.score, matchType: 'semantic' }));
  }

  _keywordSearch(query, options = {}) {
    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    const results = [];
    for (const [id, doc] of this.documents) {
      let score = 0;
      const text = (doc.content + ' ' + JSON.stringify(doc.metadata)).toLowerCase();
      for (const t of terms) if (text.includes(t)) score += 1;
      if (score > 0) results.push({ document: doc, score, matchType: 'keyword' });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, options.maxResults || 10);
  }

  async getEmbedding(text) {
    const key = crypto.createHash('md5').update(text).digest('hex');
    const cached = this.embeddingCache.get(key);
    if (cached) return cached;
    try {
      // call cohere embeddings - use batching/resilience at caller level
      const resp = await this.cohere.embed({ model: 'small', texts: [text] });
      const emb = resp.body?.embeddings?.[0] || resp[0] || null;
      if (emb) this.embeddingCache.set(key, emb);
      return emb;
    } catch (err) {
      this.logger.warn({ err }, 'Embedding API failed');
      return null;
    }
  }

  _scanDirectory(dir, excludeDirs = []) {
    const results = [];
    const walk = async (d) => {
      let items;
      try { items = await fs.readdir(d); } catch (e) { return; }
      for (const it of items) {
        const full = path.join(d, it);
        if (excludeDirs.includes(it)) continue;
        let st;
        try { st = await fs.stat(full); } catch (e) { continue; }
        if (st.isDirectory()) await walk(full);
        else results.push(full);
      }
    };
    return (async () => { await walk(dir); return results; })();
  }

  _splitIntoChunks(text, size = 1000) {
    if (!text) return [];
    const out = [];
    for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
    return out;
  }

  _categorizeFile(filePath) {
    const f = filePath.toLowerCase();
    if (f.includes('test') || f.includes('__tests__')) return 'test';
    if (f.includes('readme') || f.includes('doc')) return 'doc';
    return 'source';
  }

  _indexByCategory(cat, id) { if (!this.documentIndex.has(cat)) this.documentIndex.set(cat, new Set()); this.documentIndex.get(cat).add(id); }

  _cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
  }

  getStats() {
    return { docs: this.documents.size, embeddingCache: this.embeddingCache.map?.size ?? undefined };
  }

  clearIndex() { this.documents.clear(); this.documentIndex.clear(); this.embeddingCache.clear(); }

  async shutdown() { /* nothing heavy for now */ }
}

export default RAGDocumentManager;
