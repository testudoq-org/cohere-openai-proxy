import promClient from 'prom-client';

const circuitBreakerOpenCounter = new promClient.Counter({
  name: 'circuit_breaker_open_total',
  help: 'Total times circuit breaker opened'
});
const circuitBreakerFailuresCounter = new promClient.Counter({
  name: 'circuit_breaker_failures_total',
  help: 'Total failures counted by circuit breaker'
});
const circuitBreakerResetsCounter = new promClient.Counter({
  name: 'circuit_breaker_resets_total',
  help: 'Total circuit breaker resets (on success)'
});
// Gauge: 0 = CLOSED, 1 = OPEN
const circuitBreakerStateGauge = new promClient.Gauge({
  name: 'circuit_breaker_state',
  help: 'Current state of the circuit breaker (0=closed, 1=open)'
});

export class SimpleCircuitBreaker {
  // Tuned: increase failureThreshold and reduce reset timeout for quicker recovery.
  constructor({ failureThreshold = 5, resetTimeoutMs = 5000 } = {}) {
    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
    this.failures = 0;
    this.state = 'CLOSED';
    this.nextAttempt = 0;
    try { circuitBreakerStateGauge.set(0); } catch (e) { /* ignore metric errors */ }
  }

  async exec(fn) {
    const now = Date.now();
    if (this.state === 'OPEN' && now < this.nextAttempt) {
      throw new Error('CircuitOpen');
    }
    try {
      const res = await fn();
      this._onSuccess();
      return res;
    } catch (err) {
      this._onFailure();
      throw err;
    }
  }

  _onSuccess() {
    // reset failure count and state; record a reset metric
    this.failures = 0;
    this.state = 'CLOSED';
    this.nextAttempt = 0;
    try { circuitBreakerResetsCounter.inc(); } catch (e) { /* ignore metric errors */ }
    try { circuitBreakerStateGauge.set(0); } catch (e) { /* ignore metric errors */ }
  }

  _onFailure() {
    this.failures += 1;
    try { circuitBreakerFailuresCounter.inc(); } catch (e) { /* ignore metric errors */ }
    if (this.failures >= this.failureThreshold) {
      this.state = 'OPEN';
      this.nextAttempt = Date.now() + this.resetTimeoutMs;
      try { circuitBreakerOpenCounter.inc(); } catch (e) { /* ignore metric errors */ }
      try { circuitBreakerStateGauge.set(1); } catch (e) { /* ignore metric errors */ }
    }
  }
}
