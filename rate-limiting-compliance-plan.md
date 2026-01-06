# Rate Limiting Compliance Plan

## Executive Summary

This plan improves the existing rate limiting implementation to ensure strict compliance with Cohere's 40 API calls/minute Trial key limit and provides better monitoring and control.

## Current Implementation Analysis

### Strengths
- Token-bucket rate limiting already implemented
- Adaptive rate capping on 429 detection
- Prometheus metrics for monitoring
- Embedding queue for smoothing bursts

### Gaps
- **No unified rate limiting**: Chat and embed operations have separate limits but Cohere counts total calls
- **Limited monitoring**: No real-time rate tracking or alerting
- **Overly aggressive defaults**: 40/min for each operation could exceed 40 total when both are used
- **Insufficient buffering**: No safety margin against bursts

## Proposed Improvements

### 1. Unified Global Rate Limiter

**Problem**: Chat (40/min) + Embed (40/min) = 80/min potential, exceeding Cohere's 40/min total limit.

**Solution**: Implement a global token bucket that limits total API calls across all operations.

**Implementation**:
```javascript
// Add to cohereClientFactory.mjs
const GLOBAL_RATE_LIMIT_PER_MIN = Number(process.env.GLOBAL_RATE_LIMIT_PER_MIN) || 35;
const GLOBAL_RATE_STATE = { tokens: GLOBAL_RATE_LIMIT_PER_MIN, lastRefillMs: Date.now() };

function _consumeGlobalToken() {
  const cfg = GLOBAL_RATE_LIMIT_PER_MIN;
  const now = Date.now();
  const elapsedMs = Math.max(0, now - GLOBAL_RATE_STATE.lastRefillMs);
  
  if (elapsedMs > 0) {
    const refill = (cfg / 60000) * elapsedMs;
    GLOBAL_RATE_STATE.tokens = Math.min(cfg, GLOBAL_RATE_STATE.tokens + refill);
    GLOBAL_RATE_STATE.lastRefillMs = now;
  }
  
  if (GLOBAL_RATE_STATE.tokens >= 1) {
    GLOBAL_RATE_STATE.tokens -= 1;
    return 0;
  }
  
  // Calculate wait time for next token
  const tokensPerMs = cfg / 60000;
  const waitMs = Math.ceil((1 - GLOBAL_RATE_STATE.tokens) / tokensPerMs);
  return waitMs;
}
```

**Usage**: Call `_consumeGlobalToken()` in `makeCall()` before any Cohere API operation.

### 2. Enhanced Rate Monitoring & Compliance Dashboard

**Problem**: Difficult to verify actual call rates in real-time.

**Solution**: Add dedicated rate tracking metrics and health endpoints.

**New Prometheus Metrics**:
```javascript
// Add to cohereClientFactory.mjs
const rateLimitHits = new promClient.Counter({
  name: 'rate_limit_hits_total',
  help: 'Total requests delayed due to rate limiting',
  labelNames: ['operation', 'type'] // type: 'global' | 'operation'
});

const actualRpmGauge = new promClient.Gauge({
  name: 'cohere_actual_rpm',
  help: 'Current requests per minute to Cohere API',
  labelNames: ['window'] // '1m' | '5m'
});

// Rolling window rate calculator
const recentCalls = [];
function trackCall(operation) {
  const now = Date.now();
  recentCalls.push({ timestamp: now, operation });
  
  // Remove calls older than 1 minute
  while (recentCalls.length > 0 && (now - recentCalls[0].timestamp) > 60000) {
    recentCalls.shift();
  }
  
  // Update gauge
  actualRpmGauge.set({ window: '1m' }, recentCalls.length);
}
```

**New Health Endpoint Enhancement**:
```javascript
// Add to index.mjs health endpoint
this.app.get('/health', (req, res) => {
  const globalTokens = GLOBAL_RATE_STATE.tokens;
  const callsInLastMinute = recentCalls.length;
  
  res.json({
    status: 'healthy',
    rate_limit: {
      global_limit: GLOBAL_RATE_LIMIT_PER_MIN,
      available_tokens: Math.floor(globalTokens),
      calls_last_minute: callsInLastMinute,
      compliance_status: callsInLastMinute <= 40 ? 'OK' : 'OVER_LIMIT',
      safety_buffer: GLOBAL_RATE_LIMIT_PER_MIN - callsInLastMinute
    }
  });
});
```

### 3. Intelligent Rate Buffer & Adaptive Control

**Problem**: Fixed 35/min limit doesn't adapt to actual usage patterns.

**Solution**: Dynamic rate adjustment based on observed patterns and cooldowns.

