import { describe, it, expect } from 'vitest';
import { retry } from '../src/utils/retry.mjs';
import { SimpleCircuitBreaker } from '../src/utils/circuitBreaker.mjs';

describe('retry', () => {
  it('retries and succeeds', async () => {
    let i = 0;
    const fn = async () => {
      i += 1;
      if (i < 2) throw new Error('fail');
      return 'ok';
    };
    const res = await retry(fn, 3, 10);
    expect(res).toBe('ok');
    expect(i).toBe(2);
  });
  it('fails after attempts', async () => {
    const fn = async () => { throw new Error('permanent'); };
    await expect(retry(fn, 2, 1)).rejects.toThrow('permanent');
  });
});

describe('SimpleCircuitBreaker', () => {
  it('opens after threshold', async () => {
    const cb = new SimpleCircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 50 });
    const failing = async () => { throw new Error('boom'); };
    await expect(cb.exec(failing)).rejects.toThrow('boom');
    await expect(cb.exec(failing)).rejects.toThrow('boom');
    // next call should be CircuitOpen
    await expect(cb.exec(failing)).rejects.toThrow('CircuitOpen');
  });
  it('resets after timeout', async () => {
    const cb = new SimpleCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 10 });
    await expect(cb.exec(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(cb.exec(async () => { throw new Error('boom'); })).rejects.toThrow('CircuitOpen');
    // wait
    await new Promise((r) => setTimeout(r, 15));
    // now it should attempt again and fail (back to open)
    await expect(cb.exec(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  });
});
