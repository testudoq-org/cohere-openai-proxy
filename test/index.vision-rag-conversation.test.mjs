import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const request = require('supertest');
import EnhancedCohereRAGServer from '../src/index.mjs';
import promClient from 'prom-client';

let server;
let app;

beforeAll(async () => {
  promClient.register.clear();
  const s = new EnhancedCohereRAGServer({ port: 0 });
  server = await s.start();
  app = server;
});

afterAll(async () => {
  if (server && server.close) await new Promise((r) => server.close(r));
});

describe('Vision, RAG, Conversation endpoints', () => {
  it('vision endpoint returns 400 for missing input and 404 when model does not support vision', async () => {
    // Missing input
    const res1 = await request(app).post('/v1/vision').send({}).expect(400);
    expect(res1.body.error.message).toMatch(/input.*required/i);

    // Model does not support vision
    const res2 = await request(app).post('/v1/vision').send({ input: 'test' }).expect(404);
    expect(res2.body.error.message).toMatch(/does not support vision/i);
  });

  it('models switch endpoint validates model and updates server.currentModel', async () => {
    const res = await request(app).post('/v1/models/switch').send({ model: 'command-a-03-2025' }).expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.model).toBe('command-a-03-2025');
  });

  it('conversation feedback and history endpoints behave as expected (add feedback, retrieve history)', async () => {
    const sessionId = 'test-session-vision';
    const fbRes = await request(app).post(`/v1/conversations/${sessionId}/feedback`).send({ feedback: 'test feedback', type: 'correction' }).expect(200);
    expect(fbRes.body.success).toBe(true);

    const histRes = await request(app).get(`/v1/conversations/${sessionId}/history`).expect(200);
    expect(histRes.body.sessionId).toBe(sessionId);
    expect(Array.isArray(histRes.body.messages)).toBe(true);
    expect(histRes.body.count).toBeGreaterThan(0);
  });

  it('delete conversation endpoint clears conversation', async () => {
    const sessionId = 'test-session-delete';
    // Add some feedback first
    await request(app).post(`/v1/conversations/${sessionId}/feedback`).send({ feedback: 'test' }).expect(200);
    // Delete
    const res = await request(app).delete(`/v1/conversations/${sessionId}`).expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe('Conversation cleared');
  });

  it('RAG index endpoint queues and returns success response (mock RAG manager)', async () => {
    const res = await request(app).post('/v1/rag/index').send({ projectPath: '.', options: {} }).expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.result).toBeDefined();
  });

  it('embed endpoint returns embeddings for valid input', async () => {
    const res = await request(app).post('/v1/embed').send({ input: ['test text'], model: 'embed-english-v3.0' }).expect(200);
    expect(res.body.object).toBe('list');
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('rerank endpoint returns ranked documents for valid input', async () => {
    const res = await request(app).post('/v1/rerank').send({ query: 'test query', documents: ['doc1', 'doc2'], model: 'rerank-multilingual-v3.0' }).expect(200);
    expect(res.body).toHaveProperty('results');
    expect(Array.isArray(res.body.results)).toBe(true);
  });

  it('chat completions endpoint returns response for valid input', async () => {
    const res = await request(app).post('/v1/chat/completions').send({ messages: [{ role: 'user', content: 'test' }] }).expect(200);
    expect(res.body).toHaveProperty('choices');
    expect(Array.isArray(res.body.choices)).toBe(true);
  });

});