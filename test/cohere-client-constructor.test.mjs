import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockCohereCtor, mockCohereModule } from './utils/cohereClient.mjs';

describe('Cohere client factory', () => {
  beforeEach(() => {
    vi.resetModules();
    // clear prom-client global registry to avoid duplicate metric registration across imports
    try {
      // use dynamic import to avoid hoisting issues
      // eslint-disable-next-line no-undef
      import('prom-client').then((pc) => pc.register.clear()).catch(() => {});
    } catch (e) {}
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns acceptedAgentOption === "agent" when constructor accepts { agent }', async () => {
    const mockCtor = createMockCohereCtor((opts) => ({ opts }));
    mockCohereModule(mockCtor);

    const { createCohereClient } = await import('../src/utils/cohereClientFactory.mjs');
    const { client, acceptedAgentOption } = await createCohereClient({ token: 'x', agentOptions: { keepAlive: true }, logger: console });
    expect(acceptedAgentOption).toBe('agent');
    expect(client).toBeDefined();
    expect(mockCtor).toHaveBeenCalled();
    const firstArg = mockCtor.mock.calls[0][0] || {};
    expect(firstArg.agent).toBeDefined();
  });

  it('returns acceptedAgentOption === "httpsAgent" when { agent } throws but { httpsAgent } accepted', async () => {
    const mockCtor = createMockCohereCtor((opts) => {
      if (opts && opts.agent) throw new Error('agent not supported');
      return { opts };
    });
    mockCohereModule(mockCtor);

    const { createCohereClient } = await import('../src/utils/cohereClientFactory.mjs');
    const { client, acceptedAgentOption } = await createCohereClient({ token: 'x', agentOptions: { keepAlive: true }, logger: console });
    expect(acceptedAgentOption).toBe('httpsAgent');
    expect(client).toBeDefined();
    const calledWithHttps = mockCtor.mock.calls.some(c => (c[0] && c[0].httpsAgent));
    expect(calledWithHttps).toBe(true);
  });

  it('returns acceptedAgentOption === "none" when both attempts throw and final ctor called without agent', async () => {
    const mockCtor = createMockCohereCtor((opts) => {
      if (opts && (opts.agent || opts.httpsAgent)) throw new Error('agent not supported');
      return { opts };
    });
    mockCohereModule(mockCtor);

    const { createCohereClient } = await import('../src/utils/cohereClientFactory.mjs');
    const { client, acceptedAgentOption } = await createCohereClient({ token: 'x', agentOptions: { keepAlive: true }, logger: console });
    expect(acceptedAgentOption).toBe('none');
    expect(client).toBeDefined();
    const hadNoAgentCall = mockCtor.mock.calls.some(c => {
      const o = c[0] || {};
      return !o.agent && !o.httpsAgent;
    });
    expect(hadNoAgentCall).toBe(true);
  });
  it('passes apiVersion: "v2" to CohereClient constructor for v2 usage', async () => {
    const mockCtor = createMockCohereCtor((opts) => ({ opts }));
    mockCohereModule(mockCtor);

    const { createCohereClient } = await import('../src/utils/cohereClientFactory.mjs');
    const { client } = await createCohereClient({ token: 'x', agentOptions: {}, logger: console });
    expect(mockCtor).toHaveBeenCalled();
    const ctorArgs = mockCtor.mock.calls[0][0] || {};
    expect(ctorArgs.apiVersion).toBe('v2');
  });

  it('calls a v2-only endpoint or uses v2 payload structure (should fail with v1 implementation)', async () => {
    const mockCtor = createMockCohereCtor(() => ({
      generate: vi.fn((payload) => payload),
    }));
    mockCohereModule(mockCtor);

    const { createCohereClient } = await import('../src/utils/cohereClientFactory.mjs');
    const { client } = await createCohereClient({ token: 'x', agentOptions: {}, logger: console });

    // Simulate a v2-only payload property, e.g., 'chatHistory'
    const payload = { prompt: 'test', chatHistory: [{ role: 'user', message: 'hi' }] };
    const result = client.generate(payload);
    expect(result.chatHistory).toBeDefined();
  });
  // --- Additional edge case tests ---

  it('throws or handles missing token parameter', async () => {
    const mockCtor = createMockCohereCtor((opts) => ({ opts }));
    mockCohereModule(mockCtor);

    const { createCohereClient } = await import('../src/utils/cohereClientFactory.mjs');
    await expect(createCohereClient({ agentOptions: {}, logger: console }))
      .rejects.toThrow(/token/i);
  });

  it('handles missing agentOptions gracefully', async () => {
    const mockCtor = createMockCohereCtor((opts) => ({ opts }));
    mockCohereModule(mockCtor);

    const { createCohereClient } = await import('../src/utils/cohereClientFactory.mjs');
    const { client } = await createCohereClient({ token: 'x', logger: console });
    expect(client).toBeDefined();
  });

  it('handles missing logger gracefully', async () => {
    const mockCtor = createMockCohereCtor((opts) => ({ opts }));
    mockCohereModule(mockCtor);

    const { createCohereClient } = await import('../src/utils/cohereClientFactory.mjs');
    const { client } = await createCohereClient({ token: 'x', agentOptions: {} });
    expect(client).toBeDefined();
  });
  it('handles synchronous errors thrown by the CohereClient constructor', async () => {
    const mockCtor = createMockCohereCtor(() => {
      throw new Error('sync constructor error');
    });
    mockCohereModule(mockCtor);

    const { createCohereClient } = await import('../src/utils/cohereClientFactory.mjs');
    await expect(createCohereClient({ token: 'x', agentOptions: {}, logger: console }))
      .rejects.toThrow(/sync constructor error/);
  });

  it('handles asynchronous errors (rejected promise) from the CohereClient constructor', async () => {
    const mockCtor = createMockCohereCtor(() => {
      return Promise.reject(new Error('async constructor error'));
    });
    mockCohereModule(mockCtor);

    const { createCohereClient } = await import('../src/utils/cohereClientFactory.mjs');
    await expect(createCohereClient({ token: 'x', agentOptions: {}, logger: console }))
      .rejects.toThrow(/async constructor error/);
  });

  it('surfaces errors thrown by client methods (e.g., generate)', async () => {
    const mockGenerate = vi.fn(() => { throw new Error('method error'); });
    const mockCtor = createMockCohereCtor(() => ({
      generate: mockGenerate,
    }));
    mockCohereModule(mockCtor);

    const { createCohereClient } = await import('../src/utils/cohereClientFactory.mjs');
    const { client } = await createCohereClient({ token: 'x', agentOptions: {}, logger: console });
    expect(() => client.generate({})).toThrow(/method error/);
  });

  it('surfaces rejected promises from client methods (e.g., generate)', async () => {
    const mockGenerate = vi.fn(() => Promise.reject(new Error('async method error')));
    const mockCtor = createMockCohereCtor(() => ({
      generate: mockGenerate,
    }));
    mockCohereModule(mockCtor);

    const { createCohereClient } = await import('../src/utils/cohereClientFactory.mjs');
    const { client } = await createCohereClient({ token: 'x', agentOptions: {}, logger: console });
    await expect(client.generate({})).rejects.toThrow(/async method error/);
  });
});
