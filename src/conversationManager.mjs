import LruTtlCache from './utils/lruTtlCache.mjs';

class ConversationManager {
  constructor(ragManager, { ttlMs = 30 * 60 * 1000, logger = console } = {}) {
    this.conversations = new Map();
    this.ttl = ttlMs;
    this.ragManager = ragManager;
    this.logger = logger;
    this.cleanupInterval = null;
    // use LRU for ephemeral sessions if desired
    this.sessionLimit = 1000;
  }

  getConversation(sessionId) {
    const session = this.conversations.get(sessionId);
    if (session) { session.lastAccessed = Date.now(); return session.messages; }
    const newSession = { messages: [], lastAccessed: Date.now(), created: Date.now(), ragContext: [] };
    this.conversations.set(sessionId, newSession);
    // prune
    if (this.conversations.size > this.sessionLimit) {
      const oldest = Array.from(this.conversations.entries()).sort((a, b) => a[1].lastAccessed - b[1].lastAccessed)[0][0];
      this.conversations.delete(oldest);
    }
    return newSession.messages;
  }

  async addMessage(sessionId, role, content, metadata = {}) {
    const messages = this.getConversation(sessionId);
    const session = this.conversations.get(sessionId);
    if (!session._processing) session._processing = false;
    if (!session._lastMessageHash) session._lastMessageHash = null;
    const messageHash = JSON.stringify({ role, content, ...metadata });
    if (session._processing) return null;
    if (session._lastMessageHash === messageHash) return null;
    session._processing = true;
    try {
      if (role === 'user' && this.ragManager) {
        try {
          const docs = await this.ragManager.retrieveRelevantDocuments(content, { maxResults: 3 });
          session.ragContext = docs;
        } catch (err) { this.logger.warn({ err }, 'RAG retrieval failed'); }
      }
      const message = { role, content, timestamp: Date.now(), ...metadata };
      messages.push(message);
      session._lastMessageHash = messageHash;
      return message;
    } finally { session._processing = false; }
  }

  getFormattedHistoryWithRAG(sessionId) {
    const messages = this.getConversation(sessionId);
    const session = this.conversations.get(sessionId);
    const conversationData = this.getFormattedHistory(sessionId);
    if (session.ragContext && session.ragContext.length > 0) {
      const ragContext = this.formatRAGContext(session.ragContext);
      conversationData.preamble = this.buildEnhancedPreamble(conversationData.preamble, ragContext);
    }
    return conversationData;
  }

  formatRAGContext(ragDocuments) {
    const contextSections = ragDocuments.map((doc, idx) => {
      const m = doc.metadata;
      return `## Relevant Code Context ${idx+1}\n**File**: ${m.filePath}\n**Type**: ${m.category} (${m.language})\n**Relevance**: ${(doc.relevanceScore||doc.score||0).toFixed? ( (doc.relevanceScore||doc.score||0)*100).toFixed(1) : 'n/a'}%\n\n\`\`\`${m.language}\n${doc.content}\n\`\`\``;
    }).join('\n\n');
    return `# Retrieved Codebase Context\n\n${contextSections}\n\nPlease use this context...`;
  }

  buildEnhancedPreamble(originalPreamble, ragContext) {
    const basePreamble = `You are RooCode Assistant, an AI coding companion enhanced with RAG capabilities.`;
    const combined = [basePreamble];
    if (originalPreamble) combined.push(originalPreamble);
    combined.push(ragContext);
    return combined.join('\n\n');
  }

  getFormattedHistory(sessionId) {
    const messages = this.getConversation(sessionId);
    const systemMessages = messages.filter(m => m.role === 'system');
    const conversationMessages = messages.filter(m => m.role !== 'system');
    const chatHistory = [];
    for (let i = 0; i < conversationMessages.length - 1; i += 2) {
      const userMsg = conversationMessages[i];
      const assistantMsg = conversationMessages[i+1];
      if (userMsg?.role === 'user' && assistantMsg?.role === 'assistant') {
        chatHistory.push({ role: 'USER', message: userMsg.content });
        chatHistory.push({ role: 'CHATBOT', message: assistantMsg.content });
      }
    }
    const lastMessage = conversationMessages[conversationMessages.length -1];
    const currentUserMessage = lastMessage?.role === 'user' ? lastMessage.content : 'Please continue our conversation.';
    return { preamble: systemMessages.map(m => m.content).join('\n\n') || undefined, chatHistory, message: currentUserMessage };
  }

  addFeedback(sessionId, feedback, feedbackType = 'correction') {
    const systemMessage = `User feedback (${feedbackType}): ${feedback}`;
    return this.addMessage(sessionId, 'system', systemMessage, { type: 'feedback', feedbackType });
  }

  clearConversation(sessionId) { this.conversations.delete(sessionId); }

  getStats() { return { activeConversations: this.conversations.size, totalMessages: Array.from(this.conversations.values()).reduce((s, ses) => s + ses.messages.length, 0), ragEnabled: !!this.ragManager } }

  async shutdown() { /* allow graceful cleanup hooks if needed */ }
}

export default ConversationManager;
