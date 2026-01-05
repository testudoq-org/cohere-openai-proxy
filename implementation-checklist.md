# Embed 429 Mitigation - Implementation Checklist

**Target**: Eliminate 429 errors on /v1/embed endpoint  
**Priority**: HIGH - Blocks test execution and chat CLI functionality

## Phase 1: Core Rate Limiting Infrastructure

### 1.1 Create Embedding Queue Service
- **Mode**: Code Mode
- **Files**: `src/services/embeddingQueue.mjs`
- **Behavior**: Singleton service with strict concurrency control
- **Acceptance**: Queue processes max 1 concurrent request, handles 429 with backoff
- **Instruction**: Create dedicated embedding queue service with rate limiting

### 1.2 Update Direct Embed Endpoint  
- **Mode**: Code Mode
- **Files**: `src/index.mjs` (lines 217-260)
- **Behavior**: Replace direct `cohere.embed()` calls with queue service
- **Acceptance**: `/v1/embed` endpoint uses queue, maintains API compatibility
- **Instruction**: Modify embed endpoint to use new embedding queue service

### 1.3 Update RAG Embedding Queue
- **Mode**: Code Mode  
- **Files**: `src/ragDocumentManager.mjs` (lines 118-162)
- **Behavior**: Replace batch embedding calls with queue service
- **Acceptance**: RAG manager uses embedding queue, reduces concurrent requests
- **Instruction**: Update RAG embedding to use new queue service

### 1.4 Enhance Retry Logic for 429s
- **Mode**: Code Mode
- **Files**: `src/utils/retry.mjs` (lines 64-74)
- **Behavior**: Extend retryOn predicate to handle 429 status codes
- **Acceptance**: 429 errors trigger exponential backoff retry
- **Instruction**: Add 429 handling to existing retry logic

## Phase 2: HTTP and Concurrency Optimization

### 2.1 Implement Adaptive HTTP Agent
- **Mode**: Code Mode
- **Files**: `src/utils/httpAgent.mjs`
- **Behavior**: Separate HTTP agent for embedding with lower concurrency
- **Acceptance**: Embedding requests use dedicated agent with max 5 sockets
- **Instruction**: Create separate HTTP agent for embedding requests

### 2.2 Reduce RAG Batch Size
- **Mode**: Code Mode
- **Files**: `src/ragDocumentManager.mjs` (line 22)
- **Behavior**: Change `maxEmbeddingBatch` from 24 to 4
- **Acceptance**: RAG processing handles smaller batches
- **Instruction**: Reduce RAG embedding batch size for stability

### 2.3 Add Environment Configuration
- **Mode**: Code Mode
- **Files**: Environment variables and config files
- **Behavior**: Add `EMBED_CONCURRENCY`, `EMBED_RATE_LIMIT_*` variables
- **Acceptance**: Queue behavior configurable via environment
- **Instruction**: Add environment configuration for embedding rate limiting

## Phase 3: Testing and Validation

### 3.1 Update Existing Embedding Tests
- **Mode**: Vitest Engineer & Unit Tester
- **Files**: `test/embeddings-rerank.test.mjs`
- **Behavior**: Add rate limiting test cases
- **Acceptance**: Tests verify 429 handling and retry behavior
- **Instruction**: Add rate limiting tests to existing test suite

### 3.2 Create Queue Service Tests
- **Mode**: Vitest Engineer & Unit Tester  
- **Files**: `test/embedding-queue.test.mjs`
- **Behavior**: Comprehensive tests for queue service
- **Acceptance**: Queue service thoroughly tested with mock 429 responses
- **Instruction**: Create comprehensive test suite for embedding queue

### 3.3 Replicate Rate Limiting Scenarios
- **Mode**: Debug Mode
- **Files**: Local test environment setup
- **Behavior**: Simulate high-load scenarios to validate fix
- **Acceptance**: 429 errors eliminated under test conditions
- **Instruction**: Replicate rate limiting scenarios locally for validation

### 3.4 Code Review and Validation
- **Mode**: Code Reviewer
- **Files**: All modified implementation files
- **Behavior**: Review implementation against acceptance criteria
- **Acceptance**: Code meets quality standards and functional requirements
- **Instruction**: Validate implementation meets all acceptance criteria

## Phase 4: Integration and Monitoring

### 4.1 Integrate Metrics Collection
- **Mode**: Code Mode
- **Files**: Queue service and metrics integration
- **Behavior**: Add queue performance metrics to Prometheus
- **Acceptance**: Queue metrics available via `/metrics` endpoint
- **Instruction**: Add metrics collection for queue performance

### 4.2 Performance Validation
- **Mode**: Performance Reviewer
- **Files**: Chat CLI integration points
- **Behavior**: Verify no regression in chat CLI performance
- **Acceptance**: Chat responses remain under 2 seconds
- **Instruction**: Validate chat CLI performance is not degraded

### 4.3 Security Review
- **Mode**: Security Reviewer
- **Files**: Queue service and rate limiting logic
- **Behavior**: Ensure rate limiting doesn't introduce vulnerabilities
- **Acceptance**: No new security risks introduced
- **Instruction**: Review rate limiting implementation for security issues

## Acceptance Criteria Validation

- [ ] Tests related to `/v1/embed` no longer fail due to 429 errors
- [ ] Using coherelab-cohere agent and model gets correct reply in roocode chat CLI
- [ ] Embedding queue processes requests with controlled concurrency
- [ ] 429 responses are handled gracefully with exponential backoff
- [ ] Performance impact is minimal and acceptable
- [ ] All existing functionality remains intact

## Risk Mitigation

- **Low Risk**: Existing API interface preserved, no breaking changes
- **Medium Risk**: RAG indexing performance may be reduced but stability improved
- **Rollback Plan**: Can disable queue service and revert to direct calls if needed

## Final Verification

- [ ] All tests pass without 429 errors
- [ ] Chat CLI functionality verified with coherelab-cohere agent
- [ ] Performance benchmarks meet requirements
- [ ] Production deployment ready
