export class SimpleCircuitBreaker {
  constructor({ failureThreshold = 5, resetTimeoutMs = 10000 } = {}) {
    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
    this.failures = 0;
    this.state = 'CLOSED';
    this.nextAttempt = 0;
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
    this.failures = 0;
    this.state = 'CLOSED';
  }

  _onFailure() {
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.state = 'OPEN';
      this.nextAttempt = Date.now() + this.resetTimeoutMs;
    }
  }
}
