import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Cohere client construction', () => {
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

  it('constructs CohereClient with agent option if supported', async () => {
    const mockCtor = vi.fn((opts) => ({ opts }));
    // doMock is not hoisted so can reference mockCtor directly
    vi.doMock('cohere-ai', () => ({ CohereClient: mockCtor }), { virtual: true });

    const { default: Enhanced } = await import('../src/index.mjs');
    const s = new Enhanced({ port: 0 });
    expect(mockCtor.mock.calls.length).toBeGreaterThanOrEqual(1);
    const calledWith = mockCtor.mock.calls[0][0] || {};
    const hasAgent = !!(calledWith.agent || calledWith.httpsAgent);
    expect(hasAgent).toBe(true);
  });

  it('falls back safely when agent option not accepted', async () => {
    const mockCtor = vi.fn((opts) => {
      if (opts && (opts.agent || opts.httpsAgent)) throw new Error('agent not supported');
      return { opts };
    });
    vi.doMock('cohere-ai', () => ({ CohereClient: mockCtor }), { virtual: true });

    const { default: Enhanced } = await import('../src/index.mjs');
    const s = new Enhanced({ port: 0 });
    expect(mockCtor.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
