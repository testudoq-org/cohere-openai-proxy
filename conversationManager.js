// conversationManager.js
// ConversationManager: Handles conversation state and RAG context
class ConversationManager {
  constructor(ragManager, ttlMs = 30 * 60 * 1000) {
    this.conversations = new Map();
    this.ttl = ttlMs;
    this.ragManager = ragManager;

    setInterval(() => this.cleanupExpired(), 5 * 60 * 1000);
  }

  getConversation(sessionId) {
    const session = this.conversations.get(sessionId);
    if (session) {
      session.lastAccessed = Date.now();
      return session.messages;
    }

    const newSession = {
      messages: [],
      lastAccessed: Date.now(),
      created: Date.now(),
      ragContext: [],
    };
    this.conversations.set(sessionId, newSession);
    return newSession.messages;
  }

  async addMessage(sessionId, role, content, metadata = {}) {
    const messages = this.getConversation(sessionId);
    const session = this.conversations.get(sessionId);

    // Prevent concurrent or duplicate message additions using a processing flag and last message hash
    if (!session._processing) session._processing = false;
    if (!session._lastMessageHash) session._lastMessageHash = null;

    const messageHash = JSON.stringify({ role, content, ...metadata });
    if (session._processing) {
      console.warn(`[CONVERSATION] Session ${sessionId} is already processing a message. Skipping duplicate.`);
      return null;
    }
    if (session._lastMessageHash === messageHash) {
      console.warn(`[CONVERSATION] Duplicate message detected for session ${sessionId}. Skipping.`);
      return null;
    }

    session._processing = true;

    try {
      if (role === "user" && this.ragManager) {
        try {
          const relevantDocs = await this.ragManager.retrieveRelevantDocuments(
            content,
            {
              maxResults: 3,
              minSimilarity: 0.2,
            }
          );

          session.ragContext = relevantDocs;
          console.log(
            `[RAG] Retrieved ${relevantDocs.length} relevant documents for session ${sessionId}`
          );
        } catch (error) {
          console.error(
            `[RAG] Failed to retrieve context for session ${sessionId}:`,
            error
          );
          session.ragContext = [];
        }
      }

      const message = {
        role,
        content,
        timestamp: Date.now(),
        ...metadata,
      };

      messages.push(message);
      session._lastMessageHash = messageHash;
      console.log(`[CONVERSATION] Added ${role} message to session ${sessionId}`);
      return message;
    } finally {
      session._processing = false;
    }
  }

  getFormattedHistoryWithRAG(sessionId) {
    const messages = this.getConversation(sessionId);
    const session = this.conversations.get(sessionId);

    const conversationData = this.getFormattedHistory(sessionId);

    if (session.ragContext && session.ragContext.length > 0) {
      const ragContext = this.formatRAGContext(session.ragContext);
      const enhancedPreamble = this.buildEnhancedPreamble(
        conversationData.preamble,
        ragContext
      );
      conversationData.preamble = enhancedPreamble;
    }

    return conversationData;
  }

  formatRAGContext(ragDocuments) {
    const contextSections = ragDocuments
      .map((doc, index) => {
        const metadata = doc.metadata;
        return `## Relevant Code Context ${index + 1}
**File**: ${metadata.filePath}
**Type**: ${metadata.category} (${metadata.language})
**Relevance**: ${(doc.relevanceScore * 100).toFixed(1)}%

\`\`\`${metadata.language}
${doc.content}
\`\`\``;
      })
      .join("\n\n");

    return `# Retrieved Codebase Context

The following code snippets and documentation have been retrieved from the project codebase based on your query:

${contextSections}

Please use this context to provide specific, actionable advice that aligns with the existing codebase patterns and architecture.`;
  }

  buildEnhancedPreamble(originalPreamble, ragContext) {
    const basePreamble = `You are RooCode Assistant, an AI coding companion enhanced with Retrieval Augmented Generation (RAG) capabilities. You have access to the current project's codebase and can provide context-aware assistance.

**Your Enhanced Capabilities:**
- Access to project-specific code files, documentation, and context
- Understanding of project architecture, conventions, and existing implementations
- Ability to reference actual code patterns and suggest improvements

**Response Guidelines:**
1. Always reference the retrieved code context when providing suggestions
2. Align recommendations with existing project patterns and conventions
3. Cite specific files and functions when making suggestions
4. Provide actionable advice based on the actual codebase structure`;

    const combinedPreamble = [basePreamble];

    if (originalPreamble) {
      combinedPreamble.push(originalPreamble);
    }

    combinedPreamble.push(ragContext);

    return combinedPreamble.join("\n\n");
  }

  getFormattedHistory(sessionId) {
    const messages = this.getConversation(sessionId);

    const systemMessages = messages.filter((msg) => msg.role === "system");
    const conversationMessages = messages.filter(
      (msg) => msg.role !== "system"
    );

    const chatHistory = [];

    for (let i = 0; i < conversationMessages.length - 1; i += 2) {
      const userMsg = conversationMessages[i];
      const assistantMsg = conversationMessages[i + 1];

      if (userMsg?.role === "user" && assistantMsg?.role === "assistant") {
        chatHistory.push({
          role: "USER",
          message: userMsg.content,
        });
        chatHistory.push({
          role: "CHATBOT",
          message: assistantMsg.content,
        });
      }
    }

    const lastMessage = conversationMessages[conversationMessages.length - 1];
    const currentUserMessage =
      lastMessage?.role === "user"
        ? lastMessage.content
        : "Please continue our conversation.";

    return {
      preamble:
        systemMessages.map((msg) => msg.content).join("\n\n") || undefined,
      chatHistory: chatHistory,
      message: currentUserMessage,
    };
  }

  addFeedback(sessionId, feedback, feedbackType = "correction") {
    const systemMessage = `User feedback (${feedbackType}): ${feedback}`;
    return this.addMessage(sessionId, "system", systemMessage, {
      type: "feedback",
      feedbackType,
    });
  }

  cleanupExpired() {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [sessionId, session] of this.conversations) {
      if (now - session.lastAccessed > this.ttl) {
        this.conversations.delete(sessionId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      console.log(`[CLEANUP] Removed ${cleanedCount} expired conversations`);
    }
  }

  getStats() {
    return {
      activeConversations: this.conversations.size,
      totalMessages: Array.from(this.conversations.values()).reduce(
        (sum, session) => sum + session.messages.length,
        0
      ),
      ragEnabled: !!this.ragManager,
    };
  }
}

module.exports = ConversationManager;