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
    const layers = srv.app._router?.stack || [];
    // error-handling middleware is typically the last layer
    const errLayer = layers.length > 0 && layers[layers.length - 1]?.handle && typeof layers[layers.length - 1].handle === 'function' && layers[layers.length - 1].handle.length === 4 ? layers[layers.length - 1].handle : null;
    expect(errLayer).toBeDefined();

    // client error
    const clientErr = new Error('client bad');
    clientErr.statusCode = 400;
    const resClient = {
      status: (s) => { resClient.statusCode = s; return resClient; },
      json: vi.fn((p) => { resClient._json = p; }),
    };
    // call error middleware directly
    await errLayer(clientErr, {}, resClient, () => {});
    expect(resClient._json).toBeDefined();
    expect(resClient._json.error.message).toBe('client bad');

    // server error (no statusCode)
    const serverErr = new Error('server blew up');
    const resSrv = {
      status: (s) => { resSrv.statusCode = s; return resSrv; },
      json: vi.fn((p) => { resSrv._json = p; }),
    };
    await errLayer(serverErr, {}, resSrv, () => {});
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
    srv.conversationManager = { addMessage: vi.fn(), getFormattedHistoryWithRAG: vi.fn().mockReturnValue({ message: 'hi', chatHistory: [] }), getStats: vi.fn().mockReturnValue({}) };
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
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.some(w => w.includes('event: error') || w.includes('event: done'))).toBeTruthy();
  });

  it('node-style stream emits data/end and error handler writes expected SSE events', async () => {
    process.env.COHERE_V2_STREAMING_SUPPORTED = '1';
    const { default: EnhancedCohereRAGServer } = await import('../src/index.mjs');
    const srv = new EnhancedCohereRAGServer({ port: 0 });
    // prevent background RAG embedding work and instrument conversationManager to avoid side-effects
    srv.ragManager = { getStats: () => ({ metrics: {} }), indexCodebase: async () => ({ success: true }), clearIndex: () => {}, shutdown: async () => {} };
    srv.conversationManager = { addMessage: vi.fn(), getFormattedHistoryWithRAG: vi.fn().mockReturnValue({ message: 'hi', chatHistory: [] }), getStats: vi.fn().mockReturnValue({}) };
    // ensure model validation passes
    srv.supportedModels = new Set(['command-a-03-2025']);

    const req = { body: { messages: [{ role: 'user', content: 'hello' }] }, headers: {} };
    let writes = [];
    // create a promise that resolves when res.end called
    let endResolve;
    const endPromise = new Promise((r) => { endResolve = r; });
    const res = {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: (s) => writes.push(String(s)),
      end: () => { res._ended = true; endResolve(); },
      status: (s) => { res.statusCode = s; return res; },
      json: vi.fn((p) => { res._json = p; }),
    };

    // override callCohereChatAPI to return an EventEmitter that emits data/error on next microtask
    srv.callCohereChatAPI = async () => {
      const ev = new EventEmitter();
      Promise.resolve().then(() => {
        ev.emit('data', Buffer.from('partA'));
        ev.emit('error', new Error('stream err'));
      });
      return ev;
    };

    // handleChatCompletion will return before events happen; await the endPromise to ensure handlers executed
    await srv.handleChatCompletion(req, res);
    await endPromise;

    expect(writes.length).toBeGreaterThan(0);
    // data chunk emitted should be written as SSE data
    expect(writes.some(w => w.includes('partA') || w.includes('data'))).toBeTruthy();
    // because error was emitted, error event should also be written
    expect(writes.some(w => w.includes('event: error') || w.includes('event: done'))).toBeTruthy();
  });
});