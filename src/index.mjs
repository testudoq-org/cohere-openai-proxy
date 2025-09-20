import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import cors from 'cors';
import { CohereClient } from 'cohere-ai';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import morgan from 'morgan';
import { encode } from 'gpt-3-encoder';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

import Pino from 'pino';
import promClient from 'prom-client';
import { createStartupWatchdog } from './utils/startupWatchdog.mjs';
import { httpAgent, httpsAgent, applyGlobalAgents, EXTERNAL_API_TIMEOUT_MS } from './utils/httpAgent.mjs';
import { createCohereClient } from './utils/cohereClientFactory.mjs';

import LruTtlCache from './utils/lruTtlCache.mjs';
import RAGDocumentManager from './ragDocumentManager.mjs';
import ConversationManager from './conversationManager.mjs';
import diagnostics from './middleware/diagnostics.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = Pino({ level: process.env.LOG_LEVEL || 'info' });

const { client: _defaultCohereClient, acceptedAgentOption: _defaultCohereAcceptedAgentOption } = await createCohereClient({ token: process.env.COHERE_API_KEY, agentOptions: httpsAgent, logger });

const DIAGNOSTICS_DISABLED = !!(process.env.SKIP_DIAGNOSTICS && ['1', 'true', 'yes'].includes(String(process.env.SKIP_DIAGNOSTICS).toLowerCase()));
function nowMs() { return Number(process.hrtime.bigint() / 1000000n); }
function generateTraceId() { return Date.now().toString(36) + Math.random().toString(36).slice(2,10); }
function diagLog(obj) { if (DIAGNOSTICS_DISABLED) return; try { console.log(JSON.stringify(obj)); } catch (e) {} }

// Best-effort: apply global agents to improve connection reuse
// Prefer explicit SDK agent injection; only set global agents when explicitly enabled.
if (process.env.OUTBOUND_USE_GLOBAL_AGENT === '1' || String(process.env.OUTBOUND_USE_GLOBAL_AGENT || '').toLowerCase() === 'true') {
  applyGlobalAgents();
}

class EnhancedCohereRAGServer {
  constructor({ port = process.env.PORT || 3000 } = {}) {
    this.app = express();
    this.port = port;
    // Instantiate Cohere client using centralized factory (created at module import).
    this.cohere = _defaultCohereClient;
    this.cohereAcceptedAgentOption = _defaultCohereAcceptedAgentOption;

    this.ragManager = new RAGDocumentManager(this.cohere, { logger });
    this.conversationManager = new ConversationManager(this.ragManager, { logger });

    this.supportedModels = new Set();

    this.MAX_TOTAL_TOKENS = Number(process.env.MAX_TOTAL_TOKENS) || 4000;
    this.MIN_COMPLETION_TOKENS = Number(process.env.MIN_COMPLETION_TOKENS) || 50;
    this.MAX_COMPLETION_TOKENS = Number(process.env.MAX_COMPLETION_TOKENS) || 2048;
    this.TOKEN_SAFETY_BUFFER = Number(process.env.TOKEN_SAFETY_BUFFER) || 100;

    this.RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;
    this.RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 100;

    this.promptCache = new LruTtlCache({ ttlMs: 5 * 60 * 1000, maxSize: 500 });

    this.setupMiddleware();
    this.setupRoutes();
    this.setupErrorHandling();

    this.metrics = {
      httpRequests: new promClient.Counter({ name: 'http_requests_total', help: 'Total HTTP requests' }),
    };
    // Prometheus gauges for RAG embedding metrics
    this.promMetrics = {
      embeddingQueueLength: new promClient.Gauge({ name: 'rag_embedding_queue_length', help: 'Embedding queue length' }),
      embeddingFailures: new promClient.Gauge({ name: 'rag_embedding_failures', help: 'Embedding failures count' }),
      embeddingBatchesProcessed: new promClient.Gauge({ name: 'rag_embedding_batches_processed', help: 'Embedding batches processed' }),
      embeddingRequests: new promClient.Gauge({ name: 'rag_embedding_requests', help: 'Embedding requests made' }),
    };
  }

  async initializeSupportedModels() {
    // Prefer env var, fallback to recommended default
    const COHERE_MODEL = process.env.COHERE_MODEL || 'command-a-03-2025';

    // Curated list of recommended models
    const recommendedModels = [
      COHERE_MODEL,
      'command-a-03-2025',
      'command-a-reasoning-08-2025',
      'command-a-vision-07-2025',
      'command-r7b-12-2024'
    ];

    // Legacy/deprecated aliases (kept for backwards compatibility only)
    // These are not advertised as primary supported options.
    const legacyAliases = [
      'command-a-03-2025',
      'command-r',
      'command',
      'command-light'
    ]; // legacy/deprecated aliases for backwards compatibility

    try {
      // Delegate to the wrapped cohere client — the client factory applies retry + circuit behavior.
      const response = await this.cohere.models.list();
      const models = response?.models ?? response?.body?.models ?? [];
      // Filter out deprecated aliases from primary supported models
      let supported = models.map((m) => m.name).filter((name) => !legacyAliases.includes(name));
      // Ensure recommended models are present
      for (const m of recommendedModels) {
        if (!supported.includes(m)) supported.push(m);
      }
      this.supportedModels = new Set(supported);
      // Optionally: expose legacyAliases for internal use if needed
      this.legacyAliases = legacyAliases;
      logger.info({
        supportedModels: Array.from(this.supportedModels),
        legacyAliases: this.legacyAliases
      }, 'Supported Cohere models (curated)');
    } catch (err) {
      logger.warn({ err: err?.message }, 'Failed to list models, using defaults');
      this.supportedModels = new Set(recommendedModels);
      this.legacyAliases = legacyAliases;
    }
  }

