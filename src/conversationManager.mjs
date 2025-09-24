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

    // Prompt batching config (tunable via env)
    this._promptDelayMs = Number(process.env.PROMPT_BATCH_DELAY_MS) || 50;
    this._promptMaxBatch = Number(process.env.PROMPT_MAX_BATCH_SIZE) || 8;
    this._promptQueueLimit = Number(process.env.PROMPT_BATCH_QUEUE_LIMIT) || 1000;

    // internal prompt queue and debounce timer
    this._promptQueue = []; // items: { id, promptPayload, resolve, reject }
    this._promptTimer = null;
    this._flushing = false;
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
    // Defensive formatting to avoid runtime errors when metadata or fields are missing.
    if (!Array.isArray(ragDocuments) || ragDocuments.length === 0) return '';
    const sections = [];
    for (let idx = 0; idx < ragDocuments.length; idx++) {
      const doc = ragDocuments[idx] || {};
      const m = doc.metadata || {};
      const filePath = m.filePath || m.file || 'unknown';
      const language = m.language || 'text';
      const category = m.category || 'unknown';
      const rawScore = (typeof doc.relevanceScore !== 'undefined') ? doc.relevanceScore : (typeof doc.score !== 'undefined' ? doc.score : 0);
      const relevancePct = (typeof rawScore === 'number' && Number.isFinite(rawScore)) ? `${(rawScore * 100).toFixed(1)}%` : 'n/a';
      const content = String(doc.content || '').trim() || '(no content)';
      sections.push(
        `## Relevant Code Context ${idx + 1}\n**File**: ${filePath}\n**Type**: ${category} (${language})\n**Relevance**: ${relevancePct}\n\n\`\`\`${language}\n${content}\n\`\`\``
      );
    }
    return `# Retrieved Codebase Context\n\n${sections.join('\n\n')}\n\nPlease use this context...`;
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

  // Public: enqueue a prompt for batching. Returns a Promise resolved/rejected per-prompt.
  sendPrompt(promptPayload) {
    // Bound the queue
    if (this._promptQueue.length + 1 > this._promptQueueLimit) {
      const err = new Error('Prompt queue limit exceeded');
      err.code = 429;
      return Promise.reject(err);
    }

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2,8);
    return new Promise((resolve, reject) => {
      this._promptQueue.push({ id, promptPayload, resolve, reject });

      // If we reached max batch size, flush immediately
      if (this._promptQueue.length >= this._promptMaxBatch) {
        if (this._promptTimer) { clearTimeout(this._promptTimer); this._promptTimer = null; }
        // flush asynchronously
        void this._flushPromptBatch();
        return;
      }

      // ensure a single debounce timer is active
      if (!this._promptTimer) {
        this._promptTimer = setTimeout(() => {
          this._promptTimer = null;
          void this._flushPromptBatch();
        }, this._promptDelayMs);
      }
    });
  }

  // Internal: flush current queued prompts (all at once)
  async _flushPromptBatch() {
    if (this._flushing) return;
    if (this._promptQueue.length === 0) return;
    this._flushing = true;

    const batch = this._promptQueue.splice(0, this._promptQueue.length);
    // minimal diagnostic
    try {
      this.logger.info?.({ batchSize: batch.length }, 'prompt:batch:flush');
    } catch (e) { /* ignore logging errors */ }

    // Prepare per-item call promises, keep errors per-item
    const calls = batch.map((item) => {
      try {
        const call = (this.ragManager && this.ragManager.cohere && typeof this.ragManager.cohere.chat === 'function')
          ? this.ragManager.cohere.chat(item.promptPayload)
          : Promise.reject(new Error('No Cohere client available'));
        return call
          .then((resp) => ({ id: item.id, status: 'fulfilled', resp }))
          .catch((err) => ({ id: item.id, status: 'rejected', err }));
      } catch (err) {
        return Promise.resolve({ id: item.id, status: 'rejected', err });
      }
    });

    // Run in parallel but capture per-call results
    const results = await Promise.all(calls);

    // Resolve/reject original promises individually
    for (const r of results) {
      const item = batch.find(b => b.id === r.id);
      if (!item) continue;
      if (r.status === 'fulfilled') item.resolve(r.resp);
      else {
        // attach code if missing for queue-limit style handling
        if (r.err && !r.err.code) r.err.code = r.err.code || 'PROMPT_ERROR';
        item.reject(r.err);
      }
    }

    this._flushing = false;
  }

  // Ensure queued prompts are flushed on shutdown
  async shutdown() {
    if (this._promptTimer) { clearTimeout(this._promptTimer); this._promptTimer = null; }
    // flush remaining items
    try {
      await this._flushPromptBatch();
    } catch (e) {
      this.logger.warn?.({ e }, 'prompt:shutdown:flush_failed');
    }
    /* allow other graceful cleanup hooks if needed */
  }
}

export default ConversationManager;
