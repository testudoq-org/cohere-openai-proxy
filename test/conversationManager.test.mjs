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

  it('handles multilingual content in messages', async () => {
    const session = 'multilingual-session';
    const multilingualContent = {
      text: 'Hello こんにちは Hola',
      language: 'mixed'
    };
    await cm.addMessage(session, 'user', multilingualContent);
    const messages = cm.getConversation(session);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe(multilingualContent);
  });

  it('maintains separate conversation branches for different sessions', async () => {
    const session1 = 'branch-1';
    const session2 = 'branch-2';

    await cm.addMessage(session1, 'user', 'Question for session 1');
    await cm.addMessage(session1, 'assistant', 'Answer for session 1');

    await cm.addMessage(session2, 'user', 'Question for session 2');
    await cm.addMessage(session2, 'assistant', 'Answer for session 2');

    const conv1 = cm.getFormattedHistory(session1);
    const conv2 = cm.getFormattedHistory(session2);

    expect(conv1.chatHistory).toHaveLength(2);
    expect(conv2.chatHistory).toHaveLength(2);
    expect(conv1.chatHistory[0].message).toBe('Question for session 1');
    expect(conv2.chatHistory[0].message).toBe('Question for session 2');
  });

  it('handles session branching with feedback', async () => {
    const baseSession = 'base-session';
    await cm.addMessage(baseSession, 'user', 'Initial question');
    await cm.addMessage(baseSession, 'assistant', 'Initial answer');

    // Create a branch by adding feedback
    cm.addFeedback(baseSession, 'This answer was incomplete', 'correction');

    const conv = cm.getFormattedHistory(baseSession);
    expect(conv.preamble).toContain('User feedback');
    expect(conv.preamble).toContain('correction');
  });

  it('prevents duplicate messages based on content hash', async () => {
    const session = 'duplicate-test';
    const messageContent = 'duplicate message';

    const msg1 = await cm.addMessage(session, 'user', messageContent);
    const msg2 = await cm.addMessage(session, 'user', messageContent);

    expect(msg1).toBeTruthy();
    expect(msg2).toBeNull(); // Should be prevented as duplicate

    const messages = cm.getConversation(session);
    expect(messages).toHaveLength(1);
  });

  it('handles concurrent message additions safely', async () => {
    const session = 'concurrent-test';
    const promises = [];

    for (let i = 0; i < 5; i++) {
      promises.push(cm.addMessage(session, 'user', `Concurrent message ${i}`));
    }

    const results = await Promise.all(promises);
    const messages = cm.getConversation(session);

    // All messages should be added (no duplicates prevented by processing flag)
    expect(messages.length).toBeGreaterThan(0);
    expect(results.filter(r => r !== null)).toHaveLength(messages.length);
  });
});
