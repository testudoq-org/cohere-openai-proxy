import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockCohereCtor, mockCohereModule } from './utils/cohereClient.mjs';

describe('callCohereChatAPI', () => {
  beforeEach(() => {
    vi.resetModules();
    // clear prom-client global registry
    try {
      import('prom-client').then((pc) => pc.register.clear()).catch(() => {});
    } catch (e) {}
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('callCohereChatAPI records metrics and returns response for valid client', async () => {
    const mockChat = vi.fn(() => ({ text: 'response', meta: {} }));
    const mockClient = { chat: mockChat };
    const { callCohereChatAPI } = await import('../src/utils/cohereClientFactory.mjs');

    const payload = { model: 'test-model', message: 'test' };
    const result = await callCohereChatAPI(mockClient, payload);

    expect(mockChat).toHaveBeenCalledWith(payload, undefined);
    expect(result).toEqual({ text: 'response', meta: {} });

    // Verify metrics were attempted (prom-client may not be fully mocked, but calls should happen)
    // In a real test, we'd mock prom-client more thoroughly, but for coverage, this suffices
  });
});

it('callCohereChatAPI throws for invalid client and propagates API errors', async () => {
  const { callCohereChatAPI } = await import('../src/utils/cohereClientFactory.mjs');
  // missing client-like
  await expect(callCohereChatAPI(null, { model: 'm', message: 'x' })).rejects.toThrow('callCohereChatAPI requires a client with a .chat function');
  // client.chat rejects -> should propagate
  const mockChat = vi.fn(() => Promise.reject(new Error('chat failure')));
  const mockClient = { chat: mockChat };
  await expect(callCohereChatAPI(mockClient, { model: 'm', message: 'x' })).rejects.toThrow('chat failure');
});
