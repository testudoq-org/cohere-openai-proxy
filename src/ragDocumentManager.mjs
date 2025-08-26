import fs from 'fs/promises';
import fsSync from 'fs';
import readline from 'readline';
import os from 'os';
import zlib from 'zlib';
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
  this._diagDisabled = !!(process.env.SKIP_DIAGNOSTICS && ['1', 'true', 'yes'].includes(String(process.env.SKIP_DIAGNOSTICS).toLowerCase()));
  // Persistence for index
  this.persistPath = process.env.RAG_PERSIST_PATH || path.join(process.cwd(), '.rag_index.json');
  // Embedding persistence (segmented ndjson) to avoid large JSON memory spikes
  this.persistEmbeddings = process.env.RAG_PERSIST_EMBEDDINGS === '1' || process.env.RAG_PERSIST_EMBEDDINGS === 'true';
  this.persistEmbeddingsDir = process.env.RAG_EMBEDDINGS_DIR || path.join(process.cwd(), '.rag_embeddings');
  this.persistEmbSegmentSizeMB = Number(process.env.RAG_EMB_SEGMENT_SIZE_MB) || 5; // MB
  this.persistEmbSegmentAgeMs = Number(process.env.RAG_EMB_SEGMENT_AGE_MS) || 24 * 60 * 60 * 1000; // 24h
  this._currentSegment = null; // { path, createdAt, size }
  this._segmentsManifestPath = path.join(this.persistEmbeddingsDir, 'segments.json');
  // retention/compaction
  this.persistEmbRetentionCount = Number(process.env.RAG_EMB_RETENTION_COUNT) || 10; // keep up to N segments
  this._manifestLockPath = path.join(this.persistEmbeddingsDir, 'segments.lock');
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
        if (!this._diagDisabled) this.logger.info({ batchSize: batch.length, lengths: texts.map(t => (t||'').length) }, 'embedding:batch:start');
        const batchStart = Date.now();
        const resp = await this._callEmbedApi(texts);
        const embeddings = resp?.body?.embeddings ?? resp?.embeddings ?? resp;
        if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
          this.logger.warn({ received: Array.isArray(embeddings) ? embeddings.length : typeof embeddings }, 'Unexpected embedding response shape');
          this.metrics.embeddingFailures += 1;
        } else {
          for (let i = 0; i < batch.length; i++) {
            this.embeddingCache.set(batch[i].key, embeddings[i]);
            // persist embedding line using segmented files
            if (this.persistEmbeddings) {
              try {
                await this._appendToSegment(JSON.stringify({ key: batch[i].key, embedding: embeddings[i] }) + os.EOL);
              } catch (e) {
                this.logger.warn({ e }, 'Failed to persist embedding line');
              }
            }
          }
          this.metrics.embeddingBatchesProcessed += 1;
          // persist index periodically to capture newly embedded docs
          try { await this._saveIndex(); } catch (e) { this.logger.warn({ e }, 'Failed to save index after embedding batch'); }
          if (!this._diagDisabled) this.logger.info({ batchSize: batch.length, durationMs: Date.now() - batchStart }, 'embedding:batch:done');
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
    const start = Date.now();
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const payload = { model: this.embeddingModel, texts };
        if (!this._diagDisabled) this.logger.info({ attempt, batchSize: texts.length, payloadSizeChars: String(JSON.stringify(payload).length) }, 'embedding:api:call');
        const resp = await this.cohere.embed(payload);
        const embeddings = resp?.body?.embeddings ?? resp?.embeddings ?? resp;
        if (!embeddings) throw new Error('No embeddings in response');
        if (!this._diagDisabled) this.logger.info({ attempt, batchSize: texts.length, durationMs: Date.now() - start }, 'embedding:api:success');
        return { body: { embeddings } };
      } catch (err) {
        lastErr = err;
        const backoff = 100 * Math.pow(2, attempt - 1);
        this.logger.warn({ err, attempt, batchSize: texts.length }, 'Embedding API call failed; retrying after backoff');
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
    // read all segment files (plain .ndjson or .ndjson.gz)
    await this._ensureEmbeddingsDir();
    // prefer reading manifest if present to get deterministic order
    let files = [];
    try {
      const raw = await fs.readFile(this._segmentsManifestPath, 'utf8');
      const manifest = JSON.parse(raw);
      const manifestFiles = (manifest.segments || []).map(s => (path.basename(s.file || '')).trim()).filter(Boolean);
      // also include any remaining .ndjson files that haven't been rotated yet
      const dirFiles = (await fs.readdir(this.persistEmbeddingsDir)).filter(f => !f.endsWith('.tmp') && f !== path.basename(this._segmentsManifestPath));
      const extras = dirFiles.filter(f => f.endsWith('.ndjson') && !manifestFiles.includes(f));
      files = Array.from(new Set([...manifestFiles, ...extras]));
      // if manifest exists but has no entries, fallback to directory listing
      if (!files || files.length === 0) {
        files = dirFiles;
        files.sort();
      }
    } catch (e) {
      // fallback: read directory (ignore tmp files and manifest)
      files = (await fs.readdir(this.persistEmbeddingsDir)).filter(f => !f.endsWith('.tmp') && f !== path.basename(this._segmentsManifestPath));
      files.sort();
    }
    for (const f of files) {
      const safeName = String(f || '').trim();
      if (!safeName) continue;
      const full = path.join(this.persistEmbeddingsDir, safeName);
      // skip files that no longer exist (race with rotation)
      if (!fsSync.existsSync(full)) continue;
      try {
        if (safeName.endsWith('.gz')) {
          const stream = fsSync.createReadStream(full).pipe(zlib.createGunzip());
          const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
          for await (const line of rl) {
            if (!line || !line.trim()) continue;
            try {
              const item = JSON.parse(line);
              if (item?.key && item?.embedding) this.embeddingCache.set(item.key, item.embedding);
            } catch (e) { /* ignore malformed lines */ }
          }
        } else if (safeName.endsWith('.ndjson')) {
          const rl = readline.createInterface({ input: fsSync.createReadStream(full), crlfDelay: Infinity });
          for await (const line of rl) {
            if (!line || !line.trim()) continue;
            try {
              const item = JSON.parse(line);
              if (item?.key && item?.embedding) this.embeddingCache.set(item.key, item.embedding);
            } catch (e) { /* ignore malformed lines */ }
          }
        }
      } catch (err) {
        // ignore file read errors (race with rotation or partial writes)
        this.logger.warn({ err, file: full }, 'Skipping segment due to read error');
        continue;
      }
    }
  }

  async _ensureEmbeddingsDir() {
    try {
      await fs.mkdir(this.persistEmbeddingsDir, { recursive: true });
      // recompute manifest path in case persistEmbeddingsDir was changed after construction
      this._segmentsManifestPath = path.join(this.persistEmbeddingsDir, 'segments.json');
    } catch (e) { }
  }

  async _openNewSegment() {
    await this._ensureEmbeddingsDir();
    const name = `segment-${Date.now()}.ndjson`;
    const full = path.join(this.persistEmbeddingsDir, name);
    this._currentSegment = { path: full, createdAt: Date.now(), size: 0 };
    // ensure file exists
    await fs.writeFile(full, '', 'utf8');
    // ensure manifest exists
    try {
      if (!fsSync.existsSync(this._segmentsManifestPath)) {
        await fs.writeFile(this._segmentsManifestPath, JSON.stringify({ segments: [] }), 'utf8');
      }
    } catch (e) { /* ignore */ }
    return this._currentSegment;
  }

  async _appendToSegment(line) {
    if (!this._currentSegment) await this._openNewSegment();
    await fs.appendFile(this._currentSegment.path, line, 'utf8');
    this._currentSegment.size += Buffer.byteLength(line, 'utf8');
    const sizeMB = this._currentSegment.size / (1024 * 1024);
    const age = Date.now() - this._currentSegment.createdAt;
    if (sizeMB >= this.persistEmbSegmentSizeMB || age >= this.persistEmbSegmentAgeMs) {
      // rotate: gzip current and start new
      await this._rotateSegment(this._currentSegment.path);
      this._currentSegment = null;
    }
  }

  async _rotateSegment(filePath) {
    try {
      const gzPath = `${filePath}.gz`;
      // write to a temp gz first, then rename for atomicity
      const tmpGz = `${gzPath}.tmp`;
      await new Promise((resolve, reject) => {
        const rs = fsSync.createReadStream(filePath);
        const ws = fsSync.createWriteStream(tmpGz);
        const gzip = zlib.createGzip();
        rs.pipe(gzip).pipe(ws).on('finish', resolve).on('error', reject);
      });
      // rename temp to final
      await fs.rename(tmpGz, gzPath);
      // remove original
      await fs.unlink(filePath);
      // update manifest atomically
      try {
        const stat = await fs.stat(gzPath);
        const entry = { file: path.basename(gzPath), size: stat.size, createdAt: Date.now() };
        await this._appendToManifest(entry);
      } catch (e) { /* ignore manifest update failure */ }
    } catch (e) {
      this.logger.warn({ e }, 'Failed to rotate embedding segment');
    }
  }

  async _appendToManifest(entry) {
    try {
      await this._ensureEmbeddingsDir();
      // acquire lightweight manifest lock to serialize updates
      await this._acquireManifestLock();
      try {
        let manifest = { segments: [] };
        try {
          const raw = await fs.readFile(this._segmentsManifestPath, 'utf8');
          manifest = JSON.parse(raw);
        } catch (e) { /* no manifest yet or unreadable */ }
        manifest.segments = manifest.segments || [];
        manifest.segments.push(entry);
        // compact/retain only the most recent N entries
        manifest = this._compactManifestIfNeeded(manifest);
        const tmp = `${this._segmentsManifestPath}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(manifest), 'utf8');
        await fs.rename(tmp, this._segmentsManifestPath);
      } finally {
        await this._releaseManifestLock();
      }
    } catch (e) {
      this.logger.warn({ e }, 'Failed to update segments manifest');
    }
  }

  async _acquireManifestLock(retries = 5, delayMs = 50) {
    // simple lockfile with retry — good enough for single-process atomicity and tests
    for (let i = 0; i < retries; i++) {
      try {
        await fs.writeFile(this._manifestLockPath, String(process.pid), { flag: 'wx' });
        return;
      } catch (e) {
        // already locked
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
    // last attempt: try to remove a stale lock if it points to non-existent pid (best-effort)
    try {
      const raw = await fs.readFile(this._manifestLockPath, 'utf8');
      // don't try to kill or check pid on all platforms; just remove stale lock
      await fs.unlink(this._manifestLockPath);
    } catch (e) { /* ignore */ }
    // final attempt
    try { await fs.writeFile(this._manifestLockPath, String(process.pid), { flag: 'wx' }); } catch (e) { /* ignore */ }
  }

  async _releaseManifestLock() {
    try { await fs.unlink(this._manifestLockPath); } catch (e) { /* ignore */ }
  }

  _compactManifestIfNeeded(manifest) {
    try {
      manifest.segments = manifest.segments || [];
      if (manifest.segments.length <= this.persistEmbRetentionCount) return manifest;
      // keep the most recent N segments by createdAt (assume appended in time order)
      const sorted = manifest.segments.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      const kept = sorted.slice(0, this.persistEmbRetentionCount);
      // preserve original order of kept files (oldest first)
      kept.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      manifest.segments = kept;
      return manifest;
    } catch (e) {
      return manifest;
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
