# Cohere Proxy Server Architecture

## Overview

The Cohere Proxy Server translates OpenAI-compatible requests to Cohere's API, providing token estimation, dynamic model support, robust error handling, and production-grade reliability.

## Architecture

- **Stateless, horizontally scalable, Docker-ready**
- **Endpoints:** `/v1/chat/completions`, `/health`
- **Class-based design:** [`CohereProxyServer`](../index.js:22) manages all server logic
- **Async Initialization:** Supported models are fetched asynchronously in the `start` method, not in the constructor, ensuring proper startup sequencing.
- **Modular Handlers:** Request processing is broken into small, focused methods for validation, transformation, API calls, error handling, and response formatting.

## Request Flow

1. Client sends OpenAI-format request.
2. Middleware applies security, rate limiting, CORS, logging, and parsing.
3. Input is validated and converted to Cohere format.
4. Supported models are checked (with fallback to defaults if API fails).
5. Cohere API is called using the correct method (`models.list()` for models, `generate()` for completions).
6. Response is processed, tokens estimated, and formatted for the client.
7. Errors are handled with specific status codes and error types.

## Key Components

- **Security:** Helmet, CORS, rate limiting, API key validation
- **Monitoring:** Morgan logging, health endpoint, performance metrics
- **Validation:** Parameter, range, and model validation
- **Transformation:** Converts OpenAI messages to Cohere format
- **Error Handling:** Structured error responses by category, with processing time and error type
- **Caching:** In-memory cache for prompt responses
- **Token Management:** Smart estimation, overflow handling, and allocation for prompt and completion tokens
- **Fallback Handling:** Uses default models if Cohere API is unavailable

## Configuration

All configuration is via environment variables:
- `PORT`
- `COHERE_API_KEY`
- `ALLOWED_ORIGINS`
- `MAX_TOTAL_TOKENS`
- `MIN_COMPLETION_TOKENS`
- `MAX_COMPLETION_TOKENS`
- `TOKEN_SAFETY_BUFFER`
- `RATE_LIMIT_WINDOW_MS`
- `RATE_LIMIT_MAX_REQUESTS`

## Deployment

- Graceful shutdown on SIGTERM/SIGINT
- Health check endpoint at `/health`
- Dockerfile for containerization

## Testing

- Unit and integration tests for all major features
- Performance/load tests

## Extension Points

- Add custom middleware in `setupMiddleware`
- Add new endpoints in `setupRoutes`
- Enhance responses with additional metadata

## Monitoring

- Structured request and error logging
- Metrics: response time, token usage, error rates

## Recent Improvements

- **API compatibility:** Uses `models.list()` instead of deprecated `listModels()`
- **Async/await patterns:** No async logic in constructor; all async initialization in `start`
- **Enhanced error handling:** Specific status codes and error types, with processing time in responses
- **Code modularity:** Main handler split into focused methods
- **Token management:** Comprehensive estimation and overflow handling
- **Fallbacks:** Default models used if Cohere API is unavailable
- **Modern JavaScript:** Deprecated methods replaced, clean destructuring, and best practices throughout
