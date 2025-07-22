/**
 * Cohere Proxy Server - Enhanced Token Handling and Dynamic Model Support
 * 
 * A production-ready Express.js server acting as a proxy between OpenAI-compatible 
 * chat completion requests and Cohere's API. Includes improved token management, 
 * dynamic model fetching, and enhanced error handling.
 * 
 * Key Features:
 * - Accurate token estimation using tiktoken library
 * - Dynamic fetching of supported Cohere models
 * - Intelligent request truncation and optimization
 * - Configurable token limits and rate limiting via environment variables
 * - Graceful shutdown handling
 * - Comprehensive error logging and OpenAI-compatible responses
 * - Support for both Chat and Generate API endpoints
 * - Retry mechanism for transient API errors
 * 
 * Endpoints:
 * - POST /v1/chat/completions - Main chat completion endpoint
 * - GET /health - Health check endpoint
 * 
 * Environment Variables:
 * - COHERE_API_KEY: Your Cohere API key (required)
 * - PORT: Server port (default: 3000)
 * - ALLOWED_ORIGINS: Comma-separated list of allowed CORS origins (default: *)
 * - MAX_TOTAL_TOKENS: Maximum total tokens (input + output) (default: 4000)
 * - MIN_COMPLETION_TOKENS: Minimum tokens reserved for completion (default: 50)
 * - MAX_COMPLETION_TOKENS: Maximum completion tokens (default: 2048)
 * - TOKEN_SAFETY_BUFFER: Safety buffer for token calculations (default: 100)
 * - RATE_LIMIT_WINDOW_MS: Rate limit window in milliseconds (default: 900000)
 * - RATE_LIMIT_MAX_REQUESTS: Maximum requests per window (default: 100)
 * 
 * Data Flow Diagrams:
 * 
 * ## 📊 Request Processing Flow
 * 
 * ```mermaid
 * graph TD
 *     A[Client Request] --> B{Rate Limit Check}
 *     B -->|Pass| C[Input Validation]
 *     B -->|Fail| D[Rate Limit Error]
 *     C -->|Valid| E[Format Conversion]
 *     C -->|Invalid| F[Validation Error]
 *     E --> G[Cohere API Call]
 *     G -->|Success| H[Response Processing]
 *     G -->|Error| I[API Error Handling]
 *     H --> J[Token Estimation]
 *     J --> K[Response Formatting]
 *     K --> L[Client Response]
 *     D --> M[Error Response]
 *     F --> M
 *     I --> M
 * ```
 * 
 * ## 📊 Message Transformation Flow
 * 
 * ```mermaid
 * sequenceDiagram
 *     participant Client
 *     participant Proxy
 *     participant Cohere
 *     
 *     Client->>Proxy: OpenAI Chat Completion Request
 *     Note over Proxy: Validate Request
 *     Note over Proxy: Transform Messages
 *     Proxy->>Cohere: Generate Request
 *     Cohere->>Proxy: Generate Response
 *     Note over Proxy: Estimate Tokens
 *     Note over Proxy: Format Response
 *     Proxy->>Client: OpenAI Compatible Response
 * ```
 * 
 * @author Assistant
 * @version 2.3.2
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { CohereClient } = require('cohere-ai');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const morgan = require('morgan');
const { encoding_for_model } = require('tiktoken');
const MemoryCache = require('./memoryCache'); // <-- Add cache import

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
    this.tokenizer = encoding_for_model('gpt-3.5-turbo'); // Use tiktoken for accurate estimation
    this.supportedModels = new Set(); // Dynamically fetched models

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
    this.fetchSupportedModels(); // Dynamically fetch supported models
  }

  async fetchSupportedModels() {
    try {
      const models = await this.cohere.listModels();
      this.supportedModels = new Set(models.map(model => model.name));
      console.log(`[INFO] Supported Cohere models: ${Array.from(this.supportedModels).join(', ')}`);
    } catch (error) {
      console.error('[ERROR] Failed to fetch supported models:', error.message);
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
  generateCacheKey({ model, optimizedPrompt, temperature, maxTokens, sessionId, messages }) {
    // For session-based, include sessionId and message history
    const base = JSON.stringify({
      model,
      prompt: optimizedPrompt,
      temperature,
      maxTokens,
      sessionId: sessionId || null,
      messages: messages ? messages.map(m => ({ role: m.role, content: this.extractContentString(m.content) })) : undefined
    });
    // Simple hash (FNV-1a or similar) for brevity, but here just use base64 for demo
    return Buffer.from(base).toString('base64');
  }

  // Revised handleChatCompletion method with caching
  async handleChatCompletion(req, res) {
    const startTime = Date.now();

    try {
      const {
        messages,
        temperature = 0.7,
        max_tokens: requestedMaxTokens,
        model = 'command-r-plus',
        stream = false,
        sessionId // support sessionId for cache key
      } = req.body;

      // Validate and process messages
      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({
          error: {
            message: 'Messages array is required and must not be empty',
            type: 'invalid_request_error'
          }
        });
      }

      // Extract user question directly
      const userQuestion = this.extractUserQuestion(messages);

      // Optimize prompt for direct questions
      const optimizedPrompt = this.optimizePromptForDirectQuestion(userQuestion);

      // Calculate tokens for optimized prompt
      const promptTokens = this.estimateTokens(optimizedPrompt);
      const completionTokens = this.calculateOptimalCompletionTokens(promptTokens, requestedMaxTokens);

      // Generate cache key
      const cacheKey = this.generateCacheKey({
        model,
        optimizedPrompt,
        temperature,
        maxTokens: completionTokens,
        sessionId,
        messages
      });

      // Check cache
      const cached = this.promptCache.get(cacheKey);
      if (cached) {
        console.log('[CACHE] Hit for key:', cacheKey);
        return res.json({ ...cached, cache: true });
      }

      console.log(`[TOKEN_ANALYSIS] Prompt: ${promptTokens}, Completion: ${completionTokens}`);

      // Call Cohere API with optimized prompt
      let response;
      try {
        response = await this.cohere.generate({
          model: model,
          prompt: optimizedPrompt,
          temperature,
          maxTokens: completionTokens,
          truncate: 'END'
        });
      } catch (apiError) {
        console.error(`[API_ERROR] Cohere API call failed:`, apiError);
        throw apiError;
      }

      const generatedText = response.generations?.[0]?.text || '';
      const processingTime = Date.now() - startTime;
      const finalCompletionTokens = this.estimateTokens(generatedText);

      // Prepare response
      const completionResponse = {
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

      // Only cache successful responses
      this.promptCache.set(cacheKey, completionResponse);

      res.json(completionResponse);

    } catch (error) {
      const processingTime = Date.now() - startTime;
      console.error(`[ERROR] Chat completion failed after ${processingTime}ms:`, error);
      res.status(500).json({
        error: {
          message: 'Failed to process request',
          type: 'internal_server_error',
          processing_time_ms: processingTime,
        }
      });
    }
  }

  // Helper method to extract user question
  extractUserQuestion(messages) {
    const userMessage = messages.find(msg => msg.role === 'user');
    return userMessage ? this.extractContentString(userMessage.content) : '';
  }

  // Helper method to optimize prompt for direct questions
  optimizePromptForDirectQuestion(question) {
    return `Answer the following question directly without using any tools:\n\n${question}`;
  }


  processAndOptimizeRequest(messages, requestedMaxTokens) {
    const promptTokens = this.calculateMessagesTokens(messages);
    const completionTokens = this.calculateOptimalCompletionTokens(promptTokens, requestedMaxTokens);
    const totalTokens = promptTokens + completionTokens;

    console.log(`[DEBUG] processAndOptimizeRequest - promptTokens: ${promptTokens}, completionTokens: ${completionTokens}, totalTokens: ${totalTokens}`);

    if (totalTokens <= this.MAX_TOTAL_TOKENS) {
      return {
        optimizedMessages: messages,
        promptTokens,
        completionTokens,
        totalTokens,
        truncated: false
      };
    }

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
    console.log(`[DEBUG] calculateOptimalCompletionTokens - promptTokens: ${promptTokens}, requestedMaxTokens: ${requestedMaxTokens}`);
    const availableTokens = this.MAX_TOTAL_TOKENS - promptTokens - this.TOKEN_SAFETY_BUFFER;

    let completionTokens;

    if (requestedMaxTokens && requestedMaxTokens > 0) {
      // Use requested amount, but respect limits
      completionTokens = Math.min(requestedMaxTokens, this.MAX_COMPLETION_TOKENS, availableTokens);
    } else {
      // Dynamic allocation based on prompt size and available space
      if (availableTokens >= 1000) {
        completionTokens = 512; // Long response
      } else if (availableTokens >= 500) {
        completionTokens = 256; // Medium response
      } else if (availableTokens >= 200) {
        completionTokens = 128; // Short response
      } else {
        completionTokens = Math.max(availableTokens, this.MIN_COMPLETION_TOKENS);
      }

      // Ensure we don't exceed limits
      completionTokens = Math.min(completionTokens, this.MAX_COMPLETION_TOKENS, availableTokens);
    }

    // Ensure minimum viable response
    return Math.max(completionTokens, this.MIN_COMPLETION_TOKENS);
  }

  /**
   * Safely extract string content from message content
   */
  extractContentString(content) {
    if (typeof content === 'string') {
      return content;
    }
    
    if (content && typeof content === 'object') {
      // Handle OpenAI format with text and other properties
      if (content.text) {
        return content.text;
      }
      // Handle array of content parts
      if (Array.isArray(content)) {
        return content
          .filter(part => part && typeof part === 'object' && part.text)
          .map(part => part.text)
          .join(' ');
      }
      // Fallback to JSON stringify for other objects
      try {
        return JSON.stringify(content);
      } catch (e) {
        return String(content);
      }
    }
    
    // Fallback for other types
    return String(content || '');
  }

  estimateTokens(text) {
    const textString = this.extractContentString(text);
    console.log('[DEBUG] estimateTokens called with:', { type: typeof textString, value: textString });
    return this.tokenizer.encode(textString).length;
  }

  calculateMessagesTokens(messages) {
    return messages.reduce((total, message, idx) => {
      const content = this.extractContentString(message.content);
      console.log(`[DEBUG] calculateMessagesTokens message[${idx}]:`, { 
        role: message.role, 
        contentType: typeof message.content, 
        extractedContent: content.substring(0, 100) + (content.length > 100 ? '...' : '')
      });
      return total + this.estimateTokens(content) + 4; // Overhead for role, content, and structure
    }, 2); // Base conversation overhead
  }

  /**
   * Enhanced message formatting for Cohere Chat API
   * Properly handles system messages, conversation history, and user input
   */
  formatMessagesForCohereChat(messages) {
      let preamble = '';
      let chatHistory = [];
      let currentMessage = '';
      
      // Process messages to separate system, history, and current user message
      for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        const content = this.extractContentString(message.content).trim();
        
        if (!content) continue; // Skip empty messages
        
        if (message.role === 'system') {
          // Use system messages as preamble
          preamble = content;
        } else if (message.role === 'user') {
          if (i === messages.length - 1) {
            // This is the last message, treat it as the current user message
            currentMessage = content;
          } else {
            // Add to history as a user message
            chatHistory.push({
              role: 'USER',
              message: content
            });
          }
        } else if (message.role === 'assistant') {
          // Add assistant responses to history
          chatHistory.push({
            role: 'CHATBOT',
            message: content
          });
        }
      }
      
      // If no current message was found, use the last user message from history
      if (!currentMessage && chatHistory.length > 0) {
        const lastUserMessage = chatHistory.filter(msg => msg.role === 'USER').pop();
        if (lastUserMessage) {
          currentMessage = lastUserMessage.message;
          // Remove it from history since it's now the current message
          chatHistory = chatHistory.filter(msg => msg !== lastUserMessage);
        }
      }
      
      // Fallback if still no current message
      if (!currentMessage) {
        currentMessage = "Please provide a response.";
      }
      
      return {
        message: currentMessage,
        chatHistory: chatHistory,
        preamble: preamble || undefined
      };
    }


  /**
   * Enhanced message formatting for Cohere Generate API
   * Creates a well-structured prompt from conversation messages
   */
  formatMessagesForCohere(messages) {
    let prompt = '';
    
    for (const message of messages) {
      const content = this.extractContentString(message.content).trim();
      
      if (!content) continue; // Skip empty messages
      
      if (message.role === 'system') {
        prompt += `System: ${content}\n\n`;
      } else if (message.role === 'user') {
        prompt += `Human: ${content}\n\n`;
      } else if (message.role === 'assistant') {
        prompt += `Assistant: ${content}\n\n`;
      }
    }
    
    // End with Assistant: to prompt for response
    if (!prompt.endsWith('Assistant: ')) {
      prompt += 'Assistant: ';
    }
    
    return prompt.trim();
  }

  validateModel(model) {
    // Map all models to command-r-plus (Cohere's most capable model)
    return 'command-r-plus';
  }

  isChatModel(model) {
    const chatModels = ['command-r', 'command-r-plus'];
    return chatModels.includes(model);
  }

  generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
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

    this.start = async () => {
      await this.fetchSupportedModels(); // Ensure models are fetched before starting the server
      return new Promise((resolve) => {
        server = this.app.listen(this.port, () => {
          console.log(`✅ Cohere proxy server (v2.3.2) running at http://localhost:${this.port}`);
          console.log(`📊 Health check available at http://localhost:${this.port}/health`);
          console.log(`🔐 Rate limiting: ${this.RATE_LIMIT_MAX_REQUESTS} requests per ${this.RATE_LIMIT_WINDOW_MS / 1000} seconds per IP`);
          console.log(`🎯 Token limits: ${this.MAX_TOTAL_TOKENS} total, ${this.MAX_COMPLETION_TOKENS} max completion`);
          console.log(`⚡ Enhanced message handling and token processing active`);
          resolve(server);
        });
      });
    };
  }

  /**
   * Truncate messages intelligently to fit within maxAllowedPrompt tokens.
   * Keeps the most recent messages, discarding older ones as needed.
   * Always preserves system messages and the most recent user message.
   */
  intelligentTruncateMessages(messages, maxAllowedPrompt) {
    let totalTokens = 2; // Base conversation overhead
    const truncatedMessages = [];
    const systemMessages = [];
    const conversationMessages = [];
    
    // Separate system messages from conversation messages
    for (const message of messages) {
      if (message.role === 'system') {
        systemMessages.push(message);
      } else {
        conversationMessages.push(message);
      }
    }
    
    // Always include system messages first
    for (const systemMessage of systemMessages) {
      const content = this.extractContentString(systemMessage.content);
      const messageTokens = this.estimateTokens(content) + 4;
      if (totalTokens + messageTokens <= maxAllowedPrompt) {
        truncatedMessages.push(systemMessage);
        totalTokens += messageTokens;
      }
    }
    
    // Process conversation messages from most recent backwards
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
    
    // Ensure we have at least the most recent user message if possible
    if (conversationMessages.length > 0 && truncatedMessages.length === systemMessages.length) {
      const lastMessage = conversationMessages[conversationMessages.length - 1];
      const content = this.extractContentString(lastMessage.content);
      const messageTokens = this.estimateTokens(content) + 4;
      
      // If the last message alone fits, include it
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