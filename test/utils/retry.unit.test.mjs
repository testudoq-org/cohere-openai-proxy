import { it, expect, vi } from 'vitest';
import { retry } from '../../src/utils/retry.mjs';

// Test 1: exponential backoff increases delays (no jitter)
it('uses exponential backoff without jitter (increasing delays)', async () => {
  const waitCalls = [];
  const waitFn = (ms) => {
    waitCalls.push(ms);
    return Promise.resolve();
  };

  // fn fails twice then succeeds
  let calls = 0;
  const fn = async () => {
    calls++;
    if (calls < 3) throw new Error('fail');
    return 'ok';
  };

  const res = await retry(fn, {
    maxAttempts: 3,
    baseDelayMs: 100,
    maxDelayMs: 10000,
    jitter: false,
    waitFn,
  });

  expect(res).toBe('ok');
  // after first failure delay=100, after second failure delay=200
  expect(waitCalls).toEqual([100, 200]);
});

// Test 2: jitter alters delay within expected bounds (using deterministic rng)
it('applies jitter within expected bounds', async () => {
  const waitCalls = [];
  const waitFn = (ms) => {
    waitCalls.push(ms);
    return Promise.resolve();
  };

  // rng returns sequence [0, ~1) -> maps to multipliers [0.5, ~1.5)
  const seq = [0, 0.999999];
  let idx = 0;
  const rng = () => seq[idx++ % seq.length];

  let calls = 0;
  const fn = async () => {
    calls++;
    if (calls < 3) throw new Error('fail');
    return 'done';
  };

  const res = await retry(fn, {
    maxAttempts: 3,
    baseDelayMs: 200, // exp delays: 200, 400
    maxDelayMs: 1000,
    jitter: true,
    rng,
    waitFn,
  });

  expect(res).toBe('done');
  // compute expected with multipliers [0.5, ~1.499999]
  expect(waitCalls.length).toBe(2);
  expect(waitCalls[0]).toBeCloseTo(200 * 0.5, 2);
  expect(waitCalls[1]).toBeCloseTo(400 * 1.5, 1);
});

// Test 3: per-attempt timeout triggers retries when fn hangs
it('retries when per-attempt timeout occurs', async () => {
  // Use a timeoutFactory that triggers a timeout immediately (deterministic, fast)
  let attempts = 0;
  const fn = () => {
    attempts++;
    return new Promise(() => {}); // never settles
  };

  // immediate waitFn so we don't actually delay between retries
  const waitFn = () => Promise.resolve();

  // timeoutFactory rejects on next microtask to simulate per-attempt timeout quickly
  const timeoutFactory = (ms) => {
    let cleared = false;
    const p = new Promise((_, reject) => {
      queueMicrotask(() => {
        if (!cleared) {
          const err = new Error('per-attempt timeout');
          err.code = 'ETIMEDOUT';
          err.isTimeout = true;
          reject(err);
        }
      });
    });
    return { promise: p, clear: () => { cleared = true; } };
  };

  const p = retry(fn, {
    maxAttempts: 3,
    perAttemptTimeoutMs: 1000,
    baseDelayMs: 10,
    jitter: false,
    waitFn,
    timeoutFactory,
  });

  // allow microtasks to flush so the rejected promises propagate
  await Promise.resolve();

  await expect(p).rejects.toThrow();
  expect(attempts).toBe(3);
});

// Test 4: backwards compatibility - legacy signature retry(fn, attempts, baseDelayMs)
it('supports legacy signature retry(fn, attempts, baseDelayMs)', async () => {
  // Provide a custom waitFn via the legacy fourth argument (extras) so we can
  // capture requested delays deterministically without touching global timers.
  const msCalls = [];
  const waitFn = (ms) => {
    msCalls.push(ms);
    return Promise.resolve(); // resolve immediately to keep test fast
  };

  let calls = 0;
  const fn = async () => {
    calls++;
    if (calls < 3) throw new Error('err');
    return 'ok';
  };

  // legacy signature: retry(fn, attempts, baseDelayMs, extras)
  const p = retry(fn, 3, 200, { waitFn });

  // allow microtasks to run so retries complete quickly
  await Promise.resolve();

  const res = await p;
  expect(res).toBe('ok');

  // expect at least the exponential delays 200 and 400 were used by waitFn
  expect(msCalls).toContain(200);
  expect(msCalls).toContain(400);
});