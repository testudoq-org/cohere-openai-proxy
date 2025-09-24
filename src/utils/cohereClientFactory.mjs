/**
 * Read COHERE_MODEL at runtime so dotenv-loaded values are respected in Docker.
 */
function getCohereModel() {
  return process.env.COHERE_MODEL || 'command-a-03-2025';
}

import { CohereClient } from 'cohere-ai';
import { httpsAgent as defaultHttpsAgent, EXTERNAL_API_TIMEOUT_MS } from './httpAgent.mjs';
import { retry } from './retry.mjs';
import { SimpleCircuitBreaker } from './circuitBreaker.mjs';
import LruTtlCache from './lruTtlCache.mjs';
import promClient from 'prom-client';
import fs from 'fs';
import path from 'path';

// Cohere request latency (seconds) and success/failure counters.
// Labels: operation (e.g., chat), model (when available)
const cohereRequestDuration = new promClient.Histogram({
  name: 'cohere_request_duration_seconds',
  help: 'Cohere API request duration in seconds',
  buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  labelNames: ['operation', 'model']
});
const cohereRequestSuccess = new promClient.Counter({
  name: 'cohere_request_success_total',
  help: 'Cohere API successful requests',
  labelNames: ['operation', 'model']
});
const cohereRequestFailure = new promClient.Counter({
  name: 'cohere_request_failure_total',
  help: 'Cohere API failed requests',
  labelNames: ['operation', 'model']
});

/**
 * Create a Cohere client, trying common agent option names for SDK compatibility.
 *
 * The returned `client` preserves the original SDK shape but wraps outbound
 * calls (functions) so that each invocation is executed inside a circuit
 * breaker and via the retry helper. This keeps callers unchanged while
 * centrally applying retry/timeouts and circuit behaviour.
 *
 * @param {object} params
 * @param {string} params.token - Cohere API token
 * @param {any} [params.agentOptions=defaultHttpsAgent] - agent/options to pass when attempting SDK construction
 * @param {object} [params.logger=console] - logger with .warn available
 * @returns {Promise<{client: any, acceptedAgentOption: 'agent'|'httpsAgent'|'none'}>}
 */
