//index.js
//Enhanced Cohere Proxy Server with Full RAG Integration
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { CohereClient } = require("cohere-ai");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const morgan = require("morgan");
const { encoding_for_model } = require("tiktoken");
const fs = require("fs").promises;
const path = require("path");
const crypto = require("crypto");

// Validate required environment variables
const requiredEnvVars = ["COHERE_API_KEY"];
for (const varName of requiredEnvVars) {
  if (!process.env[varName]) {
    throw new Error(`Missing required environment variable: ${varName}`);
  }
}

const MemoryCache = require("./memoryCache");

const RAGDocumentManager = require("./ragDocumentManager");

const ConversationManager = require("./conversationManager");

// Enhanced Cohere Proxy Server with Full RAG Integration
class EnhancedCohereRAGServer {
  constructor() {
    this.app = express();
    this.port = process.env.PORT || 3000;
    this.cohere = new CohereClient({
      token: process.env.COHERE_API_KEY,
    });

    // Initialize RAG components
    this.ragManager = new RAGDocumentManager(this.cohere);
    this.conversationManager = new ConversationManager(this.ragManager);

    this.tokenizer = encoding_for_model("gpt-3.5-turbo");
    this.supportedModels = new Set();

    // Configuration
    this.MAX_TOTAL_TOKENS = parseInt(process.env.MAX_TOTAL_TOKENS) || 4000;
    this.MIN_COMPLETION_TOKENS =
      parseInt(process.env.MIN_COMPLETION_TOKENS) || 50;
    this.MAX_COMPLETION_TOKENS =
      parseInt(process.env.MAX_COMPLETION_TOKENS) || 2048;
    this.TOKEN_SAFETY_BUFFER = parseInt(process.env.TOKEN_SAFETY_BUFFER) || 100;

    this.RATE_LIMIT_WINDOW_MS =
      parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;
    this.RATE_LIMIT_MAX_REQUESTS =
      parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100;

    this.promptCache = new MemoryCache(5 * 60 * 1000, 500);

    this.setupMiddleware();
    this.setupRoutes();
    this.setupErrorHandling();
  }

  async initializeSupportedModels() {
    try {
      const response = await this.cohere.models.list();
      this.supportedModels = new Set(
        response.models.map((model) => model.name)
      );
      console.log(
        "[INFO] Supported Cohere models:",
        Array.from(this.supportedModels).join(", ")
      );
    } catch (error) {
      console.error("[ERROR] Failed to fetch supported models:", error.message);
      this.supportedModels = new Set([
        "command-r-plus",
        "command-r",
        "command",
      ]);
      console.log(
        "[INFO] Using default models:",
        Array.from(this.supportedModels).join(", ")
      );
    }
  }

  setupMiddleware() {
    this.app.use(helmet());
    this.app.use(morgan("combined"));

    const limiter = rateLimit({
      windowMs: this.RATE_LIMIT_WINDOW_MS,
      max: this.RATE_LIMIT_MAX_REQUESTS,
      message: {
        error: {
          message: "Too many requests from this IP, please try again later.",
          type: "rate_limit_exceeded",
        },
      },
    });
    this.app.use(limiter);

    this.app.use(
      cors({
        origin: process.env.ALLOWED_ORIGINS?.split(",") || "*",
        methods: ["GET", "POST", "DELETE"],
        allowedHeaders: ["Content-Type", "Authorization"],
      })
    );

    this.app.use(express.json({ limit: "10mb" }));
    this.app.use(express.urlencoded({ extended: true }));
  }

  setupRoutes() {
    // Enhanced health check with RAG stats
    this.app.get("/health", (req, res) => {
      const conversationStats = this.conversationManager.getStats();
      const ragStats = this.ragManager.getStats();

      res.json({
        status: "healthy",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        conversation_stats: conversationStats,
        rag_stats: ragStats,
        limits: {
          max_total_tokens: this.MAX_TOTAL_TOKENS,
          max_completion_tokens: this.MAX_COMPLETION_TOKENS,
          min_completion_tokens: this.MIN_COMPLETION_TOKENS,
          token_safety_buffer: this.TOKEN_SAFETY_BUFFER,
        },
        version: "3.0.0-rag",
      });
    });

    // Main chat completions endpoint with RAG enhancement
    this.app.post("/v1/chat/completions", this.handleChatCompletion.bind(this));

    // RAG management endpoints
    this.setupRAGRoutes();

    // Conversation management endpoints (preserved from original)
    this.setupConversationRoutes();

    // 404 handler
    this.app.use((req, res) => {
      res.status(404).json({
        error: {
          message: `Route ${req.method} ${req.path} not found`,
          type: "not_found",
        },
      });
    });
  }

