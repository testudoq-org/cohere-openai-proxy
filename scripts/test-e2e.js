#!/usr/bin/env node
// scripts/test-e2e.js
// Simple end-to-end smoke test for local server: embed + chat
// Usage: BASE_URL=http://localhost:3000 CHAT_MODEL=coherelab-cohere node scripts/test-e2e.js

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const CHAT_MODEL_RAW = process.env.CHAT_MODEL || 'coherelab-cohere';
// Map friendly agent name to a valid Cohere model id used by this test harness
const CHAT_MODEL = (CHAT_MODEL_RAW === 'coherelab-cohere') ? 'command-a-03-2025' : CHAT_MODEL_RAW;
const EMBED_MODEL = process.env.EMBED_MODEL || 'embed-english-v3.0';

async function fetchJson(path, body, maxRetries = 5) {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const text = await res.text();

      if (res.status === 429 && attempt <= maxRetries) {
        const wait = Math.pow(2, attempt) * 100 + Math.floor(Math.random() * 100);
        console.warn(`429 Too Many Requests for ${path} — retrying in ${wait}ms (attempt ${attempt})`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }

      if (res.status >= 400) {
        console.error(`Request to ${path} failed with status ${res.status}`);
        console.error(text);
        process.exit(2);
      }

      try {
        return JSON.parse(text);
      } catch (e) {
        // fallback to raw text if not JSON
        return text;
      }
    } catch (err) {
      if (attempt <= maxRetries) {
        const wait = Math.pow(2, attempt) * 100;
        console.warn(`Network error, retrying in ${wait}ms (attempt ${attempt}):`, err.message);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      console.error('Network error (max retries reached):', err);
      process.exit(3);
    }
  }
}

(async () => {
  console.log('E2E test starting — base:', BASE);
  console.log('Using chat model:', CHAT_MODEL_RAW, '->', CHAT_MODEL);

  // Embed test
  console.log('-> Testing /v1/embed');
  const embedBody = { input: 'test embedding from e2e', model: EMBED_MODEL };
  const embedResp = await fetchJson('/v1/embed', embedBody);
  console.log('Embed response OK — snippet:', JSON.stringify(embedResp).slice(0, 500));

  // Chat test
  console.log('-> Testing /chat/completions');
  const chatBody = {
    model: CHAT_MODEL,
    messages: [{ role: 'user', content: 'What is a firewall?' }],
  };
  const chatResp = await fetchJson('/chat/completions', chatBody);
  console.log('Chat response OK — snippet:', JSON.stringify(chatResp).slice(0, 1000));

  console.log('E2E tests passed');
  process.exit(0);
})();
