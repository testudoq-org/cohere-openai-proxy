import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Models config and validation', () => {
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

  it('getModelsList returns fallback when models-config missing', async () => {
    // Mock fs.readFileSync to throw (simulate missing file)
    vi.doMock('fs', () => ({
      readFileSync: vi.fn(() => { throw new Error('ENOENT'); })
    }));

    const { getModelsList } = await import('../src/utils/cohereClientFactory.mjs');
    const models = getModelsList();
    expect(models).toEqual([
      { id: 'command-a-03-2025', type: 'generation', languages: ['en'], ttlMs: 120000 },
      { id: 'command-r-plus-08-2024', type: 'generation', languages: ['en'], ttlMs: 120000 },
      { id: 'embed-english-v3.0', type: 'embed', languages: ['en'], ttlMs: 600000 },
      { id: 'embed-multilingual-v3.0', type: 'embed', languages: ['en'], ttlMs: 600000 },
      { id: 'rerank-multilingual-v3.0', type: 'rerank', languages: ['en'], ttlMs: 600000 },
      { id: 'command-a-vision-07-2025', type: 'vision', languages: ['en'], ttlMs: 600000 }
    ]);
  });

  it('validateModelOrThrow rejects unknown model and modality mismatch', async () => {
    const { validateModelOrThrow } = await import('../src/utils/cohereClientFactory.mjs');

    // Unknown model
    expect(() => validateModelOrThrow('unknown-model')).toThrow('Invalid model: unknown-model');

    // Modality mismatch
    expect(() => validateModelOrThrow('command-a-03-2025', 'embed')).toThrow('Model command-a-03-2025 does not support embed');
  });
});

it('validateModelOrThrow rejects missing modelId with 400', async () => {
  const { validateModelOrThrow } = await import('../src/utils/cohereClientFactory.mjs');
  expect(() => validateModelOrThrow()).toThrow('Model is required');
});