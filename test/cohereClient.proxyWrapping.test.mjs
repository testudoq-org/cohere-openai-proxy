import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockCohereCtor, mockCohereModule } from './utils/cohereClient.mjs';

describe('Client proxy wrapping', () => {
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

  it('wraps nested client objects and preserves proxy traps', async () => {
    const mockNestedMethod = vi.fn(() => 'nested result');
    const mockCtor = createMockCohereCtor(() => ({
      models: {
        list: mockNestedMethod
      }
    }));
    mockCohereModule(mockCtor);

    const { createCohereClient } = await import('../src/utils/cohereClientFactory.mjs');
    const { client } = await createCohereClient({ token: 'x', agentOptions: {}, logger: console });

    // Access nested property
    const result = client.models.list();
    expect(mockNestedMethod).toHaveBeenCalled();
    expect(result).toBe('nested result');

    // Test proxy traps
    expect('models' in client).toBe(true);
    expect(Object.keys(client)).toContain('models');
  });

  it('overrides retry options when provided in last arg', async () => {
    const mockChat = vi.fn(() => ({ text: 'response' }));
    const mockCtor = createMockCohereCtor(() => ({
      chat: mockChat
    }));
    mockCohereModule(mockCtor);

    const { createCohereClient } = await import('../src/utils/cohereClientFactory.mjs');
    const { client } = await createCohereClient({ token: 'x', agentOptions: {}, logger: console });

    // Call with override options
    const result = client.chat({ message: 'test' }, { maxAttempts: 5 });
    expect(mockChat).toHaveBeenCalledWith({ message: 'test' });
    expect(result).toEqual({ text: 'response' });
    // The retry logic is internal, but the call should succeed
  });


});