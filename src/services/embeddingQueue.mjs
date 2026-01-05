/**
 * Embedding Queue Service
 *
 * Singleton queue for embedding requests with concurrency control, deduplication, and exponential backoff.
 *
 * Env vars:
 *   - EMBEDDING_CONCURRENCY: max concurrent embedding calls (default 1, hard cap 5)
 *   - EMBEDDING_RETRY_ATTEMPTS: max retry attempts for transient errors (default 6)
 *   - EMBEDDING_COOLDOWN_MS: cooldown to apply after sustained 429s (default 60000)
 *
 * Usage:
 *   import embeddingQueue from './services/embeddingQueue.mjs';
 *   const result = await embeddingQueue.enqueueEmbedding({ input, options });
 */

import LruTtlCache from '../utils/lruTtlCache.mjs';
import { retry } from '../utils/retry.mjs';
import { createCohereClient } from '../utils/cohereClientFactory.mjs';
import { createLowConcurrencyAgent } from '../utils/httpAgent.mjs';

const EMBEDDING_CONCURRENCY = Math.max(1, Math.min(Number(process.env.EMBEDDING_CONCURRENCY) || 1, 5));
const EMBEDDING_RETRY_ATTEMPTS = Number(process.env.EMBEDDING_RETRY_ATTEMPTS) || 6;

// Dedicated LRU cache for deduplication (reuse global if needed)
const dedupCache = new LruTtlCache({ ttlMs: 10 * 60 * 1000, maxSize: 2000, enableDedup: true });

// Global cooldown state used to temporarily pause embedding attempts when we
// observe sustained rate-limiting from the upstream Cohere API.
let globalCooldownUntil = 0;
const EMBEDDING_COOLDOWN_MS = Number(process.env.EMBEDDING_COOLDOWN_MS) || 60 * 1000; // default 60s

// Dedicated HTTP agent for embedding (low concurrency)
let embeddingAgent;
if (typeof createLowConcurrencyAgent === 'function') {
  embeddingAgent = createLowConcurrencyAgent({ maxSockets: EMBEDDING_CONCURRENCY });
} else {
  // fallback: use default agent with maxSockets=EMBEDDING_CONCURRENCY
  import('https').then(({ Agent }) => {
    embeddingAgent = new Agent({ keepAlive: true, maxSockets: EMBEDDING_CONCURRENCY });
  });
}

// Simple queue implementation
const queue = [];
let activeCount = 0;

async function processQueue() {
  if (activeCount >= EMBEDDING_CONCURRENCY || queue.length === 0) return;
  const { payload, resolve, reject } = queue.shift();
  activeCount++;
  try {
    const result = await handleEmbedding(payload);
    resolve(result);
  } catch (err) {
    reject(err);
  } finally {
    activeCount--;
    processQueue();
  }
}

async function handleEmbedding({ input, options = {} }) {
  // Normalize input into SDK-friendly payload shape.
  // Accept either:
  //  - Array of strings: treat as texts
  //  - Object with `{ texts | inputs | images }`: pass through
  //  - Single string: wrap into texts array
  let payload;
  if (Array.isArray(input)) {
    payload = { texts: input, model: options.model };
  } else if (input && typeof input === 'object' && (input.texts || input.inputs || input.images)) {
    payload = Object.assign({}, input, (options.model ? { model: options.model } : {}));
  } else {
    // fallback: treat as single text
    payload = { texts: [String(input)], model: options.model };
  }

  // Deduplication key: hash of normalized payload + options
  const dedupKey = LruTtlCache.makeDedupKey({ payload, options });
  return dedupCache.getOrSetAsync(dedupKey, async () => {
    // Create a Cohere client with dedicated agent for embedding
    const { client } = await createCohereClient({
      token: process.env.COHERE_API_KEY,
      agentOptions: embeddingAgent,
      logger: options.logger || console,
      model: options.model
    });

    // Retry logic: treat 429 and 5xx as retryable
    const retryOn = (err) => {
      if (!err) return false;
      const status = err.status || err.statusCode;
      if (status === 429) return true;
      if (typeof status === 'number' && status >= 500) return true;
      if (err.code) return true;
      return false;
    };

    // If we're currently in a global cooldown window due to upstream rate limiting,
    // politely wait until the cooldown expires before attempting. This helps avoid
    // stampeding the upstream service when many workers restart simultaneously.
    if (Date.now() < globalCooldownUntil) {
      const waitMs = Math.max(0, globalCooldownUntil - Date.now());
      (options.logger || console).warn(`Embedding requests paused for ${waitMs}ms due to upstream rate limiting`);
      await new Promise((r) => setTimeout(r, waitMs));
    }

    try {
      const res = await retry(
        // ensure we always call the SDK with an object payload
        () => client.embed(payload),
        {
          maxAttempts: EMBEDDING_RETRY_ATTEMPTS,
          baseDelayMs: 200,
          maxDelayMs: 2000,
          jitter: true,
          retryOn
        }
      );
      return res;
    } catch (err) {
      // On persistent 429s, set a short global cooldown to let upstream recover.
      const status = err?.status || err?.statusCode;
      if (status === 429) {
        // Attempt to parse Retry-After header if present and adjust cooldown conservatively
        try {
          const headers = err.headers || err.response?.headers || err.raw?.headers || (err?.body && err.body.headers) || {};
          const ra = headers && (headers['retry-after'] || headers['Retry-After']);
          if (ra) {
            const seconds = Number(ra);
            let until = 0;
            if (!Number.isNaN(seconds)) {
              until = Date.now() + seconds * 1000;
            } else {
              const parsed = Date.parse(String(ra));
              if (!Number.isNaN(parsed)) until = parsed;
            }
            if (until > 0) globalCooldownUntil = Math.max(globalCooldownUntil, until);
            else globalCooldownUntil = Date.now() + EMBEDDING_COOLDOWN_MS;
            try { (options.logger || console).warn(`Retry-After present — setting cooldown until ${new Date(globalCooldownUntil).toISOString()}`); } catch (e) {}
          } else {
            globalCooldownUntil = Date.now() + EMBEDDING_COOLDOWN_MS;
            try { (options.logger || console).warn(`Observed upstream 429 — entering embedding cooldown for ${EMBEDDING_COOLDOWN_MS}ms`); } catch (e) {}
          }
        } catch (parseErr) {
          globalCooldownUntil = Date.now() + EMBEDDING_COOLDOWN_MS;
        }
      }
      throw err;
    }
  }, { dedup: true, dedupPayload: { payload, options } });
}

const embeddingQueue = {
  /**
   * Enqueue an embedding request.
   * @param {object} params - { input, options }
   * @returns {Promise<embeddingResult>}
   */
  enqueueEmbedding({ input, options }) {
    return new Promise((resolve, reject) => {
      queue.push({ payload: { input, options }, resolve, reject });
      processQueue();
    });
  }
};

export default embeddingQueue;
