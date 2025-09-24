import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockCohereCtor, mockCohereModule } from './utils/cohereClient.mjs';

describe('Cohere client factory - primitive property passthrough', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns primitive properties unchanged from wrapped client', async () => {
    // Mock constructor returning an object with a primitive property + chat fn
    const rawClient = {
      version: 'v1.2.3',
      chat: vi.fn(async () => ({ text: 'ok' }))
    };
    const ctor = createMockCohereCtor(() => rawClient);
    mockCohereModule(ctor);

    // Import after mocking to ensure module uses our mock
    const { createCohereClient } = await import('../src/utils/cohereClientFactory.mjs');

    const { client } = await createCohereClient({ token: 'tok' });
    // Accessing a primitive property should return it unchanged (exercise wrapValue return branch)
    expect(client.version).toBe('v1.2.3');

    // Also ensure function properties are still callable
    const res = await client.chat({ model: 'command-a-03-2025', message: 'hi' });
    expect(res).toEqual({ text: 'ok' });
    expect(rawClient.chat).toHaveBeenCalled();
  });
});