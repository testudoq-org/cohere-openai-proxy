/**
 * Cohere Proxy Server
 * 
 * A production-ready Express.js server that acts as a proxy between OpenAI-compatible 
 * chat completion requests and Cohere's API. This server translates OpenAI's chat 
 * completion format to Cohere's generate API format and returns OpenAI-compatible responses.
 * 
 * Features:
 * - OpenAI Chat Completions API compatibility
 * - Rate limiting and security middleware
 * - Comprehensive error handling and validation
 * - Health monitoring endpoint
 * - Request logging and performance tracking
 * - Support for multiple Cohere models
 * - Token usage estimation
 * 
 * Usage:
 * POST /v1/chat/completions - Main chat completion endpoint
 * GET /health - Health check endpoint
 * 
 * Environment Variables:
 * - COHERE_API_KEY: Your Cohere API key (required)
 * - PORT: Server port (default: 3000)
 * - ALLOWED_ORIGINS: Comma-separated list of allowed CORS origins (default: *)
 * 
 * @author Assistant
 * @version 2.0.1
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { CohereClient } = require('cohere-ai');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const morgan = require('morgan');

class CohereProxyServer {
  constructor() {
    this.app = express();
    this.port = process.env.PORT || 3000;
    this.cohere = new CohereClient({
      token: process.env.COHERE_API_KEY,
    });
    
    this.setupMiddleware();
    this.setupRoutes();
    this.setupErrorHandling();
  }

  setupMiddleware() {
    // Security middleware
    this.app.use(helmet());
    
    // Logging middleware
    this.app.use(morgan('combined'));
    
    // Rate limiting
    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 100, // limit each IP to 100 requests per windowMs
      message: {
        error: {
          message: 'Too many requests from this IP, please try again later.',
          type: 'rate_limit_exceeded'
        }
      }
    });
    this.app.use(limiter);
    
    // CORS configuration
    this.app.use(cors({
      origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
      methods: ['GET', 'POST'],
      allowedHeaders: ['Content-Type', 'Authorization']
    }));
    
    // Body parsing
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));
  }

  setupRoutes() {
    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
      });
    });

    // Main chat completions endpoint
    this.app.post('/v1/chat/completions', this.handleChatCompletion.bind(this));
    
    // Fallback for undefined routes - Fixed to avoid path-to-regexp issues
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
    try {
      // Validate API key
      if (!process.env.COHERE_API_KEY) {
        return res.status(500).json({
          error: {
            message: 'Cohere API key not configured',
            type: 'configuration_error'
          }
        });
      }

      // Extract and validate request parameters
      const {
        messages,
        temperature = 0.7,
        max_tokens = 300,
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

      // Validate temperature and max_tokens
      if (temperature < 0 || temperature > 2) {
        return res.status(400).json({
          error: {
            message: 'Temperature must be between 0 and 2',
            type: 'invalid_request_error'
          }
        });
      }

      if (max_tokens < 1 || max_tokens > 4096) {
        return res.status(400).json({
          error: {
            message: 'max_tokens must be between 1 and 4096',
            type: 'invalid_request_error'
          }
        });
      }

      const validatedModel = this.validateModel(model);
      const startTime = Date.now();
      
      // Use appropriate API based on model type
      let response;
      let generatedText;
      
      if (this.isChatModel(validatedModel)) {
        // Use Chat API for newer models
        const cohereMessages = this.formatMessagesForCohereChat(messages);
        
        response = await this.cohere.chat({
          model: validatedModel,
          message: cohereMessages.message,
          chatHistory: cohereMessages.chatHistory,
          temperature,
          maxTokens: max_tokens
        });
        
        generatedText = response.text.trim();
      } else {
        // Use Generate API for older models
        const prompt = this.formatMessagesForCohere(messages);
        
        response = await this.cohere.generate({
          model: validatedModel,
          prompt,
          temperature,
          maxTokens: max_tokens,
          returnLikelihoods: 'NONE'
        });
        
        generatedText = response.generations[0].text.trim();
      }

      const processingTime = Date.now() - startTime;

      // Estimate token usage (rough approximation)
      const promptTokens = this.estimateTokens(JSON.stringify(messages));
      const completionTokens = this.estimateTokens(generatedText);

      // Return OpenAI-compatible response
      const completionResponse = {
        id: `chatcmpl-${this.generateId()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: `cohere/${model}`,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: generatedText,
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
        system_fingerprint: `cohere_${model}_${Date.now()}`,
        processing_time_ms: processingTime
      };

      res.json(completionResponse);

    } catch (error) {
      console.error('Error in chat completion:', {
        message: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString()
      });

      // Handle different types of errors
      let statusCode = 500;
      let errorType = 'internal_server_error';

      if (error.message.includes('API key')) {
        statusCode = 401;
        errorType = 'authentication_error';
      } else if (error.message.includes('rate limit') || error.message.includes('quota')) {
        statusCode = 429;
        errorType = 'rate_limit_exceeded';
      } else if (error.message.includes('model')) {
        statusCode = 400;
        errorType = 'invalid_request_error';
      }

      res.status(statusCode).json({
        error: {
          message: error.message || 'An unexpected error occurred',
          type: errorType,
          timestamp: new Date().toISOString()
        }
      });
    }
  }

  formatMessagesForCohere(messages) {
    // Convert OpenAI chat format to Cohere prompt format (for Generate API)
    let prompt = '';
    
    for (const message of messages) {
      if (message.role === 'system') {
        prompt += `System: ${message.content}\n\n`;
      } else if (message.role === 'user') {
        prompt += `Human: ${message.content}\n\n`;
      } else if (message.role === 'assistant') {
        prompt += `Assistant: ${message.content}\n\n`;
      }
    }
    
    prompt += 'Assistant:';
    return prompt;
  }

  formatMessagesForCohereChat(messages) {
    // Convert OpenAI chat format to Cohere Chat API format
    const chatHistory = [];
    let currentMessage = '';
    let systemMessage = '';
    
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      
      if (message.role === 'system') {
        systemMessage = message.content;
      } else if (message.role === 'user') {
        if (i === messages.length - 1) {
          // This is the current user message
          currentMessage = systemMessage ? `${systemMessage}\n\n${message.content}` : message.content;
        } else {
          // This is part of chat history
          chatHistory.push({
            role: 'USER',
            message: message.content
          });
        }
      } else if (message.role === 'assistant') {
        chatHistory.push({
          role: 'CHATBOT',
          message: message.content
        });
      }
    }
    
    return {
      message: currentMessage,
      chatHistory: chatHistory
    };
  }

  isChatModel(model) {
    // Models that require Chat API instead of Generate API
    const chatModels = [
      'command-r',
      'command-r-plus'
    ];
    
    return chatModels.includes(model);
  }

  validateModel(model) {
    const allowedModels = [
      // Chat API models
      'command-r',
      'command-r-plus',
      // Generate API models (older)
      'command',
      'command-nightly',
      'command-light',
      'command-light-nightly'
    ];
    
    const cleanModel = model.replace('cohere/', '');
    
    if (!allowedModels.includes(cleanModel)) {
      throw new Error(`Model ${model} is not supported. Supported models: ${allowedModels.join(', ')}`);
    }
    
    return cleanModel;
  }

  estimateTokens(text) {
    // Rough estimation: 1 token ≈ 4 characters for English text
    return Math.ceil(text.length / 4);
  }

  generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }

  setupErrorHandling() {
    // Global error handler
    this.app.use((error, req, res, next) => {
      console.error('Unhandled error:', {
        message: error.message,
        stack: error.stack,
        url: req.url,
        method: req.method,
        timestamp: new Date().toISOString()
      });

      res.status(500).json({
        error: {
          message: 'Internal server error',
          type: 'internal_server_error'
        }
      });
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      console.error('Uncaught Exception:', error);
      process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
      console.error('Unhandled Rejection at:', promise, 'reason:', reason);
      process.exit(1);
    });
  }

  start() {
    return new Promise((resolve) => {
      const server = this.app.listen(this.port, () => {
        console.log(`✅ Cohere proxy server running at http://localhost:${this.port}`);
        console.log(`📊 Health check available at http://localhost:${this.port}/health`);
        console.log(`🔐 Rate limiting: 100 requests per 15 minutes per IP`);
        resolve(server);
      });
    });
  }
}

// Start the server
if (require.main === module) {
  const server = new CohereProxyServer();
  server.start().catch(console.error);
}

module.exports = CohereProxyServer;