  setupRAGRoutes() {
    // Route to index a codebase
    this.app.post("/v1/rag/index", async (req, res) => {
      try {
        const { projectPath, options } = req.body;
        if (
  typeof projectPath !== "string" ||
  !projectPath.trim() ||
  projectPath.includes("..") ||
  projectPath.startsWith("/") ||
  projectPath.startsWith("\\")
) {
          return res.status(400).json({
            error: {
              message: "Project path is required",
              type: "invalid_request_error",
            },
          });
        }

        const result = await this.ragManager.indexCodebase(
          projectPath,
          options
        );
        res.json({ success: true, result });
      } catch (error) {
        console.error("[ERROR] Failed to index codebase:", error);
        res.status(500).json({
          error: {
            message: "Failed to index codebase",
            type: "internal_server_error",
          },
        });
      }
    });

    // Route to clear RAG index
    this.app.delete("/v1/rag/index", (req, res) => {
      try {
        this.ragManager.clearIndex();
        res.json({ success: true, message: "RAG index cleared" });
      } catch (error) {
        console.error("[ERROR] Failed to clear RAG index:", error);
        res.status(500).json({
          error: {
            message: "Failed to clear RAG index",
            type: "internal_server_error",
          },
        });
      }
    });

    // Route to get RAG stats
    this.app.get("/v1/rag/stats", (req, res) => {
      try {
        const stats = this.ragManager.getStats();
        res.json({ success: true, stats });
      } catch (error) {
        console.error("[ERROR] Failed to get RAG stats:", error);
        res.status(500).json({
          error: {
            message: "Failed to get RAG stats",
            type: "internal_server_error",
          },
        });
      }
    });
  }

  setupConversationRoutes() {
    // Route to add feedback to a conversation
    this.app.post("/v1/conversations/:sessionId/feedback", (req, res) => {
      try {
        const { sessionId } = req.params;
        const { feedback, type = "correction" } = req.body;

        if (!feedback) {
          return res.status(400).json({
            error: {
              message: "Feedback is required",
              type: "invalid_request_error",
            },
          });
        }

        const message = this.conversationManager.addFeedback(
          sessionId,
          feedback,
          type
        );
        res.json({ success: true, message });
      } catch (error) {
        console.error("[ERROR] Failed to add feedback:", error);
        res.status(500).json({
          error: {
            message: "Failed to add feedback",
            type: "internal_server_error",
          },
        });
      }
    });

    // Route to get conversation history
    this.app.get("/v1/conversations/:sessionId/history", (req, res) => {
      try {
        const { sessionId } = req.params;
        const messages = this.conversationManager.getConversation(sessionId);
        res.json({ sessionId, messages, count: messages.length });
      } catch (error) {
        console.error("[ERROR] Failed to get conversation:", error);
        res.status(500).json({
          error: {
            message: "Failed to get conversation",
            type: "internal_server_error",
          },
        });
      }
    });

    // Route to clear conversation history
    this.app.delete("/v1/conversations/:sessionId", (req, res) => {
      try {
        const { sessionId } = req.params;
        this.conversationManager.conversations.delete(sessionId);
        res.json({ success: true, message: "Conversation cleared" });
      } catch (error) {
        console.error("[ERROR] Failed to clear conversation:", error);
        res.status(500).json({
          error: {
            message: "Failed to clear conversation",
            type: "internal_server_error",
          },
        });
      }
    });
  }