**Implementation**:
```javascript
// Dynamic rate adjustment
let ADAPTIVE_RATE_LIMIT = GLOBAL_RATE_LIMIT_PER_MIN;
const RATE_ADJUSTMENT_COOLDOWN = 5 * 60 * 1000; // 5 minutes
let lastAdjustment = 0;

function adjustRateIfNeeded() {
  const now = Date.now();
  if (now - lastAdjustment < RATE_ADJUSTMENT_COOLDOWN) return;
  
  const recentErrors = getRecent429Count(); // Track 429s in last 5 minutes
  const callsLastMinute = recentCalls.length;
  
  if (recentErrors > 2 || callsLastMinute > ADAPTIVE_RATE_LIMIT * 0.9) {
    // Reduce rate by 10% if approaching limit or getting errors
    ADAPTIVE_RATE_LIMIT = Math.max(30, ADAPTIVE_RATE_LIMIT * 0.9);
    GLOBAL_RATE_STATE.tokens = Math.min(ADAPTIVE_RATE_LIMIT, GLOBAL_RATE_STATE.tokens);
    logger.warn({ newRate: ADAPTIVE_RATE_LIMIT }, 'Reducing rate limit due to pressure');
  } else if (recentErrors === 0 && callsLastMinute < ADAPTIVE_RATE_LIMIT * 0.5) {
    // Gradually increase rate if well under limit
    ADAPTIVE_RATE_LIMIT = Math.min(35, ADAPTIVE_RATE_LIMIT * 1.05);
    logger.info({ newRate: ADAPTIVE_RATE_LIMIT }, 'Increasing rate limit due to low usage');
  }
  
  lastAdjustment = now;
}
```

### 4. Enhanced Embedding Optimization

**Problem**: RAG operations may generate excessive embedding calls.

**Solution**: Aggressive caching and batch processing optimization.

**Improvements**:

1. **Increase Embedding Cache TTL**:
```javascript
// In embeddingQueue.mjs
const dedupCache = new LruTtlCache({ 
  ttlMs: 30 * 60 * 1000, // Increased from 10min to 30min
  maxSize: 5000, // Increased from 2000
  enableDedup: true 
});
```

2. **Batch Embedding Optimization**:
```javascript
// Group similar embedding requests
function batchEmbedRequests(requests) {
  const batches = {};
  requests.forEach(req => {
    const key = JSON.stringify(req.payload);
    if (!batches[key]) batches[key] = [];
    batches[key].push(req);
  });
  
  return Object.values(batches).map(batch => ({
    payload: batch[0].payload,
    count: batch.length
  }));
}
```

3. **Smart Cache Warming**:
```javascript
// Pre-cache common queries in RAGDocumentManager
async function warmCommonQueries() {
  const commonTerms = ['error', 'function', 'class', 'import', 'export'];
  for (const term of commonTerms) {
    await this.semanticSearch(term, { forceCache: true });
  }
}
```

## Configuration Recommendations

### Environment Variables
```bash
# Rate limiting (Trial key safe)
GLOBAL_RATE_LIMIT_PER_MIN=35
CHAT_RATE_PER_MIN=35
EMBED_RATE_PER_MIN=35

# Monitoring
ENABLE_RATE_MONITORING=1
RATE_ALERT_THRESHOLD=38

# Embedding optimization
EMBEDDING_CACHE_TTL_MS=1800000
EMBEDDING_BATCH_SIZE=10
```

### Monitoring Dashboard
Create a simple monitoring script:
```javascript
// scripts/monitor-rate-limits.mjs
async function checkRateCompliance() {
  const response = await fetch('http://localhost:3000/health');
  const health = await response.json();
  
  if (health.rate_limit.calls_last_minute > 35) {
    console.warn(`⚠️  High API usage: ${health.rate_limit.calls_last_minute}/40 calls in last minute`);
  }
  
  if (health.rate_limit.compliance_status === 'OVER_LIMIT') {
    console.error('❌ Rate limit exceeded!');
    process.exit(1);
  }
}
```

## Implementation Priority

1. **Phase 1**: Global rate limiter (1-2 hours)
2. **Phase 2**: Enhanced monitoring (2-3 hours)  
3. **Phase 3**: Adaptive rate control (3-4 hours)
4. **Phase 4**: Embedding optimization (2-3 hours)

## Success Metrics

- Zero 429 errors during normal operation
- Average API usage stays below 30/minute
- 95th percentile response time < 2 seconds
- RAG functionality remains fast with caching

## Testing Strategy

1. **Load Testing**: Simulate 40 requests/minute for 10 minutes
2. **Burst Testing**: Send 10 requests in 5 seconds, verify throttling
3. **Compliance Testing**: Monitor /metrics during load, verify totals ≤ 40
4. **Integration Testing**: Full RAG workflow under rate pressure

This plan ensures strict compliance with Cohere's limits while maintaining performance and providing visibility into actual usage patterns.
