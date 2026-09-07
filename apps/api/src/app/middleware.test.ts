import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, TEST_ORIGIN, type TestApp } from '../test/app.js';

/**
 * `RATE_LIMITS.auth` (30/min) gates `/auth/nonce`, and only per-IP identity
 * is in play — no wallet is authenticated yet — so it's the cheapest real
 * route to exercise the anti-spoofing fix for M1
 * (`docs/security-review-findings.md`) end to end, through the actual Hono
 * middleware stack rather than calling `resolveClientIp` directly.
 */
async function hitNonce(h: TestApp, forwardedFor: string | undefined): Promise<Response> {
  const headers: Record<string, string> = { origin: TEST_ORIGIN };
  if (forwardedFor !== undefined) headers['X-Forwarded-For'] = forwardedFor;
  return h.app.request('/auth/nonce?net=SOL', { headers });
}

describe('per-IP rate-limit identity (M1)', () => {
  let h: TestApp;

  beforeAll(async () => {
    // Default TRUSTED_PROXY_DEPTH (1), matching Railway's single edge hop.
    h = await createTestApp();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.db.reset();
    await h.clearRateLimits();
  });

  it('a spoofed multi-value X-Forwarded-For cannot bypass the limit by claiming a fresh IP each request', async () => {
    // Same real, trusted (rightmost) hop every time; a different fake
    // client-supplied prefix on every request, the way a naive
    // "trust the whole header" implementation would be defeated.
    const real = '203.0.113.50';
    let lastStatus = 200;
    for (let i = 0; i < 30; i++) {
      const res = await hitNonce(h, `${i}.${i}.${i}.${i}, ${real}`);
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(200); // exactly at the 30/min budget so far

    const blocked = await hitNonce(h, `999.999.999.999, ${real}`);
    expect(blocked.status).toBe(429);
  });

  it('a correctly single-hop-proxied request extracts the real client IP and is rate-limited on it consistently', async () => {
    const realA = '198.51.100.7';
    for (let i = 0; i < 30; i++) {
      const res = await hitNonce(h, realA);
      expect(res.status).toBe(200);
    }
    const blockedA = await hitNonce(h, realA);
    expect(blockedA.status).toBe(429);

    // A different real, single-hop client is a different identity — its own
    // fresh budget, not swept up by the first client's limit.
    const realB = '198.51.100.8';
    const resB = await hitNonce(h, realB);
    expect(resB.status).toBe(200);
  });

  it('does not let a client dodge the limit by omitting X-Forwarded-For and relying on the "unknown" bucket to always be fresh', async () => {
    // Every request with no header at all collapses onto the same
    // `ip:unknown` identity, so it is still bounded, not an infinite-budget
    // escape hatch.
    let lastStatus = 200;
    for (let i = 0; i < 30; i++) {
      const res = await hitNonce(h, undefined);
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(200);
    const blocked = await hitNonce(h, undefined);
    expect(blocked.status).toBe(429);
  });
});
