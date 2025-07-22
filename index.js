// Complete Enhanced Cohere Proxy Server with Multi-turn Conversation Support
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { CohereClient } = require('cohere-ai');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const morgan = require('morgan');
const { encoding_for_model } = require('tiktoken');

// Validate required environment variables
const requiredEnvVars = ['COHERE_API_KEY'];
for (const varName of requiredEnvVars) {
  if (!process.env[varName]) {
    throw new Error(`Missing required environment variable: ${varName}`);
  }
}

// Simple in-memory cache implementation
class MemoryCache {
  constructor(ttl = 5 * 60 * 1000, maxSize = 500) {
    this.cache = new Map();
    this.ttl = ttl;
    this.maxSize = maxSize;
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;
    
    if (Date.now() - item.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }
    
    return item.data;
  }

  set(key, data) {
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });
  }
}

// Conversation Manager for handling multi-turn conversations
class ConversationManager {
  constructor(ttlMs = 30 * 60 * 1000) { // 30 minutes default TTL
    this.conversations = new Map();
    this.ttl = ttlMs;
    
    // Cleanup expired conversations every 5 minutes
    setInterval(() => this.cleanupExpired(), 5 * 60 * 1000);
  }

  // Get or create conversation history for a session
  getConversation(sessionId) {
    const session = this.conversations.get(sessionId);
    if (session) {
      session.lastAccessed = Date.now();
      return session.messages;
    }
    
    // Create new conversation
    const newSession = {
      messages: [],
      lastAccessed: Date.now(),
      created: Date.now()
    };
    this.conversations.set(sessionId, newSession);
    return newSession.messages;
  }

  // Add a message to conversation history
  addMessage(sessionId, role, content, metadata = {}) {
    const messages = this.getConversation(sessionId);
    const message = {
      role,
      content,
      timestamp: Date.now(),
      ...metadata
    };
    
    messages.push(message);
    console.log(`[CONVERSATION] Added ${role} message to session ${sessionId}`);
    return message;
  }

  // Add user feedback as a system message
  addFeedback(sessionId, feedback, feedbackType = 'correction') {
    const systemMessage = `User feedback (${feedbackType}): ${feedback}`;
    return this.addMessage(sessionId, 'system', systemMessage, { 
      type: 'feedback', 
      feedbackType 
    });
  }

  // Get conversation history formatted for Cohere Chat API
  getFormattedHistory(sessionId) {
    const messages = this.getConversation(sessionId);
    
    // Separate system messages (preamble) from conversation
    const systemMessages = messages.filter(msg => msg.role === 'system');
    const conversationMessages = messages.filter(msg => msg.role !== 'system');
    
    // Format for Cohere Chat API
    const chatHistory = [];
    let currentUserMessage = '';
    
    for (let i = 0; i < conversationMessages.length - 1; i += 2) {
      const userMsg = conversationMessages[i];
      const assistantMsg = conversationMessages[i + 1];
      
      if (userMsg?.role === 'user' && assistantMsg?.role === 'assistant') {
        chatHistory.push({
          role: 'USER',
          message: userMsg.content
        });
        chatHistory.push({
          role: 'CHATBOT', 
          message: assistantMsg.content
        });
      }
    }
    
    // Get the current/last user message
    const lastMessage = conversationMessages[conversationMessages.length - 1];
    if (lastMessage?.role === 'user') {
      currentUserMessage = lastMessage.content;
    }
    
    return {
      preamble: systemMessages.map(msg => msg.content).join('\n\n') || undefined,
      chatHistory: chatHistory,
      message: currentUserMessage || 'Please continue our conversation.'
    };
  }

  // Clean up expired conversations
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

  // Get conversation stats
  getStats() {
    return {
      activeConversations: this.conversations.size,
      totalMessages: Array.from(this.conversations.values())
        .reduce((sum, session) => sum + session.messages.length, 0)
    };
  }
}

