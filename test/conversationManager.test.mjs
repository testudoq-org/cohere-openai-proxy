import { describe, it, expect, beforeEach } from 'vitest';
import ConversationManager from '../src/conversationManager.mjs';

const fakeRag = { retrieveRelevantDocuments: async (q) => [{ content: 'ctx', metadata: { filePath: '/tmp', language: 'js', category: 'source' }, score: 0.9 }] };

describe('ConversationManager', () => {
  let cm;
  beforeEach(() => { cm = new ConversationManager(fakeRag, { logger: console }); });

  it('adds message and retrieves rag context for user messages', async () => {
    const session = 's1';
    await cm.addMessage(session, 'user', 'please help');
    const conv = cm.getFormattedHistoryWithRAG(session);
    expect(conv.message).toBeTruthy();
  });
});
