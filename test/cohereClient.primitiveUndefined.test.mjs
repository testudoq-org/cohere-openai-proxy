import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockCohereCtor, mockCohereModule } from './utils/cohereClient.mjs';

describe('Cohere client factory - return undefined for missing props', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accessing a non-existent property returns undefined (wrapValue fallthrough)', async () => {
    const rawClient = {
      chat: vi.fn(async () => ({ text: 'ok' })),
      version: 'v9.9.9'
    };
    const ctor = createMockCohereCtor(() => rawClient);
    mockCohereModule(ctor);

    const { createCohereClient } = await import('../src/utils/cohereClientFactory.mjs');
    const { client } = await createCohereClient({ token: 'tok' });

    // property that doesn't exist should be undefined and exercise the final 'return value' branch
    expect(client.nonExistentProperty).toBeUndefined();

    // sanity: existing primitive still returned
    expect(client.version).toBe('v9.9.9');

    // chat still works
    const res = await client.chat({ model: 'command-a-03-2025', message: 'hi' });
    expect(res).toEqual({ text: 'ok' });
    expect(rawClient.chat).toHaveBeenCalled();
  });
});