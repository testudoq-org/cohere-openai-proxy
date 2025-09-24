import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockCohereCtor, mockCohereModule } from './utils/cohereClient.mjs';

describe('Cohere client factory - edge cases', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.COHERE_V2_STREAMING_SUPPORTED = 'true';
    try { import('prom-client').then((pc) => pc.register.clear()).catch(() => {}); } catch (e) {}
  });

  afterEach(() => {
    delete process.env.COHERE_V2_STREAMING_SUPPORTED;
    vi.restoreAllMocks();
  });

  it('continues constructor attempts when logger.warn throws', async () => {
    // Constructor throws when opts.agent provided, succeeds for httpsAgent
    const mockCtor = createMockCohereCtor((opts) => {
      if (opts && opts.agent) throw new Error('agent not supported');
      // return a simple client when httpsAgent or none
      return { chat: async () => ({ ok: true }) };
    });
    mockCohereModule(mockCtor);

    // Logger whose warn throws to hit the inner catch branch
    const explodingLogger = {
      warn: () => { throw new Error('logger explosion'); }
    };

    const { createCohereClient } = await import('../src/utils/cohereClientFactory.mjs');
    const { acceptedAgentOption } = await createCohereClient({ token: 'x', agentOptions: {}, logger: explodingLogger });
    // First attempt fails (agent), second attempt should succeed (httpsAgent)
    expect(acceptedAgentOption).toBe('httpsAgent');
  });

  it('falls back when payload spread throws and when JSON.stringify for cache key throws', async () => {
    const mockChat = vi.fn(async (payload) => {
      // echo back payload so tests can assert behaviour
      return { ok: true, payload };
    });
    const mockCtor = createMockCohereCtor(() => ({ chat: mockChat }));
    mockCohereModule(mockCtor);

    const { createCohereClient } = await import('../src/utils/cohereClientFactory.mjs');
    const { client } = await createCohereClient({ token: 'x', agentOptions: {}, logger: console });

    // 1) Make a payload where spreading p will throw (ownKeys trap throws)
    const badSpread = new Proxy({}, {
      ownKeys() { throw new Error('boom-ownKeys'); }
    });
    const res1 = await client.chat(badSpread);
    expect(res1).toHaveProperty('payload');
    // When spread failed, client should have used original sdkArgs (so mockChat called).
    expect(mockChat).toHaveBeenCalled();

    // 2) Make a circular message so JSON.stringify throws when building cache key,
    //    this should fall back and still call the underlying SDK.
    const circular = {};
    circular.self = circular;
    const res2 = await client.chat({ message: circular });
    expect(res2).toHaveProperty('payload');
    // underlying chat called again
    expect(mockChat).toHaveBeenCalled();

    // 3) Accessing model property may throw when determining labels - ensure we handle it
    const badModel = new Proxy({ model: 'm' }, {
      get(target, prop) {
        if (prop === 'model') throw new Error('boom-get');
        return target[prop];
      }
    });
    const res3 = await client.chat(badModel);
    expect(res3).toHaveProperty('payload');
  });
});