import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const request = require('supertest');
import EnhancedCohereRAGServer from '../src/index.mjs';

let server;
let app;
let addr;

beforeAll(async () => {
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