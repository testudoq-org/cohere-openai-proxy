import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const request = require('supertest');

import EnhancedCohereRAGServer from '../src/index.mjs';

let server;
let app;
let serverInstance;

beforeAll(async () => {
  vi.resetModules();
  const s = new EnhancedCohereRAGServer({ port: 0 });
  serverInstance = s; // keep the server instance available for tests that need internals
  server = await s.start();
  app = server;
});

afterAll(async () => {
  if (server && server.close) await new Promise((r) => server.close(r));
});

describe('RAG preamble sanitization', () => {
  it('strips tool-like XML from preamble for non-tool-capable models', async () => {
    const sessionId = 'sanitize-test-session';

    // Prepopulate a session with RAG docs containing tool-like examples
    const cm = serverInstance.conversationManager;
    cm.getConversation(sessionId); // ensure session exists
    const session = cm.conversations.get(sessionId);
    session.ragContext = [
      { content: 'Useful doc', metadata: { filePath: 'doc1' }, score: 0.9 },
      { content: '<execute_command>\n<command>[REDACTED_COMMAND]</command>\n</execute_command>', metadata: { filePath: 'doc2' }, score: 0.8 }
    ];

    // Ensure RAG retrieval returns the session.ragContext (prevent addMessage overwriting it)
    serverInstance.conversationManager.ragManager = { retrieveRelevantDocuments: async () => session.ragContext };

    // Mock Cohere client to capture payload
    const captured = { payload: null };
    serverInstance.cohere = { chat: vi.fn().mockImplementation(async (payload) => { captured.payload = payload; return { body: { text: 'ok' } }; }) };

    const res = await request(app)
      .post('/v1/chat/completions')
      .send({ sessionId, model: 'command-a-vision-07-2025', messages: [{ role: 'user', content: 'What is a firewall?' }] })
      .expect(200);

    expect(captured.payload).toBeDefined();
    const preamble = captured.payload.preamble || '';
    expect(preamble).not.toContain('<execute_command>');
    expect(preamble).toContain('[REDACTED');
  });
});