  // Enhanced chat completion handler with RAG support
  async handleChatCompletion(req, res) {
    const startTime = Date.now();
    console.log("[INFO] Received chat completion request:", req.body);

    // Track attempt history for this request
    const attemptHistory = {};

    try {
      const requestData = this.validateAndExtractRequest(req.body);
      if (!requestData || requestData.error) {
        const error = requestData?.error || {
          message: "Invalid request data",
          type: "invalid_request_error",
        };
        return res.status(400).json({ error });
      }

      const { messages, temperature, requestedMaxTokens, model, sessionId } =
        requestData;

      // Generate session ID if not provided
      const effectiveSessionId = sessionId || this.generateId();

      // Add incoming messages to conversation history
      for (const message of messages) {
        await this.conversationManager.addMessage(
          effectiveSessionId,
          message.role,
          this.extractContentString(message.content)
        );
      }

      // Get formatted conversation history with RAG context
      const conversationData =
        this.conversationManager.getFormattedHistoryWithRAG(effectiveSessionId);

      console.log("[DEBUG] Conversation data:", {
        sessionId: effectiveSessionId,
        historyLength: conversationData.chatHistory.length,
        currentMessage: conversationData.message,
      });

      // Use Cohere Chat API for multi-turn conversations with retry/circuit breaker
      const response = await this.callCohereChatAPI(
        model,
        conversationData,
        temperature,
        requestedMaxTokens,
        attemptHistory
      );

      if (!response) {
        return res.status(500).json({
          error: {
            message: "Failed to receive response from Cohere API after retries",
            type: "internal_server_error",
          },
        });
      }

      // Add assistant's response to conversation history
      const assistantResponse = response.text || "";
      this.conversationManager.addMessage(
        effectiveSessionId,
        "assistant",
        assistantResponse
      );

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
      console.error("[ERROR] Chat completion failed:", error);
      this.handleAPIError(error, res, startTime);
    }
  }

  // Validation attempt tracking to prevent repeated validation of malformed requests
  validateAndExtractRequest(body) {
    if (!this._validationAttempts) {
      this._validationAttempts = {};
    }
    const reqHash = JSON.stringify(body);
    this._validationAttempts[reqHash] = (this._validationAttempts[reqHash] || 0) + 1;

    if (this._validationAttempts[reqHash] > 3) {
      return {
        error: {
          message: "Too many invalid validation attempts for this request.",
          type: "invalid_request_error",
        },
      };
    }

    const {
      messages,
      temperature = 0.7,
      max_tokens: requestedMaxTokens,
      model = "command-r-plus",
      sessionId,
    } = body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return {
        error: {
          message: "Messages array is required and must not be empty",
          type: "invalid_request_error",
        },
      };
    }

