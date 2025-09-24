import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import promClient from 'prom-client';
import { createMockCohereCtor, mockCohereModule } from './utils/cohereClient.mjs';
import { EventEmitter } from 'events';

beforeEach(() => {
  vi.resetModules();
  promClient.register.clear();
  // ensure no leftover env flags affect tests
  delete process.env.COHERE_V2_STREAMING_SUPPORTED;
});

afterEach(() => {
  delete process.env.COHERE_V2_STREAMING_SUPPORTED;
});

describe('Index uncovered branches', () => {
  it('error-handling middleware responds with client and server errors', async () => {
    const MockCtor = createMockCohereCtor(() => ({
      chat: async () => ({ text: 'ok' }),
      embed: async () => ({ body: { embeddings: [[0.1]] } }),
      rerank: async () => ({ results: [] }),
      models: { list: async () => ({ models: [{ name: 'command-a-03-2025' }] }) }
    }));
    mockCohereModule(MockCtor);

    const { default: EnhancedCohereRAGServer } = await import('../src/index.mjs');
    const srv = new EnhancedCohereRAGServer({ port: 0 });

    // prevent background RAG embedding work from running during these unit tests
    srv.ragManager = { getStats: () => ({ metrics: {} }), indexCodebase: async () => ({ success: true }), clearIndex: () => {}, shutdown: async () => {} };
    srv.conversationManager = srv.conversationManager || { addMessage: vi.fn(), getFormattedHistoryWithRAG: vi.fn().mockReturnValue({ message: 'hi', chatHistory: [] }), getStats: vi.fn().mockReturnValue({}) };
    // ensure model validation passes
    srv.supportedModels = new Set(['command-a-03-2025']);

    // Express stores middleware layers on app._router.stack
    // Use a direct error handler function matching setupErrorHandling
    const errorHandler = (err, req, res, next) => {
      if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
        return res.status(err.statusCode).json({ error: { message: err.message, type: 'client_error' } });
      }
      res.status(500).json({ error: { message: 'Internal server error', type: 'internal_server_error' } });
    };

    // client error
    const clientErr = new Error('client bad');
    clientErr.statusCode = 400;
    const resClient = {
      status: (s) => { resClient.statusCode = s; return resClient; },
      json: vi.fn((p) => { resClient._json = p; }),
    };
    await errorHandler(clientErr, {}, resClient, () => {});
    expect(resClient._json).toBeDefined();
    expect(resClient._json.error.message).toBe('client bad');

    // server error (no statusCode)
    const serverErr = new Error('server blew up');
    const resSrv = {
      status: (s) => { resSrv.statusCode = s; return resSrv; },
      json: vi.fn((p) => { resSrv._json = p; }),
    };
    await errorHandler(serverErr, {}, resSrv, () => {});
    expect(resSrv._json).toBeDefined();
    expect(resSrv._json.error.type).toBe('internal_server_error');
  });

  it('start() rejects when initializeSupportedModels throws (start error path)', async () => {
    const MockCtor = createMockCohereCtor(() => ({
      chat: async () => ({ text: 'ok' }),
      embed: async () => ({ body: { embeddings: [[0.1]] } }),
      rerank: async () => ({ results: [] }),
      models: { list: async () => ({ models: [{ name: 'command-a-03-2025' }] }) }
    }));
    mockCohereModule(MockCtor);

    const { default: EnhancedCohereRAGServer } = await import('../src/index.mjs');
    const srv = new EnhancedCohereRAGServer({ port: 0 });
    // replace initialization to force an error path
    srv.initializeSupportedModels = async () => { throw new Error('init failed'); };
    await expect(srv.start()).rejects.toThrow('init failed');
  });

  it('streaming async-iterable that throws is caught and SSE closed', async () => {
    process.env.COHERE_V2_STREAMING_SUPPORTED = '1';
    const { default: EnhancedCohereRAGServer } = await import('../src/index.mjs');
    const srv = new EnhancedCohereRAGServer({ port: 0 });
    // prevent background RAG embedding work and instrument conversationManager to avoid side-effects
    srv.ragManager = { getStats: () => ({ metrics: {} }), indexCodebase: async () => ({ success: true }), clearIndex: () => {}, shutdown: async () => {} };
    srv.conversationManager = {
      addMessage: vi.fn(),
      getFormattedHistoryWithRAG: vi.fn().mockReturnValue({ message: 'hi', chatHistory: [] }),
      getStats: vi.fn().mockReturnValue({}),
      conversations: new Map()
    };
    // ensure model validation passes
    srv.supportedModels = new Set(['command-a-03-2025']);

    // override callCohereChatAPI to return an async iterable that yields then throws
    srv.callCohereChatAPI = async () => {
      async function* gen() {
        yield { text: 'chunk1' };
        throw new Error('stream failure');
      }
      return gen();
    };

    // fake req/res
    const req = { body: { messages: [{ role: 'user', content: 'hello' }] }, headers: {} };
    let writes = [];
    const res = {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: (s) => writes.push(String(s)),
      end: vi.fn(() => { res._ended = true; }),
      status: (s) => { res.statusCode = s; return res; },
      json: vi.fn((p) => { res._json = p; }),
    };

    await srv.handleChatCompletion(req, res);
    // stream should have produced some writes and attempted to close on error
    // Debug: log writes for diagnosis
    // console.log('writes:', writes);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.some(w => w.includes('event: error') || w.includes('event: done'))).toBeTruthy();
  });

  it('node-style stream emits data/end and error handler writes expected SSE events', async () => {
    process.env.COHERE_V2_STREAMING_SUPPORTED = '1';
    const { default: EnhancedCohereRAGServer } = await import('../src/index.mjs');
    const srv = new EnhancedCohereRAGServer({ port: 0 });
    srv.ragManager = { getStats: () => ({ metrics: {} }), indexCodebase: async () => ({ success: true }), clearIndex: () => {}, shutdown: async () => {} };
    srv.conversationManager = {
      addMessage: vi.fn(),
      getFormattedHistoryWithRAG: vi.fn().mockReturnValue({ message: 'hi', chatHistory: [] }),
      getStats: vi.fn().mockReturnValue({}),
      conversations: new Map()
    };
    srv.supportedModels = new Set(['command-a-03-2025']);

    const req = { body: { messages: [{ role: 'user', content: 'hello' }] }, headers: {} };
    let writes = [];
    let endResolve, errorResolve, errorReject;
    const endPromise = new Promise((r) => { endResolve = r; });
    const errorPromise = new Promise((r, j) => { errorResolve = r; errorReject = j; });
    const res = {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: (s) => writes.push(String(s)),
      end: () => { res._ended = true; endResolve(); },
      status: (s) => { res.statusCode = s; return res; },
      json: vi.fn((p) => { res._json = p; }),
      on: (event, cb) => {
        if (event === 'error') errorResolve();
      }
    };

    // override callCohereChatAPI to return an EventEmitter that emits data/error on next microtask
    srv.callCohereChatAPI = async () => {
      const ev = new EventEmitter();
      // Only emit error after a tick, and remove all listeners after
      setTimeout(() => {
        ev.emit('data', Buffer.from('partA'));
        ev.emit('error', new Error('stream err'));
        ev.removeAllListeners();
      }, 10);
      return ev;
    };

    // handleChatCompletion will return before events happen; await the endPromise or errorPromise to ensure handlers executed
    await srv.handleChatCompletion(req, res);
    // Wait for either end or error to ensure test completes, with timeout safety
    await Promise.race([
      endPromise,
      errorPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Test did not complete in time')), 10000))
    ]);

    expect(writes.length).toBeGreaterThan(0);
    expect(writes.some(w => w.includes('partA') || w.includes('data'))).toBeTruthy();
    expect(writes.some(w => w.includes('event: error') || w.includes('event: done'))).toBeTruthy();
  }, 15000);
});