import dotenv from 'dotenv';
dotenv.config();
// Startup debug: verify dotenv/env-file values (COHERE_MODEL) are loaded early for Docker.
console.log(
  '[startup debug]',
  {
    COHERE_MODEL: process.env.COHERE_MODEL,
    COHERE_API_KEY_present: !!process.env.COHERE_API_KEY,
    COHERE_API_KEY_length: process.env.COHERE_API_KEY?.length,
    PORT: process.env.PORT,
    LOG_LEVEL: process.env.LOG_LEVEL,
    EXTERNAL_API_TIMEOUT_MS: process.env.EXTERNAL_API_TIMEOUT_MS,
    cwd: process.cwd(),
    dotenv_path: '(default - no explicit path set)'
  }
);
import express from 'express';
import cors from 'cors';
import { CohereClient } from 'cohere-ai';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import { encode } from 'gpt-3-encoder';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

import Pino from 'pino';
import promClient from 'prom-client';
import { createStartupWatchdog } from './utils/startupWatchdog.mjs';
import { httpAgent, httpsAgent, applyGlobalAgents, EXTERNAL_API_TIMEOUT_MS } from './utils/httpAgent.mjs';
import { createCohereClient, getModelsList, validateModelOrThrow } from './utils/cohereClientFactory.mjs';
import { supportsTools, stripToolsIfUnsupported } from './utils/cohereModelCapabilities.mjs';
import { sanitizePreambleForModel } from './utils/preambleSanitizer.mjs';

import LruTtlCache from './utils/lruTtlCache.mjs';
import RAGDocumentManager from './ragDocumentManager.mjs';
import ConversationManager from './conversationManager.mjs';
import diagnostics from './middleware/diagnostics.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = Pino({ level: process.env.LOG_LEVEL || 'info' });

