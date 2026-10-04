import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tokens } from '../db/schema.js';
import { authed, createTestApp, type TestApp } from '../test/app.js';
import type { HealthReport } from './health.js';

/**
 * `SOLANA_ENABLED=0`: a mainnet stack where only the EVM chains are deployed.
 * SOL is reported "not deployed" everywhere (health, params), its RPC is never
 * probed, and every Solana write path answers the same 422 — while the EVM
 * nets carry on untouched.
 */
const BASE_LAUNCHPAD = '0x2f197741C3ca71e3FE885a4F74C0D44e3A774D35';
const MEMEMAN = '0x847eb6311333f8F7F2cd0E9A89379214302aB2c9';
const WETH_BASE = '0x4200000000000000000000000000000000000006';
const E18 = 10n ** 18n;

const NOT_DEPLOYED = { error: 'SOL is not deployed on this environment', net: 'SOL' };

let h: TestApp;

beforeAll(async () => {
  h = await createTestApp({
    env: { SOLANA_ENABLED: '0', BASE_LAUNCHPAD_ADDRESS: BASE_LAUNCHPAD },
  });
  // Any Solana probe would now fail loudly instead of passing by accident.
  h.rpcs.SOL.setFailing(true);
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.db.reset();
  await h.clearRateLimits();
});

async function post(path: string, token: string, body: unknown = {}): Promise<Response> {
  return h.app.request(path, {
    method: 'POST',
    headers: { ...authed(token), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('SOLANA_ENABLED=0 — read surfaces', () => {
  it('GET /health reports SOL as not deployed and never probes its RPC', async () => {
    const res = await h.app.request('/health');
    const body = (await res.json()) as HealthReport;
    // The SOL fake is failing; a probe would have dragged the report to 503.
    expect(res.status).toBe(200);
    expect(body.chains.SOL).toMatchObject({
      status: 'ok',
      deployed: false,
      head: null,
      behind: null,
      lagSeconds: null,
      alerting: false,
      error: 'not deployed on this env',
    });
    expect(body.metrics.rpc.SOL.calls).toBe(0);
    // The EVM net this env does have is still probed.
    expect(body.chains.BASE.deployed).toBe(true);
    expect(body.chains.BASE.head).not.toBeNull();
  });

  it('GET /platform/status serves SOL params as the defaults, flagged not deployed', async () => {
    const res = await h.app.request('/platform/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { params: Record<string, Record<string, unknown>> };
    expect(body.params['SOL']).toMatchObject({
      net: 'SOL',
      source: 'default',
      set: false,
      matchesDefaults: true,
      error: 'not deployed on this environment',
    });
    // BASE still reads its launchpad (the fake answers nothing → defaults from a revert, not "not deployed").
    expect(body.params['BASE']!['error']).not.toMatch(/not deployed/);
  });
});

describe('SOLANA_ENABLED=0 — write paths', () => {
  it.each([
    ['/trade/prepare', { sym: 'X', side: 'buy', amount: 1 }],
    ['/trade/confirm', { sym: 'X', signature: '1'.repeat(64) }],
    ['/trade/broadcast', { transaction: 'AA==', mev: 'RELAY' }],
    ['/launch/prepare', {}],
    ['/launch/confirm', {}],
    ['/tokens/X/graduate/prepare', {}],
    ['/stake/prepare', { sym: 'X', amount: 1, days: 0 }],
    ['/stake/unstake/prepare', { sym: 'X', amount: 1 }],
    ['/stake/claim/prepare', { sym: 'X' }],
    ['/fees/claim/prepare', { sym: 'X' }],
    ['/referrals/claim/prepare', {}],
    ['/referrals/claim/confirm', { signature: 'x' }],
  ])('POST %s answers 422 for a Solana wallet', async (path, body) => {
    const { token } = await h.login('SOL');
    const res = await post(path, token, body);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(NOT_DEPLOYED);
  });

  it('refuses before touching the body, so the shape is the same on garbage input', async () => {
    const { token } = await h.login('SOL');
    const res = await h.app.request('/stake/prepare', {
      method: 'POST',
      headers: { ...authed(token), 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(NOT_DEPLOYED);
  });

  it('still prepares the same write for an EVM wallet', async () => {
    await h.deps.db.insert(tokens).values({
      net: 'BASE',
      sym: 'MEMEMAN',
      name: 'Meme Man',
      creator: '0x00000000000000000000000000000000000000c1',
      mint: MEMEMAN,
      baseSymbol: 'WETH',
      baseMint: WETH_BASE,
      supply: 1_000_000_000,
      feeBps: 100,
      seed: 7,
      tokenDecimals: 18,
      baseDecimals: 18,
      curveTokensForSale: (800_000_000n * E18).toString(),
      curveRealToken: ((800_000_000n - 100_000n) * E18).toString(),
    });
    const { token } = await h.login('BASE');
    const res = await post('/stake/prepare', token, {
      sym: 'MEMEMAN',
      mint: MEMEMAN,
      amount: 10,
      days: 0,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ net: 'BASE', action: 'stake', amount: 10 });

    // And the guard sits in front of validation only for the disabled net:
    // an EVM caller with a bad body still gets the handler's own 400.
    const bad = await post('/stake/prepare', token, {});
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('bad_request');
  });
});

describe('SOLANA_ENABLED unset — nothing changes', () => {
  it('keeps SOL deployed, probed and writable', async () => {
    const on = await createTestApp({ env: { BASE_LAUNCHPAD_ADDRESS: BASE_LAUNCHPAD } });
    try {
      expect(on.deps.env.solanaEnabled).toBe(true);
      on.rpcs.SOL.setHead(777);
      const health = (await (await on.app.request('/health')).json()) as HealthReport;
      expect(health.chains.SOL).toMatchObject({ deployed: true, head: 777 });

      const status = (await (await on.app.request('/platform/status')).json()) as {
        params: Record<string, Record<string, unknown>>;
      };
      expect(status.params['SOL']!['error']).not.toMatch(/not deployed/);

      const { token } = await on.login('SOL');
      const res = await on.app.request('/stake/prepare', {
        method: 'POST',
        headers: { ...authed(token), 'content-type': 'application/json' },
        body: JSON.stringify({ sym: 'NOPE', amount: 1, days: 0 }),
      });
      // Past the gate: the handler's own answer for an unknown token.
      expect(res.status).toBe(404);
    } finally {
      await on.close();
    }
  });
});
