import { vi, beforeEach, afterEach } from 'vitest';

// Default lightweight fake Cohere client used when tests don't override it.
const defaultFake = {
  chat: vi.fn(async (payload) => ({ body: { message: { content: 'ok' }, text: 'ok' } })),
  embed: vi.fn(async ({ texts }) => ({ body: { embeddings: texts.map(() => [0, 0, 0]) } })),
  rerank: vi.fn(async ({ documents, query, top_n } = {}) => ({ body: { results: (documents || []).slice(0, top_n || documents.length) } })),
  models: {
    list: vi.fn(async () => ({ body: { models: [ { id: process.env.COHERE_MODEL || 'command-a-vision-07-2025' } ] } }))
  }
};

// Expose a global override object tests can set to customize client behavior per-test.
// Example in a test: globalThis.__TEST_COHERE_CLIENT = { chat: async () => ({ body: { text: 'ok' }}) };
vi.stubGlobal('__TEST_COHERE_CLIENT', null);

// Mock the Cohere SDK export used by our code (CohereClient constructor)
vi.mock('cohere-ai', () => {
  return {
    CohereClient: function CohereClient(opts) {
      // If a test provided an override, return that object directly (useful for custom behavior)
      if (globalThis.__TEST_COHERE_CLIENT) return globalThis.__TEST_COHERE_CLIENT;
      // Otherwise return the shared default fake client
      return defaultFake;
    }
  };
});

// Clear overrides between tests to avoid leakage
beforeEach(() => {
  globalThis.__TEST_COHERE_CLIENT = null;
});

afterEach(() => {
  // reset mocks on the default fake so tests get a fresh spy state
  try {
    defaultFake.chat.mockReset?.();
    defaultFake.embed.mockReset?.();
    defaultFake.models.list.mockReset?.();
  } catch (e) { /* ignore */ }
});