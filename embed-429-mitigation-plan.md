# Embed 429 Rate Limiting Mitigation Plan

**Generated**: 2026-01-03T19:03:53Z  
**Status**: Ready for Implementation  
**Target**: Eliminate 429 errors on /v1/embed endpoint for tests and roocode chat CLI

## Executive Summary

The 429 "Too Many Requests" errors on `/v1/embed` endpoint are caused by excessive concurrent embedding requests overwhelming the Cohere API. The current implementation has no dedicated rate limiting for embeddings and processes batches with high concurrency (up to 24 items concurrently). 

**Root Cause**: Multiple code paths call `/v1/embed` simultaneously without coordination:
1. Direct `/v1/embed` endpoint calls (src/index.mjs:217-260)
2. RAG embedding queue processing (src/ragDocumentManager.mjs:118-162) 
3. Chat conversation RAG context retrieval (src/conversationManager.mjs)
4. Background indexing jobs

**Surgical Fix**: Implement a dedicated embedding queue with strict concurrency limits and intelligent rate limiting.

## Root Cause Analysis

### Files and Code Paths Responsible for /v1/embed Calls

#### 1. **Direct Embed Endpoint** (`src/index.mjs:217-260`)
```javascript
// Line 247: Direct Cohere API call without rate limiting
const resp = await this.cohere.embed(payload);
```
- **Issue**: No request queuing or rate limiting
- **Impact**: All direct /v1/embed requests hit API immediately

#### 2. **RAG Embedding Queue** (`src/ragDocumentManager.mjs:118-162`)
```javascript
// Line 122: Processes up to 24 items concurrently
const batch = this.embeddingQueue.splice(0, this.maxEmbeddingBatch);

// Line 129: Direct API call with basic retry only
const resp = await this._callEmbedApi(texts);
```
- **Issue**: `maxEmbeddingBatch = 24` can create 24 concurrent API calls
- **Impact**: Batch processing floods the API

#### 3. **Retry Logic** (`src/utils/retry.mjs:64-74`)
```javascript
// Lines 68-69: Only retries on 5xx errors, ignores 429
if (typeof err.status === 'number') return err.status >= 500;
if (typeof err.statusCode === 'number') return err.statusCode >= 500;
```
- **Issue**: 429 status codes are not retried
- **Impact**: Rate limit failures immediately fail instead of retrying

#### 4. **HTTP Agent Configuration** (`src/utils/httpAgent.mjs:15`)
```javascript
export const OUTBOUND_MAX_SOCKETS = Number(process.env.OUTBOUND_MAX_SOCKETS) || 150;
```
- **Issue**: Allows 150 concurrent connections to all external APIs
- **Impact**: Can overwhelm single API endpoint

### Current Rate Limiting Behavior

| Component | Current Behavior | Rate Limit Handling |
|-----------|------------------|-------------------|
| Direct /v1/embed | No queuing | None - immediate failure |
| RAG Queue | Batches of 24 | Basic retry only, no 429 handling |
| Retry Logic | Exponential backoff | Only retries 5xx errors |
| HTTP Agent | 150 max sockets | Generic, not API-specific |

## Git Stash Analysis

**Note**: Git stash inspection requires command execution. For the next mode to run:

```bash
# List available stashes
git stash list

# Inspect the last 3 stashes for rate limiting changes
git stash show -p stash@{0}
git stash show -p stash@{1} 
git stash show -p stash@{2}

# Look for changes related to:
# - rate limiting
# - request batching
# - embedding queue modifications
# - retry logic enhancements
# - HTTP agent configurations
```

**Expected findings**: The last 2-3 stashes may contain partial rate limiting implementations or queue modifications that need to be integrated into a comprehensive solution.

## Surgical Implementation Plan

### Primary Surgical Fix

**Implement Dedicated Embedding Queue Service with Rate Limiting**

**Rationale**: 
- Addresses root cause by centralizing all embedding requests
- Provides strict concurrency control (1-2 concurrent requests max)
- Enables intelligent rate limiting based on 429 responses
- Minimal risk - maintains existing API interface

**Implementation Location**: New service file `src/services/embeddingQueue.mjs`

**Key Features**:
- Singleton queue service shared across all embedding use cases
- Strict concurrency limit (configurable via env: `EMBED_CONCURRENCY=1`)
- Automatic 429 detection and exponential backoff
- Request deduplication via existing LruTtlCache
- Metrics and monitoring integration

### Complementary Mitigations

