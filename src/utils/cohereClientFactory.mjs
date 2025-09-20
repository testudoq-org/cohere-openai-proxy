const COHERE_MODEL = process.env.COHERE_MODEL || 'command-a-03-2025';
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
  // Create underlying SDK client (try common option keys).
  let rawClient;
  let acceptedAgentOption = 'none';
  try {
    rawClient = new CohereClient({ token, agent: agentOptions });
    acceptedAgentOption = 'agent';
  } catch (e1) {
    try {
      rawClient = new CohereClient({ token, httpsAgent: agentOptions });
      acceptedAgentOption = 'httpsAgent';
    } catch (e2) {
      try {
        logger?.warn?.('CohereClient did not accept agent options; falling back to default constructor.');
      } catch (e) {
        // ignore logger failures
      }
      rawClient = new CohereClient({ token });
      acceptedAgentOption = 'none';
    }
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
      return async function wrapped(...args) {
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

        // actual request is the underlying function bound to its original context
        const actualRequest = () => value.apply(ctx || rawClient, sdkArgs);

        // Execute retry inside circuit so circuit sees the result of the whole retry operation.
        return circuit.exec(() => retry(actualRequest, callOptions));
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