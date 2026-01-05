import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const request = require('supertest');
import promClient from 'prom-client';
import { createMockCohereCtor, mockCohereModule } from './utils/cohereClient.mjs';

let server;
let app;
let addr;
let EnhancedCohereRAGServer;
let defaultMockCtor;

beforeAll(async () => {
  // Clear prom-client registry to avoid metric re-registration across test runs
  promClient.register.clear();
  // Default mock Cohere client: returns an embedding for any input
  defaultMockCtor = createMockCohereCtor(() => ({
    embed: async ({ texts, text }) => {
      const count = (texts || (text ? [text] : [])).length || 1;
      const embeddings = Array.from({ length: count }, () => [0.1, 0.2, 0.3]);
      return { body: { embeddings } };
    },
    rerank: async ({ documents, top_n = null }) => {
      const docs = documents || [];
      const results = docs.map((d, i) => ({ index: i, relevance_score: 1 / (i + 1) }));
      // sort descending by relevance_score
      results.sort((a, b) => b.relevance_score - a.relevance_score);
      return { body: { results: (top_n ? results.slice(0, top_n) : results) } };
    },
    chat: async () => ({ text: 'ok' }),
  }));
  mockCohereModule(defaultMockCtor);

  // Import server after mocking Cohere so the mocked module is used
  ({ default: EnhancedCohereRAGServer } = await import('../src/index.mjs'));
  const s = new EnhancedCohereRAGServer({ port: 0 });
  server = await s.start();
  app = server;
  addr = server.address();
});

afterAll(async () => {
  if (server && server.close) await new Promise((r) => server.close(r));
});

describe('Embeddings and Reranking endpoints', () => {
  describe('/v1/embed', () => {
    it('generates embeddings for text input', async () => {
      const res = await request(app)
        .post('/v1/embed')
        .send({
          input: ['Hello world', 'How are you?'],
          model: 'embed-english-v3.0'
        })
        .expect(200);
      expect(res.body.object).toBe('list');
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data[0]).toHaveProperty('embedding');
      expect(Array.isArray(res.body.data[0].embedding)).toBe(true);
    });

    it('handles single string input', async () => {
      const res = await request(app)
        .post('/v1/embed')
        .send({
          input: 'Single text input',
          model: 'embed-english-v3.0'
        })
        .expect(200);
      expect(res.body.data).toHaveLength(1);
    });

    it('handles 429 Too Many Requests with retry/backoff and eventually returns embedding', async () => {
      // Arrange: mock CohereClient.embed to fail with 429 twice, then succeed
      let callCount = 0;
      const embeddingPayload = { body: { embeddings: [[0.1, 0.2, 0.3]] } };
      const mockEmbed = vi.fn(async () => {
        callCount++;
        if (callCount <= 2) {
          const err = new Error('TooManyRequestsError');
          // SDK may set status or statusCode
          err.status = 429;
          err.statusCode = 429;
          throw err;
        }
        return embeddingPayload;
      });
      const MockCohereCtor = createMockCohereCtor(() => ({ embed: mockEmbed }));
      mockCohereModule(MockCohereCtor);

      // Close existing server, clear prom-client registry and reset module cache so the new mock is used
      if (server && server.close) await new Promise((r) => server.close(r));
      promClient.register.clear();
      vi.resetModules();

      // re-register the mock so import picks it up
      mockCohereModule(MockCohereCtor);
      ({ default: EnhancedCohereRAGServer } = await import('../src/index.mjs'));

      const s = new EnhancedCohereRAGServer({ port: 0 });
      server = await s.start();
      app = server;

      // Act
      const res = await request(app)
        .post('/v1/embed')
        .send({
          input: ['retry test'],
          model: 'embed-english-v3.0'
        })
        .expect(200);
      // Assert
      expect(res.body.object).toBe('list');
      expect(res.body.data[0]).toHaveProperty('embedding');
      expect(Array.isArray(res.body.data[0].embedding)).toBe(true);
      expect(callCount).toBeGreaterThanOrEqual(3);

      // Restore default server instance for subsequent tests
      if (server && server.close) await new Promise((r) => server.close(r));
      promClient.register.clear();
      vi.resetModules();
      mockCohereModule(defaultMockCtor);
      ({ default: EnhancedCohereRAGServer } = await import('../src/index.mjs'));
      const s2 = new EnhancedCohereRAGServer({ port: 0 });
      server = await s2.start();
      app = server;
    });

    it('rejects invalid model for embeddings', async () => {
      const res = await request(app)
        .post('/v1/embed')
        .send({
          input: ['test'],
          model: 'invalid-embed-model'
        })
        .expect(400);
      expect(res.body.error.message).toMatch(/invalid.*model/i);
    });

    it('rejects empty input array', async () => {
      const res = await request(app)
        .post('/v1/embed')
        .send({
          input: [],
          model: 'embed-english-v3.0'
        })
        .expect(400);
      expect(res.body.error.message).toMatch(/input.*required/i);
    });
  });

  describe('/v1/rerank', () => {
    it('reranks documents based on query', async () => {
      const res = await request(app)
        .post('/v1/rerank')
        .send({
          query: 'What is machine learning?',
          documents: [
            'Machine learning is a subset of AI',
            'The weather is nice today',
            'Deep learning uses neural networks'
          ],
          model: 'rerank-multilingual-v3.0'
        })
        .expect(200);
      expect(res.body.object).toBe('list');
      expect(Array.isArray(res.body.results)).toBe(true);
      expect(res.body.results[0]).toHaveProperty('index');
      expect(res.body.results[0]).toHaveProperty('relevance_score');
    });

    it('rejects invalid rerank model', async () => {
      const res = await request(app)
        .post('/v1/rerank')
        .send({
          query: 'test query',
          documents: ['doc1', 'doc2'],
          model: 'invalid-rerank-model'
        })
        .expect(400);
      expect(res.body.error.message).toMatch(/invalid.*model/i);
    });

    it('rejects missing documents', async () => {
      const res = await request(app)
        .post('/v1/rerank')
        .send({
          query: 'test query',
          model: 'rerank-multilingual-v3.0'
        })
        .expect(400);
      expect(res.body.error.message).toMatch(/documents.*required/i);
    });

    it('handles top_n parameter', async () => {
      const res = await request(app)
        .post('/v1/rerank')
        .send({
          query: 'test',
          documents: ['doc1', 'doc2', 'doc3', 'doc4'],
          model: 'rerank-multilingual-v3.0',
          top_n: 2
        })
        .expect(200);
      expect(res.body.results).toHaveLength(2);
    });
  });
});
