import fs from 'fs/promises';
import fsSync from 'fs';
import readline from 'readline';
import os from 'os';
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
  // Embedding batching/queue config (tunable via env)
  this.embeddingModel = process.env.COHERE_EMBEDDING_MODEL || 'small';
  this.maxEmbeddingBatch = Number(process.env.MAX_EMBEDDING_BATCH) || 24;
  this.embeddingQueue = []; // items: { key, text }
  this.embeddingWorkerRunning = false;
  this.embeddingWorkerDelayMs = Number(process.env.EMBEDDING_WORKER_DELAY_MS) || 100;
    // Metrics
    this.metrics = {
      embeddingQueueLength: 0,
      embeddingFailures: 0,
      embeddingBatchesProcessed: 0,
      embeddingRequests: 0,
    };
  // Persistence for index
  this.persistPath = process.env.RAG_PERSIST_PATH || path.join(process.cwd(), '.rag_index.json');
  // Embedding persistence (ndjson) to avoid large JSON memory spikes
  this.persistEmbeddings = process.env.RAG_PERSIST_EMBEDDINGS === '1' || process.env.RAG_PERSIST_EMBEDDINGS === 'true';
  this.persistEmbeddingsPath = process.env.RAG_EMBEDDINGS_PATH || path.join(process.cwd(), '.rag_embeddings.ndjson');
  // load persisted index and embeddings asynchronously
  this._loadIndex().catch((e) => this.logger.info({ e }, 'No persisted RAG index loaded'));
  if (this.persistEmbeddings) this._loadEmbeddings().catch((e) => this.logger.info({ e }, 'No persisted RAG embeddings loaded'));
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
          // enqueue chunk for batched embedding; don't await here
          this.enqueueEmbedding(id, c);
        }
      } catch (err) {
        this.logger.warn({ err, file: fp }, 'Skipping file');
      }
    }
  // persist index after indexing job completes
  try { await this._saveIndex(); } catch (e) { this.logger.warn({ e }, 'Failed to save index after _doIndex'); }
  return { indexed: files.length };
  }

  // Enqueue a single text to be embedded by the background worker
  enqueueEmbedding(key, text) {
    try {
  this.embeddingQueue.push({ key, text });
  this.metrics.embeddingQueueLength = this.embeddingQueue.length;
      if (!this.embeddingWorkerRunning) {
        // start worker but don't await - it will run asynchronously
        this._processEmbeddingQueue().catch((e) => this.logger.warn({ e }, 'Embedding worker crashed'));
      }
    } catch (e) {
      this.logger.warn({ e }, 'Failed to enqueue embedding');
    }
  }

  async _processEmbeddingQueue() {
    if (this.embeddingWorkerRunning) return;
    this.embeddingWorkerRunning = true;
    while (this.embeddingQueue.length > 0) {
      const batch = this.embeddingQueue.splice(0, this.maxEmbeddingBatch);
      this.metrics.embeddingQueueLength = this.embeddingQueue.length;
      const texts = batch.map(b => b.text);
      try {
        this.metrics.embeddingRequests += 1;
        const resp = await this._callEmbedApi(texts);
        const embeddings = resp?.body?.embeddings ?? resp?.embeddings ?? resp;
        if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
          this.logger.warn({ received: Array.isArray(embeddings) ? embeddings.length : typeof embeddings }, 'Unexpected embedding response shape');
          this.metrics.embeddingFailures += 1;
        } else {
          for (let i = 0; i < batch.length; i++) {
            this.embeddingCache.set(batch[i].key, embeddings[i]);
            // persist embedding line
            if (this.persistEmbeddings) {
              try {
                const line = JSON.stringify({ key: batch[i].key, embedding: embeddings[i] }) + os.EOL;
                await fs.appendFile(this.persistEmbeddingsPath, line, 'utf8');
              } catch (e) {
                this.logger.warn({ e }, 'Failed to persist embedding line');
              }
            }
          }
          this.metrics.embeddingBatchesProcessed += 1;
          // persist index periodically to capture newly embedded docs
          try { await this._saveIndex(); } catch (e) { this.logger.warn({ e }, 'Failed to save index after embedding batch'); }
        }
      } catch (err) {
        this.logger.warn({ err }, 'Batch embedding failed — requeueing items with delay');
        this.metrics.embeddingFailures += 1;
        // simple requeue with delay to avoid tight failure loops
        this.embeddingQueue.unshift(...batch);
        await new Promise(r => setTimeout(r, 1000));
      }
      // polite throttle between batches
      await new Promise(r => setTimeout(r, this.embeddingWorkerDelayMs));
    }
    this.embeddingWorkerRunning = false;
  }

  // Centralized call to Cohere embed API with simple retries and robust response parsing
  async _callEmbedApi(texts, attempts = 3) {
    let lastErr;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const payload = { model: this.embeddingModel, texts };
        const resp = await this.cohere.embed(payload);
        const embeddings = resp?.body?.embeddings ?? resp?.embeddings ?? resp;
        if (!embeddings) throw new Error('No embeddings in response');
        return { body: { embeddings } };
      } catch (err) {
        lastErr = err;
        const backoff = 100 * Math.pow(2, attempt - 1);
        this.logger.warn({ err, attempt }, 'Embedding API call failed; retrying after backoff');
        await new Promise(r => setTimeout(r, backoff));
      }
    }
    throw lastErr;
  }

  async _saveIndex() {
    try {
      const snapshot = {
        documents: Array.from(this.documents.entries()),
        documentIndex: Array.from(this.documentIndex.entries()).map(([k, s]) => [k, Array.from(s)]),
      };
      await fs.writeFile(this.persistPath, JSON.stringify(snapshot), 'utf8');
    } catch (e) {
      this.logger.warn({ e }, 'Failed to persist RAG index');
    }
  }

  async _loadIndex() {
    try {
      const raw = await fs.readFile(this.persistPath, 'utf8');
      const snap = JSON.parse(raw);
      if (snap?.documents) this.documents = new Map(snap.documents);
      if (snap?.documentIndex) this.documentIndex = new Map(snap.documentIndex.map(([k, arr]) => [k, new Set(arr)]));
    } catch (e) {
      // no persisted index is acceptable
    }
  }

  async _loadEmbeddings() {
    if (!fsSync.existsSync(this.persistEmbeddingsPath)) return;
    const rl = readline.createInterface({ input: fsSync.createReadStream(this.persistEmbeddingsPath), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line || !line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (item?.key && item?.embedding) this.embeddingCache.set(item.key, item.embedding);
      } catch (e) { /* ignore malformed lines */ }
    }
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
    // Backwards compatible single-call helper: will try immediate call on cache miss
    const key = crypto.createHash('md5').update(text).digest('hex');
    const cached = this.embeddingCache.get(key);
    if (cached) return cached;
    try {
      const resp = await this._callEmbedApi([text]);
      const emb = resp.body?.embeddings?.[0] ?? null;
      if (emb) this.embeddingCache.set(key, emb);
      return emb;
    } catch (err) {
      this.logger.warn({ err }, 'Embedding API failed (single call fallback)');
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
    return {
      docs: this.documents.size,
      embeddingCache: this.embeddingCache.map?.size ?? undefined,
      metrics: this.metrics,
      persistEmbeddings: this.persistEmbeddings || false,
    };
  }

  clearIndex() { this.documents.clear(); this.documentIndex.clear(); this.embeddingCache.clear(); }

  async shutdown() { 
    try { await this._saveIndex(); } catch (e) { this.logger.warn({ e }, 'Failed to save index on shutdown'); }
  }
}

export default RAGDocumentManager;
