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
export async function createCohereClient({ token, agentOptions = defaultHttpsAgent, logger = console } = {}) {
  // Fail fast if token missing
  if (!token) {
    throw new Error('Cohere client creation requires a token');
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

  // Recursively wrap functions on the client so calls are proxied through circuit + retry.
  const wrapValue = (value, ctx) => {
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
            return circuit.exec(() => retry(() => value.apply(ctx || rawClient, sdkArgs), callOptions));
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
          return wrapValue(v, target);
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
      return wrapValue(v, target);
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