// Enhanced Cohere Proxy Server with conversation support
class EnhancedCohereProxyServer {
  constructor() {
    this.app = express();
    this.port = process.env.PORT || 3000;
    this.cohere = new CohereClient({
      token: process.env.COHERE_API_KEY,
    });
    this.tokenizer = encoding_for_model('gpt-3.5-turbo');
    this.supportedModels = new Set();
    this.conversationManager = new ConversationManager();

    // Configurable limits
    this.MAX_TOTAL_TOKENS = parseInt(process.env.MAX_TOTAL_TOKENS) || 4000;
    this.MIN_COMPLETION_TOKENS = parseInt(process.env.MIN_COMPLETION_TOKENS) || 50;
    this.MAX_COMPLETION_TOKENS = parseInt(process.env.MAX_COMPLETION_TOKENS) || 2048;
    this.TOKEN_SAFETY_BUFFER = parseInt(process.env.TOKEN_SAFETY_BUFFER) || 100;

    // Rate limiting configuration
    this.RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;
    this.RATE_LIMIT_MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100;

    // In-memory prompt cache (TTL: 5 min, max 500 entries)
    this.promptCache = new MemoryCache(5 * 60 * 1000, 500);

    this.setupMiddleware();
    this.setupRoutes();
    this.setupErrorHandling();
  }

  // Initialize supported models
  async initializeSupportedModels() {
    try {
      const response = await this.cohere.models.list();
      this.supportedModels = new Set(response.models.map(model => model.name));
      console.log('[INFO] Supported Cohere models:', Array.from(this.supportedModels).join(', '));
    } catch (error) {
      console.error('[ERROR] Failed to fetch supported models:', error.message);
      // Set default models if API call fails
      this.supportedModels = new Set(['command-r-plus', 'command-r', 'command']);
      console.log('[INFO] Using default models:', Array.from(this.supportedModels).join(', '));
    }
  }

