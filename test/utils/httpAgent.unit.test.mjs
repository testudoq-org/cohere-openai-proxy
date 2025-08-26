import { describe, it, expect } from 'vitest';

describe('httpAgent exported options', () => {
  it('exports agents with keepAlive true and default maxSockets', async () => {
    const mod = await import('../../src/utils/httpAgent.mjs');
    const { httpAgent, httpsAgent, OUTBOUND_MAX_SOCKETS } = mod;
    expect(httpAgent).toBeDefined();
    expect(httpsAgent).toBeDefined();
    expect(typeof OUTBOUND_MAX_SOCKETS === 'number').toBe(true);
    // Node Agent exposes keepAlive value via .options in recent Node versions
    const httpOptions = httpAgent.options || {};
    const httpsOptions = httpsAgent.options || {};
    expect(httpOptions.keepAlive === true || httpAgent.keepAlive === true).toBe(true);
    expect(httpsOptions.keepAlive === true || httpsAgent.keepAlive === true).toBe(true);
    // exported constant should match agent's maxSockets
    const httpMax = httpOptions.maxSockets || httpAgent.maxSockets;
    expect(Number(httpMax)).toBe(OUTBOUND_MAX_SOCKETS);
  });

  it('respects OUTBOUND_MAX_SOCKETS env override', async () => {
    process.env.OUTBOUND_MAX_SOCKETS = '3';
    // clear module cache to re-import with env var
    const p = '../../src/utils/httpAgent.mjs';
    // eslint-disable-next-line no-undef
    delete require.cache?.[require.resolve(p)];
    const mod = await import(p + '?update');
    const { httpAgent, OUTBOUND_MAX_SOCKETS } = mod;
    const max = httpAgent.options?.maxSockets || httpAgent.maxSockets;
    expect(Number(max)).toBe(3);
    expect(Number(OUTBOUND_MAX_SOCKETS)).toBe(3);
    delete process.env.OUTBOUND_MAX_SOCKETS;
  });
});
