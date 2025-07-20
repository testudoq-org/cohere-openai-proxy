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
 * @author Assistant
 * @version 2.3.0
 */

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
        version: '2.3.0'
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

  async handleChatCompletion(req, res) {
    const startTime = Date.now();

    try {
      const {
        messages,
        temperature = 0.7,
        max_tokens: requestedMaxTokens,
        model = 'command-r',
        stream = false
      } = req.body;

      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({
          error: {
            message: 'Messages array is required and must not be empty',
            type: 'invalid_request_error'
          }
        });
      }

      const validatedModel = this.validateModel(model);

      const processedRequest = this.processAndOptimizeRequest(messages, requestedMaxTokens);
      if (processedRequest.error) {
        return res.status(400).json({
          error: processedRequest.error
        });
      }

      const {
        optimizedMessages,
        promptTokens,
        completionTokens,
        totalTokens,
        truncated
      } = processedRequest;

      console.log(`[TOKEN_ANALYSIS] Prompt: ${promptTokens}, Completion: ${completionTokens}, Total: ${totalTokens}${truncated ? ' (truncated)' : ''}`);

      let response;
      let generatedText;

      if (this.isChatModel(validatedModel)) {
        const { message, chatHistory } = this.formatMessagesForCohereChat(optimizedMessages);
        response = await this.cohere.chat({
          model: validatedModel,
          message,
          chatHistory,
          temperature,
          maxTokens: completionTokens
        });
        generatedText = response.text || '';
      } else {
        const prompt = this.formatMessagesForCohere(optimizedMessages);
        response = await this.cohere.generate({
          model: validatedModel,
          prompt,
          temperature,
          maxTokens: completionTokens,
          truncate: 'END'
        });
        generatedText = response.generations?.[0]?.text || '';
      }

      if (!generatedText) {
        generatedText = 'Unable to generate a response. Please try again.';
      }

      const processingTime = Date.now() - startTime;
      const finalCompletionTokens = this.estimateTokens(generatedText);
      const finalTotalTokens = promptTokens + finalCompletionTokens;

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
          total_tokens: finalTotalTokens,
        },
        system_fingerprint: `cohere_${validatedModel}_${Date.now()}`,
        processing_time_ms: processingTime,
        ...(truncated && { warning: 'Request was automatically truncated' })
      };

      res.json(completionResponse);

    } catch (error) {
      const processingTime = Date.now() - startTime;
      console.error(`[ERROR] Chat completion failed after ${processingTime}ms:`, {
        message: error.message,
        timestamp: new Date().toISOString()
      });

      let statusCode = 500;
      let errorType = 'internal_server_error';
      let errorMessage = 'An unexpected error occurred';

      if (error.message.includes('API key')) {
        statusCode = 401;
        errorType = 'authentication_error';
        errorMessage = 'Invalid API key';
      } else if (error.message.includes('rate limit')) {
        statusCode = 429;
        errorType = 'rate_limit_exceeded';
        errorMessage = 'Rate limit exceeded';
      } else if (error.message.includes('model')) {
        statusCode = 400;
        errorType = 'invalid_request_error';
        errorMessage = error.message;
      }

      res.status(statusCode).json({
        error: {
          message: errorMessage,
          type: errorType,
          processing_time_ms: processingTime,
          timestamp: new Date().toISOString()
        }
      });
    }
  }

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

  estimateTokens(text) {
    return this.tokenizer.encode(text).length;
  }

  calculateMessagesTokens(messages) {
    return messages.reduce((total, message) => {
      return total + this.estimateTokens(message.content || '') + 4; // Overhead for role, content, and structure
    }, 2); // Base conversation overhead
  }

  intelligentTruncateMessages(messages, targetTokens) {
    if (this.calculateMessagesTokens(messages) <= targetTokens) {
      return messages;
    }

    const truncatedMessages = [...messages];
    let systemMessage = null;
    let lastUserMessage = null;
    const conversationHistory = [];

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (message.role === 'system') {
        systemMessage = message;
      } else if (message.role === 'user' && i === messages.length - 1) {
        lastUserMessage = message;
      } else {
        conversationHistory.push(message);
      }
    }

    const essentialTokens = (systemMessage ? this.estimateTokens(systemMessage.content) + 4 : 0) +
      (lastUserMessage ? this.estimateTokens(lastUserMessage.content) + 4 : 0) + 10;

    const availableForHistory = targetTokens - essentialTokens;
    if (availableForHistory < 0) {
      if (lastUserMessage) {
        lastUserMessage.content = this.truncateTextIntelligently(lastUserMessage.content, targetTokens - (systemMessage ? this.estimateTokens(systemMessage.content) + 4 : 0) - 50);
      }
      return [systemMessage, lastUserMessage].filter(Boolean);
    }

    const optimizedHistory = this.selectOptimalHistory(conversationHistory, availableForHistory);
    const result = [];
    if (systemMessage) result.push(systemMessage);
    result.push(...optimizedHistory);
    if (lastUserMessage) result.push(lastUserMessage);

    return result;
  }

  selectOptimalHistory(conversationHistory, maxTokens) {
    let usedTokens = 0;
    const selectedHistory = [];

    for (let i = conversationHistory.length - 1; i >= 0; i--) {
      const message = conversationHistory[i];
      const messageTokens = this.estimateTokens(message.content) + 4;

      if (usedTokens + messageTokens <= maxTokens) {
        selectedHistory.unshift(message);
        usedTokens += messageTokens;
      } else {
        break;
      }
    }

    return selectedHistory;
  }

  truncateTextIntelligently(text, maxTokens) {
    if (!text || typeof text !== 'string') return '';
    const maxChars = maxTokens * 3.5; // Conservative estimate
    if (text.length <= maxChars) return text;

    const sentences = text.split(/[.!?]+/);
    for (let i = sentences.length - 1; i >= 0; i--) {
      const candidate = sentences.slice(i).join('.').trim() + '.';
      if (candidate.length <= maxChars) {
        return candidate;
      }
    }

    return text.substring(0, maxChars) + '...';
  }

  validateModel(model) {
    const modelMapping = {
      'free': 'command-light',
      'default': 'command-r',
      'gpt-3.5-turbo': 'command-r',
      'gpt-4': 'command-r-plus',
      'text-davinci-003': 'command',
      'claude': 'command-r',
      'cohere': 'command-r'
    };

    let cleanModel = model.replace('cohere/', '').toLowerCase().trim();
    if (modelMapping[cleanModel]) {
      cleanModel = modelMapping[cleanModel];
    }

    if (!this.supportedModels.has(cleanModel)) {
      throw new Error(`Model ${model} is not supported. Supported models: ${Array.from(this.supportedModels).join(', ')}`);
    }

    return cleanModel;
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

    process.on('uncaughtException', (error) => {
      console.error('[UNCAUGHT_EXCEPTION]:', error);
      setTimeout(() => process.exit(1), 1000);
    });

    process.on('unhandledRejection', (reason, promise) => {
      console.error('[UNHANDLED_REJECTION] at:', promise, 'reason:', reason);
      setTimeout(() => process.exit(1), 1000);
    });

    // Graceful shutdown
    let server;
    process.on('SIGTERM', () => {
      console.log('[INFO] SIGTERM signal received: closing HTTP server');
      server?.close(() => {
        console.log('[INFO] HTTP server closed');
        process.exit(0);
      });
    });

    this.start = () => {
      return new Promise((resolve) => {
        server = this.app.listen(this.port, () => {
          console.log(`✅ Cohere proxy server (v2.3.0) running at http://localhost:${this.port}`);
          console.log(`📊 Health check available at http://localhost:${this.port}/health`);
          console.log(`🔐 Rate limiting: ${this.RATE_LIMIT_MAX_REQUESTS} requests per ${this.RATE_LIMIT_WINDOW_MS / 1000} seconds per IP`);
          console.log(`🎯 Token limits: ${this.MAX_TOTAL_TOKENS} total, ${this.MAX_COMPLETION_TOKENS} max completion`);
          console.log(`⚡ Improved token handling and intelligent truncation active`);
          resolve(server);
        });
      });
    };
  }
}

// Start the server
if (require.main === module) {
  const server = new CohereProxyServer();
  server.start().catch(console.error);
}

module.exports = CohereProxyServer;
