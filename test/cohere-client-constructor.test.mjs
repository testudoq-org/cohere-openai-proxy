import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
    const mockCtor = vi.fn((opts) => ({ opts }));
    vi.doMock('cohere-ai', () => ({ CohereClient: mockCtor }), { virtual: true });

    const { createCohereClient } = await import('../src/utils/cohereClientFactory.mjs');
    const { client, acceptedAgentOption } = await createCohereClient({ token: 'x', agentOptions: { keepAlive: true }, logger: console });
    expect(acceptedAgentOption).toBe('agent');
    expect(client).toBeDefined();
    expect(mockCtor).toHaveBeenCalled();
    const firstArg = mockCtor.mock.calls[0][0] || {};
    expect(firstArg.agent).toBeDefined();
  });

  it('returns acceptedAgentOption === "httpsAgent" when { agent } throws but { httpsAgent } accepted', async () => {
    const mockCtor = vi.fn((opts) => {
      if (opts && opts.agent) throw new Error('agent not supported');
      return { opts };
    });
    vi.doMock('cohere-ai', () => ({ CohereClient: mockCtor }), { virtual: true });

    const { createCohereClient } = await import('../src/utils/cohereClientFactory.mjs');
    const { client, acceptedAgentOption } = await createCohereClient({ token: 'x', agentOptions: { keepAlive: true }, logger: console });
    expect(acceptedAgentOption).toBe('httpsAgent');
    expect(client).toBeDefined();
    const calledWithHttps = mockCtor.mock.calls.some(c => (c[0] && c[0].httpsAgent));
    expect(calledWithHttps).toBe(true);
  });

  it('returns acceptedAgentOption === "none" when both attempts throw and final ctor called without agent', async () => {
    const mockCtor = vi.fn((opts) => {
      if (opts && (opts.agent || opts.httpsAgent)) throw new Error('agent not supported');
      return { opts };
    });
    vi.doMock('cohere-ai', () => ({ CohereClient: mockCtor }), { virtual: true });

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
});
