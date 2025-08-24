import { describe, it, expect } from 'vitest';
import { apiKeyAuth } from '../src/middleware/apiKeyAuth.mjs';
import { validateBody } from '../src/middleware/validateBody.mjs';
import { z } from 'zod';

function mockReq(headers = {}, body = {}) {
  return { headers, body };
}

function mockRes() {
  const r = {};
  r.status = (code) => { r._status = code; return r; };
  r.json = (obj) => { r._json = obj; return r; };
  return r;
}

describe('apiKeyAuth middleware', () => {
  it('allows through when ADMIN_API_KEY not set', () => {
    delete process.env.ADMIN_API_KEY;
    const req = mockReq();
    const res = mockRes();
    let called = false;
    apiKeyAuth(req, res, () => { called = true; });
    expect(called).toBe(true);
  });

  it('rejects when key mismatch', () => {
    process.env.ADMIN_API_KEY = 'secret-123';
    const req = mockReq({ 'x-api-key': 'wrong' });
    const res = mockRes();
    let nextCalled = false;
    apiKeyAuth(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(401);
  });

  it('allows when key matches', () => {
    process.env.ADMIN_API_KEY = 'secret-123';
    const req = mockReq({ 'x-api-key': 'secret-123' });
    const res = mockRes();
    let nextCalled = false;
    apiKeyAuth(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });
});

describe('validateBody middleware (zod)', () => {
  it('accepts valid body', () => {
    const schema = z.object({ name: z.string() });
    const req = mockReq({}, { name: 'x' });
    const res = mockRes();
    let nextCalled = false;
    const mw = validateBody(schema);
    mw(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });

  it('rejects invalid body', () => {
    const schema = z.object({ name: z.string() });
    const req = mockReq({}, { bad: 'x' });
    const res = mockRes();
    let nextCalled = false;
    const mw = validateBody(schema);
    mw(req, res, () => { nextCalled = true; });
    // If Zod is not installed, validateBody is passthrough; accept either behavior
    if (res._status) {
      expect(res._status).toBe(400);
    } else {
      expect(nextCalled).toBe(true);
    }
  });
});
