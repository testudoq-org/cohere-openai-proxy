# RooCode Enhancement Plan - Priority Ordered

## CRITICAL PRIORITY (Immediate Action Required)

### 🔴 Phase 1: Security Vulnerabilities (Weeks 1-2)

**Task 1: Input Validation & Sanitization** ⚠️ URGENT
- Strengthen path traversal protection in `/v1/rag/index` endpoint (line 203-213)
- Implement comprehensive request payload validation for all endpoints
- Add content-type validation and file upload size limits
- Sanitize all user inputs before processing in `validateAndExtractRequest` method (line 391-419)

**Task 2: Authentication & Authorization** ⚠️ URGENT
- Implement API key authentication middleware for all endpoints
- Add role-based access control for RAG management endpoints
- Secure conversation history access with user-specific session isolation
- Add request signing for sensitive operations

**Task 3: Data Protection** ⚠️ URGENT
- Encrypt sensitive data in memory caches (`MemoryCache` class)
- Implement secure session token generation in `generateId` method (line 573)
```markdown
# Enhancement implementation summary (updated)

This document maps recent, implemented changes to the roadmap and lists the highest-priority follow-ups.

Summary of implemented changes

- ESM migration: repository now runs as ES Modules. `package.json` includes "type": "module" and the runtime entry is `src/index.mjs`.
- Background indexing: `RAGDocumentManager.indexCodebase()` enqueues indexing jobs; indexing runs asynchronously off the HTTP request path to avoid blocking.
- Embedding cache: a small LRU+TTL cache lives in `src/utils/lruTtlCache.mjs`; embeddings are cached by hash (md5) to reduce API calls and latency.
- Semantic + fallback retrieval: semantic search uses cached embeddings; when embeddings are missing or an error occurs, the manager falls back to keyword-based search.
- Conversation manager: `ConversationManager` maintains session history with LRU-based pruning and exposes graceful shutdown hooks to avoid memory leaks.
- Structured logging & metrics: `pino` for structured logs and `prom-client` basics (HTTP counters) were added.
- Tests: Vitest unit tests and Supertest-based endpoint tests were added for core behavior (RAG manager, conversation manager, key HTTP endpoints).
- Docker & build: `build-dist.mjs` produces a `dist` layout; Dockerfile and `docker-compose.yml` were updated to run the ESM entrypoint (`node src/index.mjs`).

What was intentionally deferred (kept out of the ESM PR)

- Full schema validation (Zod/Ajv) and strict API contract enforcement — planned as a follow-up.
- A production-grade circuit-breaker library around external API calls — basic retry logic exists but a full breaker is pending.
- Persistent vector DB (Pinecone/Weaviate) integration and multi-instance distributed caching (Redis) — planned as a separate migration.
- SSE streaming chat and advanced streaming partial-response handling — considered lower-risk follow-up.

Prioritized next actions (short list)

1) Security & validation (high priority)
	- Add request schema validation for all public endpoints (AJV or Zod).
	- Add API-key auth middleware for admin/RAG operations and tighten allowed paths in `indexCodebase`.

2) Reliability & infra
	- Integrate a circuit breaker + retries around Cohere API calls and add unit tests for fallback behavior.
	- Expand Prometheus metrics (latency, token usage, embeddings cache hit rate) and add readiness/liveness endpoints.

3) Scale & persistence
	- Design and add a small abstraction layer so the RAG store can be switched from the in-memory store to Pinecone/Weaviate.
	- Add Redis for distributed embedding/result caching for multi-instance environments.

4) Tests & CI
	- Increase test coverage, add CI to run Vitest, and publish coverage reports.

Quick status / checklist (mapping user requests to status)

- Convert repo to ESM: Done
- Separate services / non-blocking indexing: Done (background queue for indexing)
- Embedding caching: Done (LRU+TTL cache)
- Semantic fallback: Done (embedding-first, keyword fallback)
- Structured logging + basic metrics: Done (pino + prom-client stub)
- Graceful shutdown + session pruning: Done
- Circuit breaker + advanced retries: Deferred (basic retries present)
- SSE streaming for chat: Deferred
- Full schema validation and per-user rate limiting: Deferred (placeholders exist)
- Tests (Vitest + Supertest): Done (core unit + endpoint tests added)

Notes

- Changes were intentionally grouped to keep the first PR focused and reviewable: ESM, background indexing, cache and basic observability.
- Follow-up PRs should be smaller and scoped: (1) schema validation + API auth, (2) circuit breaker + retries, (3) persistent vector DB + Redis.

If you'd like, I can now open follow-up PR drafts for each of the next three prioritized items and prepare checklists and unit tests for them.
```