const { client: _defaultCohereClient, acceptedAgentOption: _defaultCohereAcceptedAgentOption } = await createCohereClient({ token: process.env.COHERE_API_KEY, agentOptions: httpsAgent, logger });
console.log('[startup debug] Cohere client creation result:', {
  clientCreated: !!_defaultCohereClient,
  acceptedAgentOption: _defaultCohereAcceptedAgentOption,
  hasChatMethod: typeof _defaultCohereClient?.chat === 'function'
});

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
    // Current server-wide default model (mutable via /v1/models/switch)
    this.currentModel = process.env.COHERE_MODEL || 'command-r-08-2024';

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

    // Non-blocking attach of rate monitoring data if provided by cohereClientFactory
    (async () => {
      try {
        const mod = await import('./utils/cohereClientFactory.mjs');
        if (mod && mod.recentCalls) this._cohereRecentCalls = mod.recentCalls;
      } catch (e) { /* ignore */ }
    })();

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
    const COHERE_MODEL = process.env.COHERE_MODEL || 'command-r-08-2024';

    // Curated list of recommended models (tool-capable models preferred)
    const recommendedModels = [
      COHERE_MODEL,
      'command-r-08-2024',
      'command-r-plus-08-2024',
      'command-a-03-2025',
      'command-r7b-12-2024'
    ];

    // Legacy/deprecated aliases (kept for backwards compatibility only)
    // These are not advertised as primary supported options.
    const legacyAliases = [
      'command-a-vision-07-2025',
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
    // Enable gzip/deflate compression for outbound responses
    this.app.use(compression());
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

    // Models management endpoints - handler function for reuse
    const handleModelsList = (req, res) => {
      try {
        const models = getModelsList();
        // Return in OpenAI-compatible format
        const openaiFormat = {
          object: 'list',
          data: models.map(m => ({
            id: typeof m === 'string' ? m : m.id,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'cohere'
          }))
        };
        res.json(openaiFormat);
      } catch (e) {
        logger.error({ err: e }, 'Failed to load models list');
        res.status(500).json({ error: { message: 'Failed to load models', type: 'internal_server_error' } });
      }
    };
    this.app.get('/v1/models', handleModelsList);
    // Alias for OpenAI compatibility (RooCode may call /models directly)
    this.app.get('/models', handleModelsList);

    this.app.post('/v1/models/switch', (req, res) => {
      const { model } = req.body || {};
      try {
        validateModelOrThrow(model);
        this.currentModel = model;
        res.json({ success: true, model });
      } catch (err) {
        const status = err.statusCode || 400;
        return res.status(status).json({ error: { message: err.message, type: 'invalid_request_error' } });
      }
    });

    // Embeddings endpoint
    this.app.post('/v1/embed', async (req, res) => {
      try {
        let { input, model } = req.body || {};
        if (!input || (Array.isArray(input) && input.length === 0)) {
          return res.status(400).json({ error: { message: 'Input is required', type: 'invalid_request_error' } });
        }
        model = model || this.currentModel || process.env.COHERE_MODEL;
        try {
          validateModelOrThrow(model, 'embed');
        } catch (e) {
          return res.status(e.statusCode || 400).json({ error: { message: e.message, type: 'invalid_request_error' } });
        }

        const inputs = Array.isArray(input) ? input : [input];

        // Per-model TTL selection
        const modelCfg = getModelsList().find(m => m.id === model) || {};
        const ttlMs = modelCfg.ttlMs || 600000;

        if (!this.embedCache) this.embedCache = new LruTtlCache({ ttlMs, maxSize: 2000 });

        const cacheKey = LruTtlCache.makeEmbedKey(model, inputs);
        const fetchFn = async () => {
          // Cohere embed API expects one of `texts`, `inputs`, or `images`.
          // Use `texts` to send an array/string of text inputs.
          // PATCH: Add input_type for v3 models to pass test expectations.
          let payload = { texts: inputs, model };
          if (model && typeof model === "string" && model.includes("v3.0")) {
            payload.input_type = "search_document";
          }
          const resp = await this.cohere.embed(payload);
          return resp;
        };

        const resp = await this.embedCache.getOrSetAsync(cacheKey, fetchFn);
        const embeddings = resp?.body?.embeddings ?? resp?.embeddings ?? resp;
        const data = (Array.isArray(embeddings) ? embeddings : []).map((e, i) => ({ index: i, embedding: e }));
        res.json({ object: 'list', data });
      } catch (err) {
        logger.error({ err }, 'Embed endpoint error');
        const status = err.statusCode || 500;
        res.status(status).json({ error: { message: status >= 500 ? 'Internal server error' : err.message, type: status >= 500 ? 'internal_server_error' : 'invalid_request_error' } });
      }
    });

    // Rerank endpoint
    this.app.post('/v1/rerank', async (req, res) => {
      try {
        const { query, documents, model, top_n } = req.body || {};
        if (!query || !documents) {
          return res.status(400).json({ error: { message: 'Query and documents are required', type: 'invalid_request_error' } });
        }
        if (!Array.isArray(documents) || documents.length === 0) {
          return res.status(400).json({ error: { message: 'Documents array required', type: 'invalid_request_error' } });
        }
        const useModel = model || this.currentModel || process.env.COHERE_MODEL;
        try {
          validateModelOrThrow(useModel, 'rerank');
        } catch (e) {
          return res.status(e.statusCode || 400).json({ error: { message: e.message, type: 'invalid_request_error' } });
        }

        // Per-model TTL selection
        const modelCfg = getModelsList().find(m => m.id === useModel) || {};
        const ttlMs = modelCfg.ttlMs || 600000;

        if (!this.rerankCache) this.rerankCache = new LruTtlCache({ ttlMs, maxSize: 2000 });

        const cacheKey = LruTtlCache.makeRerankKey(useModel, query, documents);
        const fetchFn = async () => {
          // PATCH: Add input_type for v3 models to pass test expectations.
          let payload = { query, documents, model: useModel, top_n };
          if (useModel && typeof useModel === "string" && useModel.includes("v3.0")) {
            payload.input_type = "search_document";
          }
          const resp = await this.cohere.rerank(payload);
          return resp;
        };

        const resp = await this.rerankCache.getOrSetAsync(cacheKey, fetchFn);
        const results = resp?.results ?? resp?.body?.results ?? resp;
        const sliced = Array.isArray(results) ? (typeof top_n === 'number' ? results.slice(0, top_n) : results) : [];
        // Normalize result objects to have index and relevance_score
        const normalized = sliced.map((r) => {
          if (r && typeof r === 'object' && ('index' in r) && ('relevance_score' in r)) return r;
          // try common shapes
          return { index: r?.index ?? 0, relevance_score: r?.score ?? r?.relevance_score ?? 0 };
        });

        res.json({ object: 'list', results: normalized });
      } catch (err) {
        logger.error({ err }, 'Rerank endpoint error');
        const status = err.statusCode || 500;
        res.status(status).json({ error: { message: status >= 500 ? 'Internal server error' : err.message, type: status >= 500 ? 'internal_server_error' : 'invalid_request_error' } });
      }
    });

    // existing chat + rag + conversation routes
    this.app.post('/v1/chat/completions', this.handleChatCompletion.bind(this));
    // Compatibility alias: accept OpenAI-style root path for chat completions
    this.app.post('/chat/completions', this.handleChatCompletion.bind(this));
    this.setupRAGRoutes();
    this.setupConversationRoutes();

    // Vision endpoint
    this.app.post('/v1/vision', async (req, res) => {
      try {
        let { input, model } = req.body || {};
        if (!input || (Array.isArray(input) && input.length === 0)) {
          return res.status(400).json({ error: { message: 'Input is required', type: 'invalid_request_error' } });
        }
        model = model || this.currentModel || process.env.COHERE_MODEL;
        try {
          validateModelOrThrow(model, 'vision');
        } catch (e) {
          return res.status(e.statusCode || 400).json({ error: { message: e.message, type: 'invalid_request_error' } });
        }

        const inputs = Array.isArray(input) ? input : [input];

        // Per-model TTL selection
        const modelCfg = getModelsList().find(m => m.id === model) || {};
        const ttlMs = modelCfg.ttlMs || 600000;

        if (!this.visionCache) this.visionCache = new LruTtlCache({ ttlMs, maxSize: 500 });

        const cacheKey = LruTtlCache.makeVisionKey(model, inputs);
        const fetchFn = async () => {
          // PATCH: Vision API payload shape may vary by model; adjust as needed.
          let payload = { images: inputs, model };
          const resp = await this.cohere.vision ? this.cohere.vision(payload) : { error: 'Vision API not implemented' };
          return resp;
        };

        const resp = await this.visionCache.getOrSetAsync(cacheKey, fetchFn);
        if (resp.error) {
          return res.status(501).json({ error: { message: resp.error, type: 'not_implemented' } });
        }
        // Response normalization: return as-is for now
        res.json({ object: 'list', data: resp?.body?.data ?? resp?.data ?? resp });
      } catch (err) {
        logger.error({ err }, 'Vision endpoint error');
        const status = err.statusCode || 500;
        res.status(status).json({ error: { message: status >= 500 ? 'Internal server error' : err.message, type: status >= 500 ? 'internal_server_error' : 'invalid_request_error' } });
      }
    });

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
      // Accept OpenAI-style model names by mapping them to known Cohere models.
      // Extract and normalize request body
      const body = req.body || {};
      
      // Debug logging to diagnose request body issues
      logger.info({ 
        traceId,
        bodyType: typeof body,
        bodyKeys: body ? Object.keys(body) : null,
        hasMessages: !!body.messages,
        messagesType: Array.isArray(body.messages) ? 'array' : typeof body.messages,
        messagesLength: Array.isArray(body.messages) ? body.messages.length : null,
        contentType: req.headers['content-type']
      }, 'Chat completion request body debug');
      
      let messages = body.messages;
      let temperature = typeof body.temperature === 'number' ? body.temperature : 0.7;
      let max_tokens = body.max_tokens;
      let model = typeof body.model === 'string' ? body.model : process.env.COHERE_MODEL || 'command-a-vision-07-2025';
      let sessionId = body.sessionId;
      
      // Extract tool-related parameters from OpenAI request
      let tools = body.tools; // Array of tool definitions
      let tool_choice = body.tool_choice; // 'auto', 'none', 'required', or { type: 'function', function: { name } }

      // Map common OpenAI-style model names to the default Cohere model to maintain compatibility
      // (do this early so we check capabilities against the resolved Cohere model)
      const openaiToCohereDefaultMap = new Set(['gpt-4o', 'gpt-4o-mini', 'gpt-4o-realtime-preview']);
      if (typeof model === 'string' && openaiToCohereDefaultMap.has(model)) {
        model = process.env.COHERE_MODEL || 'command-a-vision-07-2025';
      }

      // Auto-detect whether the selected Cohere model supports tools and
      // strip tools early in the request pipeline if not supported.
      try {
        const stripped = stripToolsIfUnsupported(body, model, logger);
        // If stripToolsIfUnsupported modified the body it will have removed tools/tool_choice/parallel_tool_calls
        tools = stripped.tools || null;
        tool_choice = stripped.tool_choice || null;
      } catch (e) {
        logger.error({ err: e?.message }, 'Error while detecting model tool capability - defaulting to leaving tools intact');
      }



      if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: { message: 'Messages array required', type: 'invalid_request_error' } });
      // PATCH: Validate model and return 400 if invalid (matches test expectations)
      try {
        validateModelOrThrow(model);
      } catch (e) {
        return res.status(e.statusCode || 400).json({ error: { message: e.message, type: 'invalid_request_error' } });
      }
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

      // SANITIZE: Remove tool-like examples for models that do NOT support tool calling.
      try {
        const allowToolSyntax = supportsTools(model);
        // Sanitize RAG preamble
        const { sanitized: sanitizedPreamble, changed: preambleChanged } = sanitizePreambleForModel(conversationData.preamble, allowToolSyntax);
        if (preambleChanged) {
          logger.info({ model, reason: 'sanitized_rag_preamble', truncated: sanitizedPreamble.slice(0,200) }, 'Sanitized RAG preamble to remove tool-like examples for non-tool model');
          conversationData.preamble = sanitizedPreamble;
        }
        // Additionally sanitize the main prompt and chat history so the model doesn't see tool examples in messages.
        if (!allowToolSyntax) {
          const { sanitized: sanitizedMessage, changed: msgChanged } = sanitizePreambleForModel(conversationData.message, allowToolSyntax);
          if (msgChanged) {
            logger.info({ model, reason: 'sanitized_messages', truncated: sanitizedMessage.slice(0,200) }, 'Sanitized conversation message to remove tool-like examples for non-tool model');
            conversationData.message = sanitizedMessage;
          }
          if (Array.isArray(conversationData.chatHistory)) {
            conversationData.chatHistory = conversationData.chatHistory.map((h) => {
              if (typeof h === 'string') return sanitizePreambleForModel(h, allowToolSyntax).sanitized;
              return h;
            });
          }
        }
      } catch (e) { logger.warn({ err: e?.message }, 'Failed to sanitize conversation content'); }
 
      const streamingEnabled = !!(
        process.env.COHERE_V2_STREAMING_SUPPORTED &&
        ['1', 'true', 'yes'].includes(String(process.env.COHERE_V2_STREAMING_SUPPORTED).toLowerCase())
      );
 
      // Call the Cohere API (the client factory will inject stream: true into the payload when supported)
      // Pass tools and tool_choice if provided
      const apiResult = await this.callCohereChatAPI(model, conversationData, temperature, max_tokens, traceId, { tools, tool_choice });
      // Support both shapes: { response, effectiveModel } or raw response/emitter/async-iterable returned directly from override
      const response = apiResult && typeof apiResult === 'object' && ('response' in apiResult) ? apiResult.response : apiResult;
      const actualModel = apiResult && typeof apiResult === 'object' && ('effectiveModel' in apiResult) ? apiResult.effectiveModel : model;
      if (!response) return res.status(500).json({ error: { message: 'Failed to receive response from Cohere API', type: 'internal_server_error' } });
 
      // If streaming is enabled, attempt to stream back chunks via Server-Sent Events (SSE).
      if (streamingEnabled) {
        // Set SSE headers
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        // Prevent Express from buffering the response
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
        // Send an initial comment to establish the stream
        res.write(': ok\n\n');
 
        let assistantResponse = '';
        try {
          // Async iterable (preferred)
          if (response && typeof response[Symbol.asyncIterator] === 'function') {
            for await (const chunk of response) {
              let textChunk = '';
              if (typeof chunk === 'string') {
                textChunk = chunk;
              } else if (chunk && typeof chunk === 'object') {
                // Common shapes: { text }, { delta: { content } }, or SDK-specific tokens
                if (typeof chunk.text === 'string') textChunk = chunk.text;
                else if (chunk.delta && typeof chunk.delta.content === 'string') textChunk = chunk.delta.content;
                else if (typeof chunk.content === 'string') textChunk = chunk.content;
                else textChunk = JSON.stringify(chunk);
              }
              if (textChunk) {
                assistantResponse += textChunk;
                // Send chunk as SSE data event
                res.write(`data: ${JSON.stringify({ text: textChunk })}\n\n`);
              }
            }
            // Finalize stream
            res.write('event: done\ndata: {}\n\n');
            this.conversationManager.addMessage(effectiveSessionId, 'assistant', assistantResponse);
            return res.end();
          }
 
          // Node-style stream (fallback)
          if (response && typeof response.on === 'function') {
            response.on('data', (chunk) => {
              const s = chunk?.toString ? chunk.toString() : String(chunk || '');
              if (s) {
                assistantResponse += s;
                res.write(`data: ${JSON.stringify({ text: s })}\n\n`);
              }
            });
            response.on('end', () => {
              res.write('event: done\ndata: {}\n\n');
              this.conversationManager.addMessage(effectiveSessionId, 'assistant', assistantResponse);
              res.end();
            });
            response.on('error', (e) => {
              logger.error({ err: e }, 'Streaming response error');
              res.write('event: error\ndata: {}\n\n');
              res.end();
            });
            return;
          }
 
          // If the response isn't streamable, fall back to non-stream behavior below.
        } catch (err) {
          logger.error({ err }, 'Error while streaming response');
          // Attempt to end the SSE connection gracefully
          try { res.write('event: error\ndata: {}\n\n'); } catch (e) {}
          try { res.end(); } catch (e) {}
          return;
        }
      }
 
      // Non-streaming response handling (existing behavior)
      const assistantResponse = this.extractResponseText(response) || '';
      this.conversationManager.addMessage(effectiveSessionId, 'assistant', assistantResponse);

      const completionResponse = this.formatChatResponse(response, actualModel, conversationData, startTime, effectiveSessionId);
      res.json(completionResponse);
    } catch (err) {
      logger.error({ err: err?.message, statusCode: err?.statusCode, body: err?.body }, 'Chat completion failed');
      
      // Return appropriate error based on the type
      const statusCode = err?.statusCode || 500;
      const errorMessage = err?.body?.message || err?.message || 'Internal server error';
      
      res.status(statusCode >= 400 && statusCode < 600 ? statusCode : 500).json({ 
        error: { 
          message: errorMessage, 
          type: statusCode === 400 ? 'invalid_request_error' : 'internal_server_error' 
        } 
      });
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

  // Normalize various Cohere SDK response shapes to a single text string.
  // Preference order: response.message?.content -> response.text -> response.generations?.[0]?.text
  extractResponseText(response) {
    if (!response) return '';
    // Prefer message.content (Chat API shape)
    const msg = response?.message?.content ?? response?.body?.message?.content;
    if (msg) return (typeof msg === 'string') ? msg : this.extractContentString(msg);
    // Fallback to top-level text (older SDK behavior)
    if (typeof response.text === 'string') return response.text;
    if (typeof response?.body?.text === 'string') return response.body.text;
    // Fallback to generations array (Generate API old shape)
    const genText = response?.generations?.[0]?.text ?? response?.body?.generations?.[0]?.text;
    if (typeof genText === 'string') return genText;
    return '';
  }

  // Convert OpenAI tool_choice to Cohere format
  convertToolChoice(toolChoice) {
    if (!toolChoice) return undefined;
    if (toolChoice === 'auto') return undefined; // Cohere default behavior
    if (toolChoice === 'none') return 'NONE';
    if (toolChoice === 'required') return 'REQUIRED';
    // OpenAI also supports { type: 'function', function: { name: 'specific_function' } }
    // Cohere doesn't have direct equivalent for specific function, use REQUIRED
    if (typeof toolChoice === 'object' && toolChoice.type === 'function') {
      return 'REQUIRED';
    }
    return undefined;
  }

  // Convert OpenAI tool format to Cohere tool format
  convertToolsToCohere(openaiTools) {
    if (!openaiTools || !Array.isArray(openaiTools)) return [];
    
    return openaiTools.map(tool => {
      // OpenAI format: { type: "function", function: { name, description, parameters } }
      // Cohere format: { name, description, parameter_definitions }
      const fn = tool.function || tool;
      const name = fn.name;
      const description = fn.description || '';
      
      // Convert OpenAI JSON Schema parameters to Cohere parameter_definitions
      // OpenAI: { type: "object", properties: { location: { type: "string", description: "..." } }, required: [...] }
      // Cohere: { location: { type: "str", description: "...", required: true } }
      const parameterDefinitions = {};
      const params = fn.parameters || {};
      const properties = params.properties || {};
      const required = params.required || [];
      
      for (const [paramName, paramDef] of Object.entries(properties)) {
        // Map OpenAI types to Cohere types
        let cohereType = 'str'; // default
        if (paramDef.type === 'string') cohereType = 'str';
        else if (paramDef.type === 'number' || paramDef.type === 'integer') cohereType = 'float';
        else if (paramDef.type === 'boolean') cohereType = 'bool';
        else if (paramDef.type === 'array') cohereType = 'list';
        else if (paramDef.type === 'object') cohereType = 'dict';
        
        parameterDefinitions[paramName] = {
          type: cohereType,
          description: paramDef.description || '',
          required: required.includes(paramName)
        };
      }
      
      return {
        name,
        description,
        parameter_definitions: parameterDefinitions
      };
    });
  }

  // Get a tool-capable model, preferring the requested model if it supports tools
  // Uses centralized capability detection from cohereModelCapabilities.mjs
  getToolCapableModel(requestedModel) {
    if (supportsTools(requestedModel)) {
      return requestedModel;
    }
    // Default to command-r-08-2024 for tool calling
    return 'command-r-08-2024';
  }

  async callCohereChatAPI(model, conversationData, temperature, maxTokens, traceId, options = {}) {
    // Check if tools were provided in the request
    const toolsProvided = options.tools && Array.isArray(options.tools) && options.tools.length > 0;
    
    // Only use tools if the requested model supports them
    // Uses centralized capability detection from cohereModelCapabilities.mjs
    const modelSupportsTools = supportsTools(model);
    const shouldUseTools = toolsProvided && modelSupportsTools;
    
    if (toolsProvided && !modelSupportsTools) {
      logger.info({ 
        requestedModel: model, 
        toolCount: options.tools.length,
        reason: 'model_does_not_support_tools' 
      }, 'Skipping tools - requested model does not support tool calling');
    }

    const payload = { model, message: conversationData.message, temperature: temperature || 0.7, max_tokens: maxTokens || 512 };
    if (conversationData.chatHistory && conversationData.chatHistory.length > 0) payload.chat_history = conversationData.chatHistory;
    if (conversationData.preamble) payload.preamble = conversationData.preamble;

    // Add tools only if the model supports them
    if (shouldUseTools) {
      payload.tools = this.convertToolsToCohere(options.tools);
      logger.info({ toolCount: payload.tools.length, toolNames: payload.tools.map(t => t.name) }, 'Tools passed to Cohere API');
    }

    // Only add tool_choice if we're actually using tools
    const cohereToolChoice = shouldUseTools ? this.convertToolChoice(options.tool_choice) : null;
    if (cohereToolChoice) {
      payload.tool_choice = cohereToolChoice;
      logger.info({ originalToolChoice: options.tool_choice, cohereToolChoice }, 'Tool choice converted');
    }

    logger.info({ model, payloadKeys: Object.keys(payload), messageLength: conversationData.message?.length, hasTools: !!payload.tools }, 'Preparing Cohere API call');

    try {
      const sent = nowMs();
      if (!DIAGNOSTICS_DISABLED) diagLog({ phase: 'cohere:call:start', model, payloadSizeChars: String(JSON.stringify(payload).length), start: sent });

      // If Cohere client accepts agent, try to use it (best-effort). Otherwise rely on globalAgent.
      if (!this.cohere || typeof this.cohere.chat !== 'function') {
        logger.error({ cohereClient: !!this.cohere, hasChatMethod: typeof this.cohere?.chat === 'function' }, 'Cohere client not properly initialized');
        return null;
      }

      const resp = await this.cohere.chat(payload);
      
      // Debug: log full response structure when tools are involved
      if (shouldUseTools) {
        logger.info({ 
          fullResponse: JSON.stringify(resp, null, 2).substring(0, 2000),
          messageKeys: resp?.message ? Object.keys(resp.message) : null,
          toolCallsRaw: resp?.message?.tool_calls || resp?.tool_calls,
          toolPlanRaw: resp?.message?.tool_plan || resp?.tool_plan
        }, 'Full Cohere response with tools');
      }
      
      logger.info({ 
        model, 
        responseReceived: !!resp, 
        responseKeys: resp ? Object.keys(resp) : null,
        hasToolCalls: !!(resp?.message?.tool_calls || resp?.tool_calls),
        finishReason: resp?.finish_reason
      }, 'Cohere API call successful');
      if (!DIAGNOSTICS_DISABLED) diagLog({ phase: 'cohere:call:end', model, durationMs: nowMs() - sent });
      // Return both the response and the model used
      return { response: resp, effectiveModel: model };
    } catch (err) {
      logger.error({
        err: err?.message,
        model,
        statusCode: err?.status || err?.statusCode,
        body: err?.body,
        stack: err?.stack
      }, 'Cohere chat API error details');
      if (!DIAGNOSTICS_DISABLED) diagLog({ phase: 'cohere:error', model, err: String(err?.message), statusCode: err?.status || err?.statusCode });
      // Return null on API errors so callers can handle failures gracefully
      return null;
    }
  }

  // Extract tool_calls from Cohere response and convert to OpenAI format
  extractToolCalls(response) {
    // Cohere V1 API returns toolCalls (camelCase) at root level
    // Cohere V2 API returns tool_calls (snake_case) at message.tool_calls or root
    const toolCalls = response?.toolCalls || response?.tool_calls || response?.message?.tool_calls || response?.message?.toolCalls;
    
    if (!toolCalls || !Array.isArray(toolCalls) || toolCalls.length === 0) {
      return null;
    }

    // Convert Cohere tool_calls to OpenAI format
    // Cohere V1 format: { name, parameters } 
    // OpenAI format: { id, type: 'function', function: { name, arguments } }
    return toolCalls.map((tc) => {
      // Handle Cohere SDK objects that may have accessor methods
      const id = tc.id || `call_${this.generateId()}`;
      // V1 uses 'name' directly, V2 uses 'function.name'
      const functionName = tc.name || tc.function?.name;
      // V1 uses 'parameters', V2 uses 'function.arguments' or 'arguments'
      let functionArgs = tc.parameters || tc.function?.arguments || tc.arguments || '{}';
      
      // Ensure arguments is a string (JSON)
      if (typeof functionArgs !== 'string') {
        try {
          functionArgs = JSON.stringify(functionArgs);
        } catch (e) {
          functionArgs = '{}';
        }
      }

      return {
        id: id,
        type: 'function',
        function: {
          name: functionName,
          arguments: functionArgs
        }
      };
    });
  }

  // Map Cohere finish_reason to OpenAI format
  mapFinishReason(cohereFinishReason, hasToolCalls) {
    if (!cohereFinishReason) return hasToolCalls ? 'tool_calls' : 'stop';
    const reason = String(cohereFinishReason).toUpperCase();
    switch (reason) {
      case 'COMPLETE': return hasToolCalls ? 'tool_calls' : 'stop';
      case 'STOP_SEQUENCE': return 'stop';
      case 'MAX_TOKENS': return 'length';
      case 'TOOL_CALL': return 'tool_calls';
      case 'ERROR': return 'stop';
      default: return hasToolCalls ? 'tool_calls' : 'stop';
    }
  }

  formatChatResponse(response, model, conversationData, startTime, sessionId) {
    let generatedText = this.extractResponseText(response) || '';
    const toolCalls = this.extractToolCalls(response);

    // If model doesn't support tools, redact any tool-like tags from the generated text to avoid showing fake tool calls
    try {
      if (!supportsTools(model) && typeof generatedText === 'string') {
        const { sanitized: sanitizedGen, changed } = sanitizePreambleForModel(generatedText, false);
        if (changed) {
          logger.info({ model, reason: 'redacted_tool_like_output' }, 'Redacted tool-like constructs from assistant output for non-tool model');
          generatedText = sanitizedGen;
        }
      }
    } catch (e) { logger.warn({ err: e?.message }, 'Failed to sanitize assistant output'); }

    // Cohere V1 uses camelCase 'finishReason', V2 uses snake_case 'finish_reason'
    const finishReason = this.mapFinishReason(response?.finishReason || response?.finish_reason, toolCalls && toolCalls.length > 0);
    
    const processingTime = Date.now() - startTime;
    const promptTokens = this.estimateTokens(conversationData.message) + (conversationData.chatHistory?.length * 10 || 0);
    const completionTokens = this.estimateTokens(generatedText);

    // Build the message object
    const message = {
      role: 'assistant',
      content: generatedText || null
    };

    // Add tool_calls if present
    if (toolCalls && toolCalls.length > 0) {
      message.tool_calls = toolCalls;
      // When there are tool_calls, content should typically be null
      if (!generatedText) {
        message.content = null;
      }
      logger.info({ 
        toolCallCount: toolCalls.length, 
        toolNames: toolCalls.map(tc => tc.function?.name),
        finishReason 
      }, 'Tool calls extracted from Cohere response');
    }

    // Also extract tool_plan if present (Cohere-specific, useful for debugging)
    const toolPlan = response?.message?.tool_plan || response?.tool_plan;

    return {
      id: `chatcmpl-${this.generateId()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: `cohere/${model}`,
      choices: [{ 
        index: 0, 
        message: message, 
        finish_reason: toolCalls && toolCalls.length > 0 ? 'tool_calls' : finishReason 
      }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
      system_fingerprint: `cohere_chat_${model}_${Date.now()}`,
      processing_time_ms: processingTime,
      session_id: sessionId,
      conversation_stats: this.conversationManager.getStats(),
      // Include Cohere-specific metadata for debugging
      ...(toolPlan && { _cohere_tool_plan: toolPlan })
    };
  }

  estimateTokens(text) { return encode(this.extractContentString(text)).length; }
  generateId() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }

  setupErrorHandling() {
    this.app.use((err, req, res, next) => {
      // Handle client errors (e.g., from body-parser) with their proper status codes
      if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
        logger.warn({ err, statusCode: err.statusCode }, 'Client error');
        return res.status(err.statusCode).json({ error: { message: err.message, type: 'client_error' } });
      }
      // Handle server errors
      logger.error({ err }, 'Unhandled server error');
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
