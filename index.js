// Cohere Proxy Server: Express.js proxy for OpenAI-compatible chat completion requests to Cohere API.
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { CohereClient } = require('cohere-ai');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const morgan = require('morgan');
const { encoding_for_model } = require('tiktoken');
const MemoryCache = require('./memoryCache');

// Validate required environment variables
const requiredEnvVars = ['COHERE_API_KEY'];
for (const varName of requiredEnvVars) {
  if (!process.env[varName]) {
    throw new Error(`Missing required environment variable: ${varName}`);
  }
}

class CohereProxyServer {
  constructor() {
    this.app = express();
    this.port = process.env.PORT || 3000;
    this.cohere = new CohereClient({
      token: process.env.COHERE_API_KEY,
    });
    this.tokenizer = encoding_for_model('gpt-3.5-turbo');
    this.supportedModels = new Set();

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

  // Refactored: Move async model fetching outside constructor
  async initializeSupportedModels() {
    try {
      // Updated: Use models.list() instead of listModels()
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
      methods: ['GET', 'POST'],
      allowedHeaders: ['Content-Type', 'Authorization']
    }));

    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));
  }

  setupRoutes() {
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        limits: {
          max_total_tokens: this.MAX_TOTAL_TOKENS,
          max_completion_tokens: this.MAX_COMPLETION_TOKENS,
          min_completion_tokens: this.MIN_COMPLETION_TOKENS,
          token_safety_buffer: this.TOKEN_SAFETY_BUFFER
        },
        version: '2.3.2'
      });
    });

    this.app.post('/v1/chat/completions', this.handleChatCompletion.bind(this));

    this.app.use((req, res) => {
      res.status(404).json({
        error: {
          message: `Route ${req.method} ${req.path} not found`,
          type: 'not_found'
        }
      });
    });
  }

  // Generate a cache key based on model, prompt, parameters, and session context
  // In-memory cache for prompt responses, keyed by model, prompt, parameters, and sessionId.
  // Used to avoid redundant API calls for repeated or similar requests within a session.
  generateCacheKey({ model, optimizedPrompt, temperature, maxTokens, sessionId, messages }) {
    const base = JSON.stringify({
      model,
      prompt: optimizedPrompt,
      temperature,
      maxTokens,
      sessionId: sessionId || null,
      messages: messages ? messages.map(m => ({ role: m.role, content: this.extractContentString(m.content) })) : undefined
    });
    return Buffer.from(base).toString('base64');
  }

  async handleChatCompletion(req, res) {
  const startTime = Date.now();
  console.log('[INFO] Received request:', req.body);

  try {
    const requestData = this.validateAndExtractRequest(req.body);
    console.log('[DEBUG] Request data validated and extracted:', requestData);
    if (!requestData || requestData.error) {
      const error = requestData?.error || { message: 'Invalid request data', type: 'invalid_request_error' };
      console.warn('[WARN] Validation error:', error);
      return res.status(400).json({ error });
    }

    const { messages, temperature, requestedMaxTokens, model, sessionId } = requestData;

    const userQuestion = this.extractUserQuestion(messages);
    console.log('[DEBUG] Extracted user question:', userQuestion);
    if (!userQuestion) {
      console.warn('[WARN] Invalid user question');
      return res.status(400).json({
        error: { message: 'Invalid user question', type: 'invalid_request_error' }
      });
    }

    const optimizedPrompt = this.optimizePromptForDirectQuestion(userQuestion);
    console.log('[DEBUG] Optimized prompt:', optimizedPrompt);
    if (!optimizedPrompt) {
      console.error('[ERROR] Failed to optimize prompt');
      return res.status(500).json({
        error: { message: 'Failed to optimize prompt', type: 'internal_server_error' }
      });
    }

    const promptTokens = this.estimateTokens(optimizedPrompt);
    console.log('[DEBUG] Estimated prompt tokens:', promptTokens);
    const completionTokens = this.calculateOptimalCompletionTokens(promptTokens, requestedMaxTokens);
    console.log('[DEBUG] Calculated completion tokens:', completionTokens);

    const cacheKey = this.generateCacheKey({
      model,
      optimizedPrompt,
      temperature,
      maxTokens: completionTokens,
      sessionId,
      messages
    });

    const cached = this.promptCache.get(cacheKey);
    if (cached) {
      console.log('[CACHE] Hit for key:', cacheKey);
      return res.json({ ...cached, cache: true });
    }

    console.log('[INFO] Cache miss, calling Cohere API');
    const response = await this.callCohereAPI(model, optimizedPrompt, temperature, completionTokens);
    if (!response) {
      console.error('[ERROR] Cohere API call returned no response');
      return res.status(500).json({
        error: { message: 'Failed to receive response from Cohere API', type: 'internal_server_error' }
      });
    }
    console.log('[DEBUG] API response received:', response);

    const completionResponse = this.formatResponse(response, model, promptTokens, startTime);
    if (!completionResponse) {
      console.error('[ERROR] Failed to format response');
      return res.status(500).json({
        error: { message: 'Failed to format response', type: 'internal_server_error' }
      });
    }

    this.promptCache.set(cacheKey, completionResponse);
    res.json(completionResponse);

  } catch (error) {
    console.error('[ERROR] API call failed:', error);
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

  async callCohereAPI(model, prompt, temperature, maxTokens) {
    // FIXED: Removed unnecessary try-catch that only logged and re-threw
    // Let the error bubble up to handleChatCompletion where it's properly handled
    return await this.cohere.generate({
      model: model,
      prompt: prompt,
      temperature,
      maxTokens,
      truncate: 'END'
    });
  }

  formatResponse(response, model, promptTokens, startTime) {
    const generatedText = response.generations?.[0]?.text || '';
    const processingTime = Date.now() - startTime;
    const finalCompletionTokens = this.estimateTokens(generatedText);

    return {
      id: `chatcmpl-${this.generateId()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: `cohere/${model}`,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: generatedText },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: finalCompletionTokens,
        total_tokens: promptTokens + finalCompletionTokens,
      },
      system_fingerprint: `cohere_${model}_${Date.now()}`,
      processing_time_ms: processingTime,
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

  extractUserQuestion(messages) {
    const userMessage = messages.find(msg => msg.role === 'user');
    return userMessage ? this.extractContentString(userMessage.content) : '';
  }

  optimizePromptForDirectQuestion(question) {
    return `Answer the following question directly without using any tools:\n\n${question}`;
  }

  // Helper for optimizing message arrays and token allocation; not used in main flow but kept for future extensibility.
  processAndOptimizeRequest(messages, requestedMaxTokens) {
    const promptTokens = this.calculateMessagesTokens(messages);
    const completionTokens = this.calculateOptimalCompletionTokens(promptTokens, requestedMaxTokens);
    const totalTokens = promptTokens + completionTokens;

    if (totalTokens <= this.MAX_TOTAL_TOKENS) {
      return {
        optimizedMessages: messages,
        promptTokens,
        completionTokens,
        totalTokens,
        truncated: false
      };
    }

    return this.handleTokenOverflow(messages, promptTokens, requestedMaxTokens);
  }

  handleTokenOverflow(messages, promptTokens, requestedMaxTokens) {
    const maxAllowedPrompt = this.MAX_TOTAL_TOKENS - this.MIN_COMPLETION_TOKENS - this.TOKEN_SAFETY_BUFFER;
    
    if (promptTokens <= maxAllowedPrompt) {
      const completionTokens = this.MAX_TOTAL_TOKENS - promptTokens - this.TOKEN_SAFETY_BUFFER;
      return {
        optimizedMessages: messages,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        truncated: false
      };
    }

    const optimizedMessages = this.intelligentTruncateMessages(messages, maxAllowedPrompt);
    const newPromptTokens = this.calculateMessagesTokens(optimizedMessages);
    const newCompletionTokens = this.calculateOptimalCompletionTokens(newPromptTokens, requestedMaxTokens);

    return {
      optimizedMessages,
      promptTokens: newPromptTokens,
      completionTokens: newCompletionTokens,
      totalTokens: newPromptTokens + newCompletionTokens,
      truncated: true
    };
  }

  calculateOptimalCompletionTokens(promptTokens, requestedMaxTokens) {
    const availableTokens = this.MAX_TOTAL_TOKENS - promptTokens - this.TOKEN_SAFETY_BUFFER;
    let completionTokens;

    if (requestedMaxTokens && requestedMaxTokens > 0) {
      completionTokens = Math.min(requestedMaxTokens, this.MAX_COMPLETION_TOKENS, availableTokens);
    } else {
      completionTokens = this.calculateDefaultCompletionTokens(availableTokens);
    }
    
    return Math.max(completionTokens, this.MIN_COMPLETION_TOKENS);
  }

  calculateDefaultCompletionTokens(availableTokens) {
    if (availableTokens >= 1000) {
      return Math.min(512, this.MAX_COMPLETION_TOKENS, availableTokens);
    } else if (availableTokens >= 500) {
      return Math.min(256, this.MAX_COMPLETION_TOKENS, availableTokens);
    } else if (availableTokens >= 200) {
      return Math.min(128, this.MAX_COMPLETION_TOKENS, availableTokens);
    } else {
      return Math.max(availableTokens, this.MIN_COMPLETION_TOKENS);
    }
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

  calculateMessagesTokens(messages) {
    return messages.reduce((total, message) => {
      const content = this.extractContentString(message.content);
      return total + this.estimateTokens(content) + 4;
    }, 2);
  }

  // Formats messages for Cohere Chat API; not used in current flow but retained for future chat endpoint support.
  formatMessagesForCohereChat(messages) {
    const result = {
      preamble: '',
      chatHistory: [],
      currentMessage: ''
    };

    this.processMessagesForChat(messages, result);
    this.ensureCurrentMessage(result);

    return {
      message: result.currentMessage,
      chatHistory: result.chatHistory,
      preamble: result.preamble || undefined
    };
  }

  processMessagesForChat(messages, result) {
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      const content = this.extractContentString(message.content).trim();
      if (!content) continue;
      
      this.categorizeMessage(message, content, i, messages.length, result);
    }
  }

  categorizeMessage(message, content, index, totalMessages, result) {
    if (message.role === 'system') {
      result.preamble = content;
    } else if (message.role === 'user') {
      this.handleUserMessage(content, index, totalMessages, result);
    } else if (message.role === 'assistant') {
      result.chatHistory.push({ role: 'CHATBOT', message: content });
    }
  }

  handleUserMessage(content, index, totalMessages, result) {
    if (index === totalMessages - 1) {
      result.currentMessage = content;
    } else {
      result.chatHistory.push({ role: 'USER', message: content });
    }
  }

  ensureCurrentMessage(result) {
    if (!result.currentMessage && result.chatHistory.length > 0) {
      const lastUserMessage = result.chatHistory.filter(msg => msg.role === 'USER').pop();
      if (lastUserMessage) {
        result.currentMessage = lastUserMessage.message;
        result.chatHistory = result.chatHistory.filter(msg => msg !== lastUserMessage);
      }
    }

    if (!result.currentMessage) {
      result.currentMessage = "Please provide a response.";
    }
  }

  // Formats messages for Cohere Generate API; not used in current flow but retained for prompt-based endpoints or future use.
  formatMessagesForCohere(messages) {
    let prompt = '';
    for (const message of messages) {
      const content = this.extractContentString(message.content).trim();
      if (!content) continue;
      if (message.role === 'system') {
        prompt += `System: ${content}\n\n`;
      } else if (message.role === 'user') {
        prompt += `Human: ${content}\n\n`;
      } else if (message.role === 'assistant') {
        prompt += `Assistant: ${content}\n\n`;
      }
    }
    if (!prompt.endsWith('Assistant: ')) {
      prompt += 'Assistant: ';
    }
    return prompt.trim();
  }

  validateModel(model) {
    // Determines if a model is a chat-capable model; not used in current flow but retained for future extensibility.
    return 'command-r-plus';
  }

  isChatModel(model) {
    const chatModels = ['command-r', 'command-r-plus'];
    return chatModels.includes(model);
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

    // Refactored: Move async initialization to start method
    this.start = async () => {
      await this.initializeSupportedModels();
      return new Promise((resolve) => {
        server = this.app.listen(this.port, () => {
          console.log(`Cohere proxy server (v2.3.2) running at http://localhost:${this.port}`);
          console.log(`Health check at http://localhost:${this.port}/health`);
          resolve(server);
        });
      });
    };
  }

  intelligentTruncateMessages(messages, maxAllowedPrompt) {
    let totalTokens = 2;
    const truncatedMessages = [];
    const systemMessages = [];
    const conversationMessages = [];

    // Separate system and conversation messages
    for (const message of messages) {
      if (message.role === 'system') {
        systemMessages.push(message);
      } else {
        conversationMessages.push(message);
      }
    }

    // Add system messages first (within limits)
    for (const systemMessage of systemMessages) {
      const content = this.extractContentString(systemMessage.content);
      const messageTokens = this.estimateTokens(content) + 4;
      if (totalTokens + messageTokens <= maxAllowedPrompt) {
        truncatedMessages.push(systemMessage);
        totalTokens += messageTokens;
      }
    }

    // Add conversation messages from most recent
    for (let i = conversationMessages.length - 1; i >= 0; i--) {
      const message = conversationMessages[i];
      const content = this.extractContentString(message.content);
      const messageTokens = this.estimateTokens(content) + 4;
      if (totalTokens + messageTokens <= maxAllowedPrompt) {
        truncatedMessages.splice(systemMessages.length, 0, message);
        totalTokens += messageTokens;
      } else {
        break;
      }
    }

    // Ensure at least the last message is included if possible
    if (conversationMessages.length > 0 && truncatedMessages.length === systemMessages.length) {
      const lastMessage = conversationMessages[conversationMessages.length - 1];
      const content = this.extractContentString(lastMessage.content);
      const messageTokens = this.estimateTokens(content) + 4;
      if (systemMessages.length === 0 || totalTokens + messageTokens <= maxAllowedPrompt) {
        truncatedMessages.push(lastMessage);
      }
    }

    return truncatedMessages;
  }
}

// Start the server
if (require.main === module) {
  const server = new CohereProxyServer();
  server.start().catch(console.error);
}

module.exports = CohereProxyServer;