  setupMiddleware() {
    this.app.use(helmet());
    this.app.use(morgan('combined'));

    const limiter = rateLimit({
      windowMs: this.RATE_LIMIT_WINDOW_MS,
      max: this.RATE_LIMIT_MAX_REQUESTS,
      message: {
        error: {
          message: 'Too many requests from this IP, please try again later.',
          type: 'rate_limit_exceeded'
        }
      }
    });
    this.app.use(limiter);

    this.app.use(cors({
      origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
      methods: ['GET', 'POST', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization']
    }));

    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));
  }

  setupRoutes() {
    // Health check with conversation stats
    this.app.get('/health', (req, res) => {
      const stats = this.conversationManager.getStats();
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        conversation_stats: stats,
        limits: {
          max_total_tokens: this.MAX_TOTAL_TOKENS,
          max_completion_tokens: this.MAX_COMPLETION_TOKENS,
          min_completion_tokens: this.MIN_COMPLETION_TOKENS,
          token_safety_buffer: this.TOKEN_SAFETY_BUFFER
        },
        version: '2.4.0-conversation'
      });
    });

    // Main chat completions endpoint with conversation support
    this.app.post('/v1/chat/completions', this.handleChatCompletion.bind(this));

    // Conversation management endpoints
    this.setupConversationRoutes();

    // 404 handler
    this.app.use((req, res) => {
      res.status(404).json({
        error: {
          message: `Route ${req.method} ${req.path} not found`,
          type: 'not_found'
        }
      });
    });
  }

  setupConversationRoutes() {
    // Route to add feedback to a conversation
    this.app.post('/v1/conversations/:sessionId/feedback', (req, res) => {
      try {
        const { sessionId } = req.params;
        const { feedback, type = 'correction' } = req.body;
        
        if (!feedback) {
          return res.status(400).json({
            error: { message: 'Feedback is required', type: 'invalid_request_error' }
          });
        }
        
        const message = this.conversationManager.addFeedback(sessionId, feedback, type);
        res.json({ success: true, message });
        
      } catch (error) {
        console.error('[ERROR] Failed to add feedback:', error);
        res.status(500).json({
          error: { message: 'Failed to add feedback', type: 'internal_server_error' }
        });
      }
    });

    // Route to get conversation history
    this.app.get('/v1/conversations/:sessionId/history', (req, res) => {
      try {
        const { sessionId } = req.params;
        const messages = this.conversationManager.getConversation(sessionId);
        res.json({ sessionId, messages, count: messages.length });
      } catch (error) {
        console.error('[ERROR] Failed to get conversation:', error);
        res.status(500).json({
          error: { message: 'Failed to get conversation', type: 'internal_server_error' }
        });
      }
    });

    // Route to clear conversation history
    this.app.delete('/v1/conversations/:sessionId', (req, res) => {
      try {
        const { sessionId } = req.params;
        this.conversationManager.conversations.delete(sessionId);
        res.json({ success: true, message: 'Conversation cleared' });
      } catch (error) {
        console.error('[ERROR] Failed to clear conversation:', error);
        res.status(500).json({
          error: { message: 'Failed to clear conversation', type: 'internal_server_error' }
        });
      }
    });
  }

  // Enhanced chat completion handler with conversation support
  async handleChatCompletion(req, res) {
    const startTime = Date.now();
    console.log('[INFO] Received chat completion request:', req.body);

    try {
      const requestData = this.validateAndExtractRequest(req.body);
      if (!requestData || requestData.error) {
        const error = requestData?.error || { message: 'Invalid request data', type: 'invalid_request_error' };
        return res.status(400).json({ error });
      }

      const { messages, temperature, requestedMaxTokens, model, sessionId } = requestData;

      // Generate session ID if not provided
      const effectiveSessionId = sessionId || this.generateId();
      
      // Add incoming messages to conversation history
      for (const message of messages) {
        this.conversationManager.addMessage(
          effectiveSessionId, 
          message.role, 
          this.extractContentString(message.content)
        );
      }

      // Get formatted conversation history for Cohere Chat API
      const conversationData = this.conversationManager.getFormattedHistory(effectiveSessionId);
      
      console.log('[DEBUG] Conversation data:', {
        sessionId: effectiveSessionId,
        historyLength: conversationData.chatHistory.length,
        currentMessage: conversationData.message
      });

      // Use Cohere Chat API for multi-turn conversations
      const response = await this.callCohereChatAPI(
        model, 
        conversationData, 
        temperature, 
        requestedMaxTokens
      );

      if (!response) {
        return res.status(500).json({
          error: { message: 'Failed to receive response from Cohere API', type: 'internal_server_error' }
        });
      }

      // Add assistant's response to conversation history
      const assistantResponse = response.text || '';
      this.conversationManager.addMessage(effectiveSessionId, 'assistant', assistantResponse);

      // Format response in OpenAI-compatible format
      const completionResponse = this.formatChatResponse(
        response, 
        model, 
        conversationData, 
        startTime, 
        effectiveSessionId
      );

      res.json(completionResponse);

    } catch (error) {
      console.error('[ERROR] Chat completion failed:', error);
      this.handleAPIError(error, res, startTime);
    }
  }

  validateAndExtractRequest(body) {
    const {
      messages,
      temperature = 0.7,
      max_tokens: requestedMaxTokens,
      model = 'command-r-plus',
      sessionId
    } = body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return {
        error: {
          message: 'Messages array is required and must not be empty',
          type: 'invalid_request_error'
        }
      };
    }

    return { messages, temperature, requestedMaxTokens, model, sessionId };
  }

  // Call Cohere Chat API with conversation history
  async callCohereChatAPI(model, conversationData, temperature, maxTokens) {
    const payload = {
      model: model,
      message: conversationData.message,
      temperature: temperature || 0.7,
      max_tokens: maxTokens || 512
    };

    // Add conversation history if available
    if (conversationData.chatHistory && conversationData.chatHistory.length > 0) {
      payload.chat_history = conversationData.chatHistory;
    }

    // Add preamble (system messages) if available
    if (conversationData.preamble) {
      payload.preamble = conversationData.preamble;
    }

    console.log('[DEBUG] Sending to Cohere Chat API:', {
      model: payload.model,
      messageLength: payload.message.length,
      historyCount: payload.chat_history?.length || 0,
      hasPreamble: !!payload.preamble
    });

    // Use chat endpoint instead of generate
    return await this.cohere.chat(payload);
  }

  // Format chat response in OpenAI-compatible format
  formatChatResponse(response, model, conversationData, startTime, sessionId) {
    const generatedText = response.text || '';
    const processingTime = Date.now() - startTime;
    
    // Estimate tokens (simplified)
    const promptTokens = this.estimateTokens(conversationData.message) + 
                        (conversationData.chatHistory?.length * 10 || 0);
    const completionTokens = this.estimateTokens(generatedText);

    return {
      id: `chatcmpl-${this.generateId()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: `cohere/${model}`,
      choices: [{
        index: 0,
        message: { 
          role: 'assistant', 
          content: generatedText 
        },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
      system_fingerprint: `cohere_chat_${model}_${Date.now()}`,
      processing_time_ms: processingTime,
      session_id: sessionId, // Include session ID in response
      conversation_stats: this.conversationManager.getStats()
    };
  }

  handleAPIError(error, res, startTime) {
    const processingTime = Date.now() - startTime;
    console.error('[ERROR] Chat completion failed after', processingTime, 'ms:', error);
    
    // More specific error handling
    let statusCode = 500;
    let errorType = 'internal_server_error';
    let message = 'Failed to process request';

    if (error.statusCode) {
      statusCode = error.statusCode;
      if (statusCode === 429) {
        errorType = 'rate_limit_exceeded';
        message = 'Rate limit exceeded';
      } else if (statusCode === 401) {
        errorType = 'authentication_error';
        message = 'Invalid API key';
      } else if (statusCode === 400) {
        errorType = 'invalid_request_error';
        message = 'Invalid request parameters';
      }
    }

    res.status(statusCode).json({
      error: {
        message,
        type: errorType,
        processing_time_ms: processingTime,
      }
    });
  }

  extractContentString(content) {
    if (typeof content === 'string') {
      return content;
    }
    if (content && typeof content === 'object') {
      if (content.text) {
        return content.text;
      }
      if (Array.isArray(content)) {
        return content
          .filter(part => part && typeof part === 'object' && part.text)
          .map(part => part.text)
          .join(' ');
      }
      try {
        return JSON.stringify(content);
      } catch (e) {
        return `StringifyError: ${e?.message ?? e} | Content: ${String(content)}`;
      }
    }
    return String(content || '');
  }

  estimateTokens(text) {
    const textString = this.extractContentString(text);
    return this.tokenizer.encode(textString).length;
  }

  generateId() {
    // Node.js-safe implementation
    return Date.now().toString(36) + Math.random().toString(36).substring(2);
  }

  setupErrorHandling() {
    this.app.use((error, req, res, next) => {
      console.error('[GLOBAL_ERROR] Unhandled error:', {
        message: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString()
      });
      res.status(500).json({
        error: {
          message: 'Internal server error',
          type: 'internal_server_error',
          timestamp: new Date().toISOString()
        }
      });
    });

    let server;
    process.on('SIGTERM', () => {
      console.log('[INFO] SIGTERM signal received: closing HTTP server');
      server?.close(() => {
        console.log('[INFO] HTTP server closed');
        process.exit(0);
      });
    });

    // Start method with async initialization
    this.start = async () => {
      await this.initializeSupportedModels();
      return new Promise((resolve) => {
        server = this.app.listen(this.port, () => {
          console.log(`Enhanced Cohere proxy server (v2.4.0-conversation) running at http://localhost:${this.port}`);
          console.log(`Health check at http://localhost:${this.port}/health`);
          console.log('New endpoints:');
          console.log(`  POST http://localhost:${this.port}/v1/conversations/:sessionId/feedback`);
          console.log(`  GET  http://localhost:${this.port}/v1/conversations/:sessionId/history`);
          console.log(`  DEL  http://localhost:${this.port}/v1/conversations/:sessionId`);
          resolve(server);
        });
      });
    };
  }
}

// Start the server
if (require.main === module) {
  const server = new EnhancedCohereProxyServer();
  server.start().catch(console.error);
}

module.exports = { EnhancedCohereProxyServer, ConversationManager };

/* 
USAGE EXAMPLE:

1. Start a conversation:
POST /v1/chat/completions
{
  "messages": [{"role": "user", "content": "What is AI?"}],
  "model": "command-r-plus",
  "sessionId": "user123"
}

2. Add feedback:
POST /v1/conversations/user123/feedback
{
  "feedback": "Please explain with more examples",
  "type": "clarification"
}

3. Continue conversation:
POST /v1/chat/completions
{
  "messages": [{"role": "user", "content": "Can you give practical examples?"}],
  "model": "command-r-plus", 
  "sessionId": "user123"
}

4. View conversation history:
GET /v1/conversations/user123/history

5. Clear conversation:
DELETE /v1/conversations/user123

The server automatically maintains context across all interactions for the session.
*/