#### 1. **Enhanced Retry Logic for 429s**
**Location**: `src/utils/retry.mjs`
- **Change**: Extend `retryOn` predicate to handle 429 status codes
- **Benefit**: Existing retry mechanism handles rate limits intelligently
- **Risk**: Low - only extends existing functionality

#### 2. **Adaptive HTTP Agent for Embeddings**
**Location**: `src/utils/httpAgent.mjs`
- **Change**: Create separate agent for embedding requests with lower concurrency
- **Benefit**: Prevents embeddings from consuming all available connections
- **Risk**: Low - configuration change only

#### 3. **RAG Queue Concurrency Reduction**
**Location**: `src/ragDocumentManager.mjs:22`
- **Change**: Reduce `maxEmbeddingBatch` from 24 to 4 for embeddings
- **Benefit**: Reduces burst capacity, works with new queue service
- **Risk**: Medium - affects RAG indexing performance but improves stability

## Implementation Checklist

### Phase 1: Core Rate Limiting Infrastructure
- [ ] **Code Mode**: Create `src/services/embeddingQueue.mjs` with dedicated service
- [ ] **Code Mode**: Modify `/v1/embed` endpoint to use embedding queue
- [ ] **Code Mode**: Update `ragDocumentManager.mjs` to use embedding queue
- [ ] **Code Mode**: Enhance retry logic to handle 429 status codes

### Phase 2: HTTP and Concurrency Optimization
- [ ] **Code Mode**: Implement adaptive HTTP agent for embedding requests
- [ ] **Code Mode**: Reduce RAG embedding batch size from 24 to 4
- [ ] **Code Mode**: Add environment configuration for embedding concurrency

### Phase 3: Testing and Validation
- [ ] **Vitest Engineer & Unit Tester**: Add rate limiting tests to `test/embeddings-rerank.test.mjs`
- [ ] **Vitest Engineer & Unit Tester**: Create new test file for embedding queue service
- [ ] **Debug Mode**: Replicate rate limiting scenarios locally
- [ ] **Code Reviewer**: Validate implementation meets acceptance criteria

### Phase 4: Integration and Monitoring
- [ ] **Code Mode**: Integrate metrics collection for queue performance
- [ ] **Performance Reviewer**: Verify no regression in chat CLI performance
- [ ] **Security Reviewer**: Ensure rate limiting doesn't expose new vulnerabilities

## Test Modifications

### Existing Test Updates
**File**: `test/embeddings-rerank.test.mjs`

```javascript
// Add new test for rate limiting behavior
it('handles 429 rate limit responses gracefully', async () => {
  // Mock 429 response then success
  const mockCohere = {
    embed: vi.fn()
      .mockRejectedValueOnce({ statusCode: 429, message: 'Rate limit exceeded' })
      .mockResolvedValueOnce({ body: { embeddings: [[0.1, 0.2]] } })
  };
  
  // Test that requests retry and eventually succeed
  const res = await request(app)
    .post('/v1/embed')
    .send({ input: 'test', model: 'embed-english-v3.0' })
    .expect(200);
    
  expect(res.body.data).toHaveLength(1);
});
```

### New Test File: `test/embedding-queue.test.mjs`
```javascript
describe('Embedding Queue Service', () => {
  it('processes requests with strict concurrency limit');
  it('handles 429 responses with exponential backoff');
  it('deduplicates identical embedding requests');
  it('maintains performance under load');
});
```

## Environment Configuration

Add new environment variables:
```bash
# Embedding queue configuration
EMBED_CONCURRENCY=1              # Max concurrent embedding requests
EMBED_RATE_LIMIT_WINDOW_MS=60000 # Rate limit window (1 minute)
EMBED_RATE_LIMIT_MAX_REQUESTS=50 # Max requests per window
EMBED_QUEUE_TIMEOUT_MS=30000     # Queue timeout per request
```

## Expected Outcomes

1. **429 Elimination**: `/v1/embed` tests return 200 OK consistently
2. **Performance Maintained**: Chat CLI responses remain under 2 seconds
3. **Reliability**: No rate limit failures in production
4. **Observability**: Queue metrics available via `/metrics` endpoint

## Risk Assessment

| Risk Level | Mitigation | Impact |
|------------|------------|---------|
| Low | Existing API interface preserved | No breaking changes |
| Medium | Reduced batch size may slow RAG indexing | Acceptable trade-off for stability |
| Low | New queue service adds complexity | Well-isolated, testable component |

---

**Next Steps**: Proceed with Phase 1 implementation using Code Mode to create the embedding queue service.