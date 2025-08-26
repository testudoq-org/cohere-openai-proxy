import { describe, it, expect, vi } from 'vitest';

describe('ConversationManager - batching', () => {
  it('batches prompts arriving within debounce window', async () => {
    vi.resetModules();
    process.env.PROMPT_BATCH_DELAY_MS = '100';
    process.env.PROMPT_MAX_BATCH_SIZE = '8';
    process.env.PROMPT_BATCH_QUEUE_LIMIT = '1000';

    const { default: ConversationManager } = await import('../src/conversationManager.mjs');

    const mockChat = vi.fn(async (payload) => ({ text: `echo:${payload.message}` }));
    const fakeRag = { cohere: { chat: mockChat }, retrieveRelevantDocuments: async () => [] };

    const cm = new ConversationManager(fakeRag, { logger: console });

    const N = 5;
    const promises = [];
    for (let i = 0; i < N; i++) {
      promises.push(cm.sendPrompt({ message: `p${i}` }));
    }

    const results = await Promise.all(promises);
    expect(mockChat).toHaveBeenCalledTimes(N);
    expect(results.map(r => r.text)).toEqual(Array.from({ length: N }).map((_, i) => `echo:p${i}`));
  });

  it('flushes immediately when max batch size reached', async () => {
    vi.resetModules();
    process.env.PROMPT_BATCH_DELAY_MS = '1000'; // large so debounce would not fire
    process.env.PROMPT_MAX_BATCH_SIZE = '3';
    process.env.PROMPT_BATCH_QUEUE_LIMIT = '1000';

    const { default: ConversationManager } = await import('../src/conversationManager.mjs');

    const mockChat = vi.fn(async (payload) => ({ text: `ok:${payload.message}` }));
    const fakeRag = { cohere: { chat: mockChat }, retrieveRelevantDocuments: async () => [] };
    const cm = new ConversationManager(fakeRag, { logger: console });

    const p1 = cm.sendPrompt({ message: 'a' });
    const p2 = cm.sendPrompt({ message: 'b' });
    const p3 = cm.sendPrompt({ message: 'c' });

    const results = await Promise.all([p1, p2, p3]);
    expect(mockChat).toHaveBeenCalledTimes(3);
    expect(results.map(r => r.text)).toEqual(['ok:a', 'ok:b', 'ok:c']);
  });

  it('queue rejects when limit exceeded', async () => {
    vi.resetModules();
    process.env.PROMPT_BATCH_DELAY_MS = '1000';
    process.env.PROMPT_MAX_BATCH_SIZE = '8';
    process.env.PROMPT_BATCH_QUEUE_LIMIT = '2';

    const { default: ConversationManager } = await import('../src/conversationManager.mjs');

    const mockChat = vi.fn(async (payload) => ({ text: `ok:${payload.message}` }));
    const fakeRag = { cohere: { chat: mockChat }, retrieveRelevantDocuments: async () => [] };
    const cm = new ConversationManager(fakeRag, { logger: console });

    // two accepted
    const p1 = cm.sendPrompt({ message: 'x' });
    const p2 = cm.sendPrompt({ message: 'y' });

    // third should reject immediately due to queue limit
    await expect(cm.sendPrompt({ message: 'z' })).rejects.toMatchObject({ code: 429 });

    // cleanup: allow queued items to flush so timers don't leak
    await Promise.all([p1, p2]);
  });

  it('errors for one prompt do not affect others', async () => {
    vi.resetModules();
    process.env.PROMPT_BATCH_DELAY_MS = '100';
    process.env.PROMPT_MAX_BATCH_SIZE = '8';
    process.env.PROMPT_BATCH_QUEUE_LIMIT = '1000';

    const { default: ConversationManager } = await import('../src/conversationManager.mjs');

    const mockChat = vi.fn((payload) => {
      if (payload.message === 'bad') return Promise.reject(new Error('boom'));
      return Promise.resolve({ text: `ok:${payload.message}` });
    });
    const fakeRag = { cohere: { chat: mockChat }, retrieveRelevantDocuments: async () => [] };
    const cm = new ConversationManager(fakeRag, { logger: console });

    const pGood1 = cm.sendPrompt({ message: 'g1' });
    const pBad = cm.sendPrompt({ message: 'bad' });
    const pGood2 = cm.sendPrompt({ message: 'g2' });

    const settled = await Promise.allSettled([pGood1, pBad, pGood2]);
    expect(settled[0].status).toBe('fulfilled');
    expect(settled[2].status).toBe('fulfilled');
    expect(settled[0].value.text).toBe('ok:g1');
    expect(settled[2].value.text).toBe('ok:g2');
    expect(settled[1].status).toBe('rejected');
  });
});