    return { messages, temperature, requestedMaxTokens, model, sessionId };
  }

  // Call Cohere Chat API with conversation history
  async callCohereChatAPI(model, conversationData, temperature, maxTokens, attemptHistory = {}) {
    const payload = {
      model: model,
      message: conversationData.message,
      temperature: temperature || 0.7,
      max_tokens: maxTokens || 512,
    };

    // Add conversation history if available
    if (
      conversationData.chatHistory &&
      conversationData.chatHistory.length > 0
    ) {
      payload.chat_history = conversationData.chatHistory;
    }

    // Add preamble (system messages) if available
    if (conversationData.preamble) {
      payload.preamble = conversationData.preamble;
    }

    console.log("[DEBUG] Sending to Cohere Chat API:", {
      model: payload.model,
      messageLength: payload.message.length,
      historyCount: payload.chat_history?.length || 0,
      hasPreamble: !!payload.preamble,
    });

    // Circuit breaker and retry logic
    const maxAttempts = 3;
    const backoffTimes = [1000, 3000, 9000];
    let lastErrorMsg = null;
    let sameErrorCount = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (attempt > 1) {
          console.warn(`[RETRY] Attempt ${attempt} for Cohere Chat API...`);
          await new Promise((resolve) => setTimeout(resolve, backoffTimes[attempt - 2]));
        }
        const response = await this.cohere.chat(payload);
        // Track success in attemptHistory
        if (attemptHistory) {
          attemptHistory.cohereChat = (attemptHistory.cohereChat || 0) + 1;
        }
        return response;
      } catch (error) {
        const errorMsg = error?.message || String(error);
        if (errorMsg === lastErrorMsg) {
          sameErrorCount++;
        } else {
          sameErrorCount = 1;
          lastErrorMsg = errorMsg;
        }
        if (sameErrorCount >= 2) {
          console.error("[CIRCUIT BREAKER] Same error twice, switching to fallback.");
          break;
        }
        if (attempt === maxAttempts) {
          console.error("[CIRCUIT BREAKER] Max attempts reached for Cohere Chat API.");
          break;
        }
        console.error(`[ERROR] Cohere Chat API attempt ${attempt} failed:`, errorMsg);
      }
    }
    // Fallback: return null or a static error response
    return null;
  }

  // Format chat response in OpenAI-compatible format
  formatChatResponse(response, model, conversationData, startTime, sessionId) {
    const generatedText = response.text || "";
    const processingTime = Date.now() - startTime;

    // Estimate tokens (simplified)
    const promptTokens =
      this.estimateTokens(conversationData.message) +
      (conversationData.chatHistory?.length * 10 || 0);
    const completionTokens = this.estimateTokens(generatedText);

    return {
      id: `chatcmpl-${this.generateId()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: `cohere/${model}`,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: generatedText,
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
      system_fingerprint: `cohere_chat_${model}_${Date.now()}`,
      processing_time_ms: processingTime,
      session_id: sessionId, // Include session ID in response
      conversation_stats: this.conversationManager.getStats(),
    };
  }

  handleAPIError(error, res, startTime) {
    const processingTime = Date.now() - startTime;
    console.error(
      "[ERROR] Chat completion failed after",
      processingTime,
      "ms:",
      error
    );

    // More specific error handling
    let statusCode = 500;
    let errorType = "internal_server_error";
    let message = "Failed to process request";

    if (error.statusCode) {
      statusCode = error.statusCode;
      if (statusCode === 429) {
        errorType = "rate_limit_exceeded";
        message = "Rate limit exceeded";
      } else if (statusCode === 401) {
        errorType = "authentication_error";
        message = "Invalid API key";
      } else if (statusCode === 400) {
        errorType = "invalid_request_error";
        message = "Invalid request parameters";
      }
    }

    res.status(statusCode).json({
      error: {
        message,
        type: errorType,
        processing_time_ms: processingTime,
      },
    });
  }

  extractContentString(content) {
    if (typeof content === "string") {
      return content;
    }
    if (content && typeof content === "object") {
      if (content.text) {
        return content.text;
      }
      if (Array.isArray(content)) {
        return content
          .filter((part) => part && typeof part === "object" && part.text)
          .map((part) => part.text)
          .join(" ");
      }
      try {
        return JSON.stringify(content);
      } catch (e) {
        return `StringifyError: ${e?.message ?? e} | Content: ${String(
          content
        )}`;
      }
    }
    return String(content || "");
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
      console.error("[GLOBAL_ERROR] Unhandled error:", {
        message: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString(),
      });
      res.status(500).json({
        error: {
          message: "Internal server error",
          type: "internal_server_error",
          timestamp: new Date().toISOString(),
        },
      });
    });

    let server;
    process.on("SIGTERM", () => {
      console.log("[INFO] SIGTERM signal received: closing HTTP server");
      server?.close(() => {
        console.log("[INFO] HTTP server closed");
        process.exit(0);
      });
    });

    // Start method with async initialization
    this.start = async () => {
      await this.initializeSupportedModels();
      return new Promise((resolve) => {
        server = this.app.listen(this.port, () => {
          console.log(
            `Enhanced Cohere proxy server (v3.0.0-rag) running at http://localhost:${this.port}`
          );
          console.log(`Health check at http://localhost:${this.port}/health`);
          console.log("New endpoints:");
          console.log(`  POST http://localhost:${this.port}/v1/rag/index`);
          console.log(`  DEL http://localhost:${this.port}/v1/rag/index`);
          console.log(`  GET http://localhost:${this.port}/v1/rag/stats`);
          resolve(server);
        });
      });
    };
  }
}

// Start the server
if (require.main === module) {
  const server = new EnhancedCohereRAGServer();
  server.start().catch(console.error);
}

module.exports = {
  EnhancedCohereRAGServer,
  RAGDocumentManager,
  ConversationManager,
};

  /**
   * Sets up global error handling and graceful shutdown.
   */