export async function createCohereClient({ token, agentOptions = defaultHttpsAgent, logger = console, model } = {}) {
  // Fail fast if token missing
  if (!token) {
    throw new Error('Cohere client creation requires a token');
  }
  // If a model was provided at client creation time, validate it early so callers
  // receive a clear 400-style error rather than later runtime errors.
  if (model) {
    try {
      validateModelOrThrow(model);
    } catch (e) {
      const err = new Error(e.message || 'Invalid model');
      err.statusCode = e.statusCode || 400;
      throw err;
    }
  }

  // Helper to attempt constructing the SDK and await if a Promise-like is returned.
  async function tryConstruct(opts) {
    // Use new so that constructors that explicitly return objects are honoured.
    const result = (() => {
      try {
        return new CohereClient(opts);
      } catch (err) {
        // rethrow synchronous constructor errors to be handled by caller
        throw err;
      }
    })();
    // If constructor returned a Promise-like, await it so we surface async rejections.
    if (result && typeof result.then === 'function') {
      return await result;
    }
    return result;
  }

  // Create underlying SDK client (try common option keys).
  let rawClient;
  let acceptedAgentOption = 'none';
  let lastError;
  const attempts = [
    { opts: { token, apiVersion: 'v2', agent: agentOptions }, label: 'agent' },
    { opts: { token, apiVersion: 'v2', httpsAgent: agentOptions }, label: 'httpsAgent' },
    { opts: { token, apiVersion: 'v2' }, label: 'none' },
  ];

  for (let i = 0; i < attempts.length; i++) {
    const { opts, label } = attempts[i];
    try {
      rawClient = await tryConstruct(opts);
      acceptedAgentOption = label;
      break;
    } catch (err) {
      lastError = err;
      // Log and continue to next attempt (logger may be undefined)
      try {
        if (label !== 'none') logger?.warn?.(`CohereClient constructor rejected for option "${label}": ${err?.message || err}`);
      } catch (e) {
        // ignore logger errors
      }
      // continue loop to try next option
    }
  }

  if (!rawClient) {
    // All constructor attempts failed; surface the last error so tests can observe it.
    throw lastError || new Error('Failed to construct CohereClient');
  }

  // Circuit breaker config (env-driven with sensible defaults)
  const cbFailures = Number(process.env.COHERE_CB_FAILURES) || 2;
  const cbReset = Number(process.env.COHERE_CB_RESET_MS) || 10000;
  const circuit = new SimpleCircuitBreaker({ failureThreshold: cbFailures, resetTimeoutMs: cbReset });

  // Default retry options sourced from environment (caller may override by passing options obj later if needed)
  const defaultRetryOptions = () => ({
    maxAttempts: Number(process.env.EXTERNAL_API_MAX_ATTEMPTS) || 3,
    baseDelayMs: Number(process.env.EXTERNAL_API_BASE_DELAY_MS) || 200,
    perAttemptTimeoutMs: Number(process.env.EXTERNAL_API_TIMEOUT_MS) || EXTERNAL_API_TIMEOUT_MS,
    maxDelayMs: 2000,
    jitter: true,
  });

  // Response-level cache for chat responses (TTL 2 minutes).
  // Cache key is based on model, message, temperature, and max_tokens.
  const responseCache = new LruTtlCache({ ttlMs: 2 * 60 * 1000, maxSize: 1000 });
 
  // Feature flag: whether the underlying Cohere V2 client supports streaming.
  const COHERE_V2_STREAMING_SUPPORTED = !!(
    process.env.COHERE_V2_STREAMING_SUPPORTED &&
    ['1', 'true', 'yes'].includes(String(process.env.COHERE_V2_STREAMING_SUPPORTED).toLowerCase())
  );
 
  // Recursively wrap functions on the client so calls are proxied through circuit + retry.
  // `prop` is provided so we can special-case certain API calls (e.g., 'chat') for response caching.
  const wrapValue = (value, ctx, prop) => {
    if (typeof value === 'function') {
      return function wrapped(...args) {
        // allow caller to pass an options object as last arg to override retry options for that call
        const lastArg = args[args.length - 1];
        let callOptions = defaultRetryOptions();
        let overrideProvided = false;
        if (lastArg && typeof lastArg === 'object' && (lastArg.maxAttempts || lastArg.baseDelayMs || lastArg.perAttemptTimeoutMs)) {
          // shallow pick known retry props and remove from args for actual SDK call
          const { maxAttempts, baseDelayMs, perAttemptTimeoutMs, maxDelayMs, jitter } = lastArg;
          callOptions = {
            ...callOptions,
            ...(typeof maxAttempts === 'number' ? { maxAttempts } : {}),
            ...(typeof baseDelayMs === 'number' ? { baseDelayMs } : {}),
            ...(typeof perAttemptTimeoutMs === 'number' ? { perAttemptTimeoutMs } : {}),
            ...(typeof maxDelayMs === 'number' ? { maxDelayMs } : {}),
            ...(typeof jitter !== 'undefined' ? { jitter } : {}),
          };
          overrideProvided = true;
        }
        // If override was provided and it was the last argument, remove it from SDK args.
        const sdkArgs = overrideProvided ? args.slice(0, -1) : args;
 
        // Try a direct synchronous invocation first so that SDKs which return sync
        // values (e.g., mocked functions) remain synchronous for callers.
        try {
          const maybeResult = value.apply(ctx || rawClient, sdkArgs);
          if (maybeResult && typeof maybeResult.then === 'function') {
            // Async - go through circuit + retry
            // Prepare callArgs; allow special-casing of the chat payload to inject streaming flag
            let callArgsForAttempt = sdkArgs;
            if (prop === 'chat' && sdkArgs[0] && typeof sdkArgs[0] === 'object') {
              try {
                const p = sdkArgs[0];
                // Ensure we do not mutate caller objects
                const callPayload = { ...p, ...(COHERE_V2_STREAMING_SUPPORTED ? { stream: true } : {}) };
                callArgsForAttempt = [callPayload, ...sdkArgs.slice(1)];
              } catch (e) {
                // fallback to original args if anything goes wrong
                callArgsForAttempt = sdkArgs;
              }
            }
 
            const makeCall = async () => {
              // Instrument overall call (includes retries) with Prometheus metrics.
              // Determine labels where possible.
              let modelLabel = '';
              try {
                const p = (prop === 'chat' && sdkArgs[0] && typeof sdkArgs[0] === 'object') ? sdkArgs[0] : (callArgsForAttempt && callArgsForAttempt[0] && typeof callArgsForAttempt[0] === 'object' ? callArgsForAttempt[0] : null);
                modelLabel = (p && (p.model || p.modelName)) ? String(p.model || p.modelName) : getCohereModel();
              } catch (e) {
                modelLabel = getCohereModel();
              }
              const labels = { operation: String(prop), model: modelLabel };

              const endTimer = cohereRequestDuration.startTimer(labels);
              try {
                const res = await circuit.exec(() => retry(() => value.apply(ctx || rawClient, callArgsForAttempt), callOptions));
                try { cohereRequestSuccess.inc(labels); } catch (e) { /* ignore metric errors */ }
                return res;
              } catch (err) {
                try { cohereRequestFailure.inc(labels); } catch (e) { /* ignore metric errors */ }
                throw err;
              } finally {
                try { endTimer(); } catch (e) { /* ignore metric errors */ }
              }
            };
 
            // If this looks like a chat call, attempt response-level caching.
            if (prop === 'chat' && sdkArgs[0] && typeof sdkArgs[0] === 'object') {
              try {
                const p = sdkArgs[0];
                const model = p.model || getCohereModel();
                const message = typeof p.message === 'string' ? p.message : JSON.stringify(p.message || '');
                const temperature = (typeof p.temperature !== 'undefined') ? String(p.temperature) : '';
                const maxTokens = (typeof p.max_tokens !== 'undefined') ? String(p.max_tokens) : '';
                const cacheKey = `cohere:chat:${model}|${message}|t=${temperature}|m=${maxTokens}`;
                return responseCache.getOrSetAsync(cacheKey, makeCall);
              } catch (e) {
                // If cache key construction fails for any reason, fall back to making the call.
                return makeCall();
              }
            }
 
            return makeCall();
          }
          // Synchronous result - return directly
          return maybeResult;
        } catch (err) {
          // Synchronous method threw — surface immediately to preserve sync behaviour for callers.
          throw err;
        }
      };
    } else if (value && typeof value === 'object') {
      // create a proxy object for nested namespaces (e.g., client.models.list)
      return new Proxy(value, {
        get(target, prop) {
          // preserve some common non-enumerable things
          const v = target[prop];
          return wrapValue(v, target, prop);
        },
        // pass-through for other traps
        has(target, prop) { return prop in target; },
      });
    }
    return value;
  };

  const wrappedClient = new Proxy(rawClient, {
    get(target, prop) {
      const v = target[prop];
      return wrapValue(v, target, prop);
    },
    // preserve ownKeys/has to keep introspection working
    has(target, prop) { return prop in target; },
    ownKeys(target) { return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, prop) {
      const desc = Object.getOwnPropertyDescriptor(target, prop) || { configurable: true, enumerable: true };
      return desc;
    }
  });

  return { client: wrappedClient, acceptedAgentOption };
}