  setupMiddleware() {
    this.app.use(helmet());
  this.app.use((req, res, next) => { req.log = logger; next(); });
  // lightweight diagnostics middleware (attach traceId and timing)
  this.app.use(diagnostics);
  this.app.use(morgan('combined'));

    const limiter = rateLimit({ windowMs: this.RATE_LIMIT_WINDOW_MS, max: this.RATE_LIMIT_MAX_REQUESTS });
    this.app.use(limiter);

    this.app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') || '*' }));
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));
  }

  setupRoutes() {
    this.app.get('/health', (req, res) => {
      const conversationStats = this.conversationManager.getStats();
      const ragStats = this.ragManager.getStats();
      res.json({ status: 'healthy', uptime: process.uptime(), conversation_stats: conversationStats, rag_stats: ragStats });
    });

    // Prometheus metrics endpoint - update gauges from ragManager and return registry
    this.app.get('/metrics', async (req, res) => {
      try {
        const ragStats = this.ragManager.getStats();
        const m = ragStats?.metrics || {};
        this.promMetrics.embeddingQueueLength.set(Number(m.embeddingQueueLength || 0));
        this.promMetrics.embeddingFailures.set(Number(m.embeddingFailures || 0));
        this.promMetrics.embeddingBatchesProcessed.set(Number(m.embeddingBatchesProcessed || 0));
        this.promMetrics.embeddingRequests.set(Number(m.embeddingRequests || 0));

        res.setHeader('Content-Type', promClient.register.contentType);
        res.send(await promClient.register.metrics());
      } catch (err) {
        logger.error({ err }, 'Failed to scrape metrics');
        res.status(500).send('error');
      }
    });

    this.app.post('/v1/chat/completions', this.handleChatCompletion.bind(this));
    this.setupRAGRoutes();
    this.setupConversationRoutes();

    this.app.use((req, res) => res.status(404).json({ error: { message: `Route ${req.method} ${req.path} not found`, type: 'not_found' } }));
  }

  setupRAGRoutes() {
    this.app.post('/v1/rag/index', async (req, res) => {
      const { projectPath, options } = req.body;
      try {
        const result = await this.ragManager.indexCodebase(projectPath, options);
        res.json({ success: true, result });
      } catch (err) {
        logger.error({ err }, 'Indexing failed');
        res.status(500).json({ error: { message: 'Failed to index codebase', type: 'internal_server_error' } });
      }
    });

    this.app.delete('/v1/rag/index', (req, res) => {
      this.ragManager.clearIndex();
      res.json({ success: true, message: 'RAG index cleared' });
    });

    this.app.get('/v1/rag/stats', (req, res) => res.json({ success: true, stats: this.ragManager.getStats() }));
  }

  setupConversationRoutes() {
    this.app.post('/v1/conversations/:sessionId/feedback', (req, res) => {
      const { sessionId } = req.params;
      const { feedback, type = 'correction' } = req.body;
      if (!feedback) return res.status(400).json({ error: { message: 'Feedback is required', type: 'invalid_request_error' } });
      const message = this.conversationManager.addFeedback(sessionId, feedback, type);
      res.json({ success: true, message });
    });

    this.app.get('/v1/conversations/:sessionId/history', (req, res) => {
      const { sessionId } = req.params;
      const messages = this.conversationManager.getConversation(sessionId);
      res.json({ sessionId, messages, count: messages.length });
    });

    this.app.delete('/v1/conversations/:sessionId', (req, res) => {
      const { sessionId } = req.params;
      this.conversationManager.clearConversation(sessionId);
      res.json({ success: true, message: 'Conversation cleared' });
    });
  }

  async handleChatCompletion(req, res) {
    const startTime = nowMs();
    const traceId = req.headers['x-trace-id'] || generateTraceId();
    try {
      const { messages, temperature = 0.7, max_tokens, model = process.env.COHERE_MODEL || 'command-a-03-2025', sessionId } = req.body;
      if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: { message: 'Messages array required', type: 'invalid_request_error' } });
      if (!DIAGNOSTICS_DISABLED) {
        req._diag = { traceId, t0: startTime };
        diagLog({ traceId, phase: 'server:received', route: req.path, start: startTime });
      }

      const effectiveSessionId = sessionId || this.generateId();
      const tAdd = nowMs();
      for (const m of messages) await this.conversationManager.addMessage(effectiveSessionId, m.role, this.extractContentString(m.content));
      if (!DIAGNOSTICS_DISABLED) diagLog({ traceId, phase: 'server:messages-added', durationMs: nowMs() - tAdd, messageCount: messages.length });

      const convoStart = nowMs();
      const conversationData = this.conversationManager.getFormattedHistoryWithRAG(effectiveSessionId);
      if (!DIAGNOSTICS_DISABLED) diagLog({ traceId, phase: 'server:conversation-built', durationMs: nowMs() - convoStart, ragCount: (this.conversationManager.conversations.get(effectiveSessionId)?.ragContext || []).length });

      const response = await this.callCohereChatAPI(model, conversationData, temperature, max_tokens, traceId);
      if (!response) return res.status(500).json({ error: { message: 'Failed to receive response from Cohere API', type: 'internal_server_error' } });

      const assistantResponse = response.text || '';
      this.conversationManager.addMessage(effectiveSessionId, 'assistant', assistantResponse);

      const completionResponse = this.formatChatResponse(response, model, conversationData, startTime, effectiveSessionId);
      res.json(completionResponse);
    } catch (err) {
      logger.error({ err }, 'Chat completion failed');
      res.status(500).json({ error: { message: 'Internal server error', type: 'internal_server_error' } });
    }
  }

  extractContentString(content) {
    if (typeof content === 'string') return content;
    if (content && typeof content === 'object') {
      if (content.text) return content.text;
      if (Array.isArray(content)) return content.filter(p => p && typeof p === 'object' && p.text).map(p => p.text).join(' ');
      try { return JSON.stringify(content); } catch (e) { return String(content); }
    }
    return String(content || '');
  }

  async callCohereChatAPI(model, conversationData, temperature, maxTokens) {
    const payload = { model, message: conversationData.message, temperature: temperature || 0.7, max_tokens: maxTokens || 512 };
    if (conversationData.chatHistory && conversationData.chatHistory.length > 0) payload.chat_history = conversationData.chatHistory;
    if (conversationData.preamble) payload.preamble = conversationData.preamble;
  
    try {
      const sent = nowMs();
      if (!DIAGNOSTICS_DISABLED) diagLog({ phase: 'cohere:call:start', model, payloadSizeChars: String(JSON.stringify(payload).length), start: sent });
  
      // If Cohere client accepts agent, try to use it (best-effort). Otherwise rely on globalAgent.
      let callFn = () => this.cohere.chat(payload);
      if (this.cohere && typeof this.cohere.chat === 'function') {
        // prefer existing SDK behavior; many SDKs accept an options object but not all — keep best-effort
        callFn = () => this.cohere.chat(payload);
      }
  
      const resp = await callFn();
      if (!DIAGNOSTICS_DISABLED) diagLog({ phase: 'cohere:call:end', model, durationMs: nowMs() - sent });
      return resp;
    } catch (err) {
      if (!DIAGNOSTICS_DISABLED) diagLog({ phase: 'cohere:error', model, err: String(err?.message) });
      logger.error({ err }, 'Cohere chat error');
      return null;
    }
  }

  formatChatResponse(response, model, conversationData, startTime, sessionId) {
    const generatedText = response.text || '';
    const processingTime = Date.now() - startTime;
    const promptTokens = this.estimateTokens(conversationData.message) + (conversationData.chatHistory?.length * 10 || 0);
    const completionTokens = this.estimateTokens(generatedText);
    return {
      id: `chatcmpl-${this.generateId()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: `cohere/${model}`,
      choices: [{ index: 0, message: { role: 'assistant', content: generatedText }, finish_reason: 'stop' }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
      system_fingerprint: `cohere_chat_${model}_${Date.now()}`,
      processing_time_ms: processingTime,
      session_id: sessionId,
      conversation_stats: this.conversationManager.getStats(),
    };
  }

  estimateTokens(text) { return encode(this.extractContentString(text)).length; }
  generateId() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }

  setupErrorHandling() {
    this.app.use((err, req, res, next) => {
      logger.error({ err }, 'Unhandled error');
      res.status(500).json({ error: { message: 'Internal server error', type: 'internal_server_error' } });
    });
  }

  async start() {
    // Let createStartupWatchdog use its internal default (which prefers env override).
    const watchdog = createStartupWatchdog();
    watchdog.start();
    try {
      await this.initializeSupportedModels();
      console.log('start(): about to call app.listen on port', this.port);
      this.server = this.app.listen(this.port, () => {
        console.log('start(): app.listen callback fired');
        logger.info({ port: this.port }, 'Server started');
        watchdog.clear();
      });
      return this.server;
    } catch (err) {
      watchdog.clear();
      throw err;
    }
  }

  async stop() {
    if (this.server) await new Promise((r) => this.server.close(r));
    await this.ragManager.shutdown?.();
    await this.conversationManager.shutdown?.();
  }
}

export default EnhancedCohereRAGServer;

// Robust entry-point detection: compare resolved paths so this works on Windows (backslashes)
const _entryPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(_entryPath)) {
  const server = new EnhancedCohereRAGServer();
  server.start().catch((err) => {
    logger.error({ err }, 'Failed to start server');
    process.exit(1);
  });
}
