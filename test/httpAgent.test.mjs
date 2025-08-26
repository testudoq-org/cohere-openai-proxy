import { it, describe, expect, beforeEach, afterEach } from 'vitest';

describe('httpAgent applyGlobalAgents opt-in behavior', () => {
  let origHttpGlobal;
  let origHttpsGlobal;
  beforeEach(() => {
    // cache originals
    // eslint-disable-next-line no-undef
    origHttpGlobal = require('http').globalAgent;
    // eslint-disable-next-line no-undef
    origHttpsGlobal = require('https').globalAgent;
    // clear env vars to ensure deterministic behavior
    delete process.env.OUTBOUND_USE_GLOBAL_AGENT;
  });

  afterEach(() => {
    // restore
    try { require('http').globalAgent = origHttpGlobal; } catch (e) {}
    try { require('https').globalAgent = origHttpsGlobal; } catch (e) {}
    delete process.env.OUTBOUND_USE_GLOBAL_AGENT;
  });

  it('does not mutate globals by default', async () => {
    const mod = await import('../src/utils/httpAgent.mjs');
    // modules export httpAgent/httpsAgent
    expect(require('http').globalAgent).toBe(origHttpGlobal);
    expect(require('https').globalAgent).toBe(origHttpsGlobal);
  });

  it('mutates globals when env var is set', async () => {
    process.env.OUTBOUND_USE_GLOBAL_AGENT = '1';
    const mod = await import('../src/utils/httpAgent.mjs');
    // call applyGlobalAgents explicitly
    mod.applyGlobalAgents();
    expect(require('http').globalAgent).toBe(mod.httpAgent);
    expect(require('https').globalAgent).toBe(mod.httpsAgent);
  });

  it('mutates globals when force=true', async () => {
    const mod = await import('../src/utils/httpAgent.mjs');
    mod.applyGlobalAgents(true);
    expect(require('http').globalAgent).toBe(mod.httpAgent);
    expect(require('https').globalAgent).toBe(mod.httpsAgent);
  });
});
