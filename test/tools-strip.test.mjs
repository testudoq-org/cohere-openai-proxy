/* eslint-env node, vitest */
/* global process */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import EnhancedCohereRAGServer from '../src/index.mjs';
import promClient from 'prom-client';

describe('Tool preservation and stripping with OpenAI aliases', () => {
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    // Clear Prometheus registry to avoid duplicate metric registration across tests
    try { promClient.register.clear(); } catch (e) { void e; }
    process.env.SKIP_DIAGNOSTICS = 'true';
    process.env.COHERE_V2_STREAMING_SUPPORTED = 'false';
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
    vi.restoreAllMocks();
  });

  it('preserves tools when resolved Cohere model supports tools (gpt-4o -> command-r-08-2024)', async () => {
    process.env.COHERE_MODEL = 'command-r-08-2024'; // tool-capable

    const server = new EnhancedCohereRAGServer({ port: 0 });

    // Capture payload sent to Cohere
    let capturedPayload;
    server.cohere = {
      chat: vi.fn().mockImplementation(async (payload) => {
        capturedPayload = payload;
        return { body: { message: { content: 'ok' } } };
      })
    };

    // Minimal conversation manager to satisfy server use
    server.conversationManager = {
      addMessage: vi.fn(),
      getFormattedHistoryWithRAG: vi.fn().mockReturnValue({ message: 'user input', chatHistory: [], preamble: '' }),
      getStats: vi.fn().mockReturnValue({}),
      conversations: new Map()
    };
    server.generateId = vi.fn().mockReturnValue('sess1');

    const openaiTool = {
      function: {
        name: 'do_math',
        description: 'adds two numbers',
        parameters: {
          type: 'object',
          properties: { x: { type: 'number' } },
          required: ['x']
        }
      }
    };

    const req = {
      body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'Calculate 1+1' }], tools: [openaiTool] },
      headers: {}
    };

    const json = vi.fn();
    const res = { setHeader: vi.fn(), write: vi.fn(), end: vi.fn(), flushHeaders: vi.fn(), status: vi.fn().mockReturnThis(), json };

    await server.handleChatCompletion(req, res);

    // Cohere payload should include converted tools
    expect(capturedPayload).toBeDefined();
    expect(Array.isArray(capturedPayload.tools)).toBe(true);
    expect(capturedPayload.tools[0].name).toBe('do_math');
    // Parameter type mapping: number -> float
    expect(capturedPayload.tools[0].parameter_definitions).toHaveProperty('x');
    expect(capturedPayload.tools[0].parameter_definitions.x.type).toBe('float');

    // Response was sent
    expect(json).toHaveBeenCalled();
    const result = json.mock.calls[0][0];
    expect(result.model).toBe('cohere/command-r-08-2024');
  });

  it('strips tools when resolved Cohere model does NOT support tools (gpt-4o -> command-a-vision-07-2025)', async () => {
    process.env.COHERE_MODEL = 'command-a-vision-07-2025'; // non-tool

    const server = new EnhancedCohereRAGServer({ port: 0 });

    let capturedPayload;
    server.cohere = {
      chat: vi.fn().mockImplementation(async (payload) => {
        capturedPayload = payload;
        return { body: { message: { content: 'ok' } } };
      })
    };

    server.conversationManager = {
      addMessage: vi.fn(),
      getFormattedHistoryWithRAG: vi.fn().mockReturnValue({ message: 'user input', chatHistory: [], preamble: '' }),
      getStats: vi.fn().mockReturnValue({}),
      conversations: new Map()
    };
    server.generateId = vi.fn().mockReturnValue('sess2');

    const openaiTool = {
      function: { name: 'do_image', description: 'returns image' }
    };

    const req = {
      body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'Analyze image' }], tools: [openaiTool] },
      headers: {}
    };

    const json = vi.fn();
    const res = { setHeader: vi.fn(), write: vi.fn(), end: vi.fn(), flushHeaders: vi.fn(), status: vi.fn().mockReturnThis(), json };

    await server.handleChatCompletion(req, res);

    expect(capturedPayload).toBeDefined();
    // Tools should not be sent to Cohere when model doesn't support tools
    expect(capturedPayload.tools).toBeUndefined();

    expect(json).toHaveBeenCalled();
    const result = json.mock.calls[0][0];
    expect(result.model).toBe('cohere/command-a-vision-07-2025');
  });
});
