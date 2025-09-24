import { describe, it, expect, vi, beforeEach } from 'vitest';
import EnhancedCohereRAGServer from '../src/index.mjs';
import promClient from 'prom-client';

describe('EnhancedCohereRAGServer methods', () => {
  let server;

  beforeEach(() => {
    process.env.COHERE_V2_STREAMING_SUPPORTED = 'true';
    process.env.SKIP_DIAGNOSTICS = 'true';
    promClient.register.clear();
    server = new EnhancedCohereRAGServer({ port: 0 });
  });

  it('extractContentString handles various inputs', () => {
    expect(server.extractContentString('string')).toBe('string');
    expect(server.extractContentString({ text: 'obj' })).toBe('obj');
    expect(server.extractContentString([{ text: 'part1' }, { text: 'part2' }])).toBe('part1 part2');
    expect(server.extractContentString({})).toBe('{}');
    expect(server.extractContentString(null)).toBe('');
    expect(server.extractContentString(undefined)).toBe('');
  });

  it('callCohereChatAPI handles client not initialized', async () => {
    server.cohere = null;
    const result = await server.callCohereChatAPI('model', { message: 'test' });
    expect(result).toBe(null);
  });

  it('callCohereChatAPI handles client without chat method', async () => {
    server.cohere = {};
    const result = await server.callCohereChatAPI('model', { message: 'test' });
    expect(result).toBe(null);
  });

  it('callCohereChatAPI handles API error', async () => {
    server.cohere = { chat: vi.fn().mockRejectedValue(new Error('API error')) };
    const result = await server.callCohereChatAPI('model', { message: 'test' });
    expect(result).toBe(null);
  });

  it('start method handles initializeSupportedModels error', async () => {
    server.cohere = { models: { list: vi.fn().mockRejectedValue(new Error('list error')) } };
    await expect(server.start()).resolves.toBeDefined();
  });

  it('stop method calls shutdown on managers', async () => {
    server.ragManager = { shutdown: vi.fn() };
    server.conversationManager = { shutdown: vi.fn() };
    server.server = { close: vi.fn().mockImplementation((cb) => cb()) };
    await server.stop();
    expect(server.ragManager.shutdown).toHaveBeenCalled();
    expect(server.conversationManager.shutdown).toHaveBeenCalled();
  });

  it('handleChatCompletion supports streaming', async () => {
    // Mock streaming response
    const mockStream = async function* () {
      yield { text: 'chunk1' };
      yield { text: 'chunk2' };
    }();
    server.cohere = { chat: vi.fn().mockResolvedValue(mockStream) };
    // Provide conversations map so handleChatCompletion can access ragContext
    const conversationsMap = new Map();
    conversationsMap.set('id', { ragContext: [] });
    server.conversationManager = {
      addMessage: vi.fn(),
      getFormattedHistoryWithRAG: vi.fn().mockReturnValue({ message: 'test', chatHistory: [] }),
      getStats: vi.fn().mockReturnValue({}),
      conversations: conversationsMap
    };
    server.generateId = vi.fn().mockReturnValue('id');
    server.extractContentString = vi.fn().mockReturnValue('content');

    // Mock request/response
    const req = {
      body: { messages: [{ role: 'user', content: 'test' }], model: 'command-a-03-2025' },
      headers: {},
      log: vi.fn()
    };
    const res = {
      setHeader: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      flushHeaders: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    };

    process.env.COHERE_V2_STREAMING_SUPPORTED = 'true';
    process.env.SKIP_DIAGNOSTICS = 'true';

    await server.handleChatCompletion(req, res);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream; charset=utf-8');
    expect(res.write).toHaveBeenCalledWith('data: {"text":"chunk1"}\n\n');
    expect(res.write).toHaveBeenCalledWith('data: {"text":"chunk2"}\n\n');
    expect(res.write).toHaveBeenCalledWith('event: done\ndata: {}\n\n');
    expect(res.end).toHaveBeenCalled();
  });
});