/**
 * Models config loader and validators
 */
let _modelsConfig = null;
function loadModelsConfig() {
  if (_modelsConfig) return _modelsConfig;
  try {
    const p = path.resolve(process.cwd(), 'models-config.json');
    const raw = fs.readFileSync(p, 'utf8');
    _modelsConfig = JSON.parse(raw);
  } catch (e) {
    // fallback to minimal defaults if file missing
    _modelsConfig = {
      models: [
        { id: 'command-a-03-2025', type: 'generation', languages: ['en'], ttlMs: 120000 },
        { id: 'command-r-plus-08-2024', type: 'generation', languages: ['en'], ttlMs: 120000 },
        { id: 'embed-english-v3.0', type: 'embed', languages: ['en'], ttlMs: 600000 },
        { id: 'embed-multilingual-v3.0', type: 'embed', languages: ['en'], ttlMs: 600000 },
        { id: 'rerank-multilingual-v3.0', type: 'rerank', languages: ['en'], ttlMs: 600000 },
        { id: 'command-a-vision-07-2025', type: 'vision', languages: ['en'], ttlMs: 600000 }
      ]
    };
  }
  return _modelsConfig;
}

/**
 * Return list of models metadata.
 */
export function getModelsList() {
  const cfg = loadModelsConfig();
  return cfg.models || [];
}

/**
 * Validate model id exists and (optionally) supports a modality.
 * Throws an Error instance with statusCode = 400 for invalid models,
 * or statusCode = 404 when the model doesn't support the requested operation.
 */
export function validateModelOrThrow(modelId, modality = null) {
  if (!modelId) {
    const err = new Error('Model is required');
    err.statusCode = 400;
    throw err;
  }
  const cfg = loadModelsConfig();
  const found = (cfg.models || []).find((m) => m.id === modelId);
  if (!found) {
    const err = new Error(`Invalid model: ${modelId}`);
    err.statusCode = 400;
    throw err;
  }
  if (modality && found.type !== modality) {
    const err = new Error(`Model ${modelId} does not support ${modality}`);
    err.statusCode = 404;
    throw err;
  }
  return found;
}

/**
 * Convenience exported helper for profiling: callCohereChatAPI
 * Accepts a wrapped client (from createCohereClient) or raw client-like object with a .chat method.
 * This function provides a stable entrypoint that can be exercised under profiling tools
 * (e.g., clinic.js) to identify hotspots in chat requests.
 */
export async function callCohereChatAPI(clientLike, payload, options) {
  if (!clientLike || typeof clientLike.chat !== 'function') {
    throw new Error('callCohereChatAPI requires a client with a .chat function');
  }
  // Measure via the same metrics for consistency.
  const modelLabel = (payload && (payload.model)) ? String(payload.model) : getCohereModel();
  const labels = { operation: 'chat', model: modelLabel };
  const endTimer = cohereRequestDuration.startTimer(labels);
  try {
    const res = await clientLike.chat(payload, options);
    try { cohereRequestSuccess.inc(labels); } catch (e) { /* ignore metric errors */ }
    return res;
  } catch (err) {
    try { cohereRequestFailure.inc(labels); } catch (e) { /* ignore metric errors */ }
    throw err;
  } finally {
    try { endTimer(); } catch (e) { /* ignore metric errors */ }
  }
}