import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
  // supertest accepts an http.Server
  app = server;
  addr = server.address();
});

afterAll(async () => {
  if (server && server.close) await new Promise((r) => server.close(r));
});

describe('HTTP endpoints', () => {
  it('responds to /health', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.body.status).toBe('healthy');
  });

  it('queues a rag index job', async () => {
    const res = await request(app).post('/v1/rag/index').send({ projectPath: '.' }).expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.result.jobId).toBeDefined();
  });

  it('adds feedback and reads history', async () => {
    const sessionId = 'test-session-1';
    const fb = await request(app).post(`/v1/conversations/${sessionId}/feedback`).send({ feedback: 'test feedback' }).expect(200);
    expect(fb.body.success).toBe(true);

    const hist = await request(app).get(`/v1/conversations/${sessionId}/history`).expect(200);
    expect(hist.body.sessionId).toBe(sessionId);
    expect(Array.isArray(hist.body.messages)).toBe(true);
  });
});
