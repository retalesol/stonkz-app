import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { indexerCursors } from '../db/schema.js';
import { readMigrations } from '../db/migrate.js';
import { API_CSP } from '../app/security.js';
import { createTestApp, TEST_ORIGIN, type TestApp } from '../test/app.js';
import type { HealthReport } from './health.js';

let h: TestApp;

beforeAll(async () => {
  h = await createTestApp();
});
afterAll(async () => {
  await h.close();
});

async function health(): Promise<{ status: number; body: HealthReport }> {
  const res = await h.app.request('/health');
  return { status: res.status, body: (await res.json()) as HealthReport };
}

/** Review gate 1.A: `/health` green in a prod-like env. */
describe('GET /health', () => {
  it('reports api, db, redis and both chain lags', async () => {
    h.rpcs.SOL.setHead(250_000_010);
    h.rpcs.RH.setHead(21_000_005);

    const { status, body } = await health();
    expect(status).toBe(200);
    // Reports the whole applied history, so adding a migration is not a
    // reason to edit this test.
    expect(body.api.migrations).toBe(readMigrations().length);
    expect(body.db.status).toBe('ok');
    expect(body.redis.status).toBe('ok');

    expect(body.chains.SOL.head).toBe(250_000_010);
    expect(body.chains.RH.head).toBe(21_000_005);
    // Cursors start at 0, so a fresh database is legitimately behind: the
    // service is up but degraded until the indexer commits its first batch.
    expect(body.status).toBe('degraded');
    expect(body.chains.SOL.alerting).toBe(true);
    expect(body.chains.RH.alerting).toBe(true);
  });

  it('is green once all four cursors are caught up', async () => {
    // BASE joined ALL_NETS in 284ae9a and ARC after it, so /health is only
    // `ok` once every net is level.
    h.rpcs.SOL.setHead(1000);
    h.rpcs.RH.setHead(500);
    h.rpcs.BASE.setHead(300);
    h.rpcs.ARC.setHead(200);
    await h.deps.db
      .update(indexerCursors)
      .set({ position: 1000 })
      .where(eq(indexerCursors.net, 'SOL'));
    await h.deps.db
      .update(indexerCursors)
      .set({ position: 500 })
      .where(eq(indexerCursors.net, 'RH'));
    await h.deps.db
      .update(indexerCursors)
      .set({ position: 300 })
      .where(eq(indexerCursors.net, 'BASE'));
    await h.deps.db
      .update(indexerCursors)
      .set({ position: 200 })
      .where(eq(indexerCursors.net, 'ARC'));

    const { status, body } = await health();
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.chains.ARC.lagSeconds).toBe(0);
    expect(body.chains.ARC.alerting).toBe(false);
    expect(body.chains.SOL.lagSeconds).toBe(0);
    expect(body.chains.RH.lagSeconds).toBe(0);
    expect(body.chains.BASE.lagSeconds).toBe(0);
    expect(body.chains.SOL.alerting).toBe(false);
    expect(body.chains.RH.alerting).toBe(false);
    expect(body.chains.BASE.alerting).toBe(false);
  });

  it('alerts past the 30s threshold on each chain independently', async () => {
    // 400ms per slot => 100 slots behind is 40s, over the limit.
    h.rpcs.SOL.setHead(1100);
    h.rpcs.RH.setHead(500);
    const { body } = await health();
    expect(body.chains.SOL.lagSeconds).toBe(40);
    expect(body.chains.SOL.alerting).toBe(true);
    expect(body.chains.RH.alerting).toBe(false);
    expect(body.status).toBe('degraded');
  });

  it('reports 503 and names the chain when an RPC is down', async () => {
    h.rpcs.SOL.setHead(1000);
    h.rpcs.RH.setFailing(true);
    const { status, body } = await health();
    expect(status).toBe(503);
    expect(body.status).toBe('down');
    expect(body.chains.RH.status).toBe('down');
    expect(body.chains.RH.error).toMatch(/outage/);
    expect(body.chains.SOL.status).toBe('ok');
    h.rpcs.RH.setFailing(false);
  });

  it('keeps liveness independent of every dependency', async () => {
    h.rpcs.SOL.setFailing(true);
    h.rpcs.RH.setFailing(true);
    const res = await h.app.request('/health/live');
    expect(res.status).toBe(200);
    h.rpcs.SOL.setFailing(false);
    h.rpcs.RH.setFailing(false);
  });

  it('exposes the WS gauge and per-chain lag in the metrics block', async () => {
    const { body } = await health();
    expect(body.metrics.ws).toMatchObject({ connections: 0, peakConnections: 0 });
    // One lag gauge per net in ALL_NETS — BASE included since 284ae9a, ARC after.
    expect(Object.keys(body.metrics.chainLag).sort()).toEqual(['ARC', 'BASE', 'RH', 'SOL']);
    expect(body.metrics.rpc.SOL.calls).toBeGreaterThan(0);
    expect(body.metrics.requests.total).toBeGreaterThan(0);
  });
});

describe('security headers and CORS', () => {
  it('ships frame-ancestors in the CSP response header', async () => {
    const res = await h.app.request('/health/live');
    const csp = res.headers.get('Content-Security-Policy');
    // The <meta> form cannot carry frame-ancestors, which is why it is here.
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toBe(API_CSP);
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  it('allows ston.kz and localhost, and refuses anything else', async () => {
    const ok = await h.app.request('/health/live', { headers: { origin: TEST_ORIGIN } });
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe(TEST_ORIGIN);

    const local = await h.app.request('/health/live', {
      headers: { origin: 'http://localhost:5173' },
    });
    expect(local.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');

    const evil = await h.app.request('/health/live', {
      headers: { origin: 'https://evil.example' },
    });
    expect(evil.status).toBe(403);
    expect(evil.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('answers preflight only for allowed origins', async () => {
    const ok = await h.app.request('/me', { method: 'OPTIONS', headers: { origin: TEST_ORIGIN } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('Access-Control-Allow-Methods')).toContain('POST');

    const evil = await h.app.request('/me', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example' },
    });
    expect(evil.status).toBe(403);
  });
});
