import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACH, CRATES, RANKS, RWA_ASSETS } from '@stonkz/shared';
import { authed, createTestApp, FROZEN_NOW, type TestApp } from '../test/app.js';
import { solanaWallet } from '../test/wallets.js';
import { resetDefiLlamaClients } from '../router/defillama.js';

let h: TestApp;

beforeAll(async () => {
  h = await createTestApp();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.db.reset();
  await h.clearRateLimits();
  h.setNow(FROZEN_NOW);
});

interface MeBody {
  net: string;
  wallet: string;
  native: {
    unit: string;
    balance: number | null;
    usdPrice: number | null;
    usdValue: number | null;
  };
  xp: number;
  rank: { i: number; name: string; next: number | null };
  sp: number;
  stonkz: number;
  rwa: { asset: string; units: number }[];
  streak: number;
  streakMult: number;
  achievements: { key: string; unlockedAt: number }[];
  crates: { tier: string; ready: boolean; readyAt: number | null; opens: number }[];
  items: { item: string; count: number; expiresAt: number | null }[];
  settings: unknown;
}

/** Plan step 120 — `GET /me` hydrates the whole rewards strip in one trip. */
describe('GET /me rewards payload', () => {
  it('carries xp, rank, sp, stonkz, rwa, crates, streak and achievements', async () => {
    const { token } = await h.login('SOL', solanaWallet('me-rewards'));
    const res = await h.app.request('/me', { headers: authed(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as MeBody;

    // Daily check-in pays 10 SP/XP on first visit of the UTC day.
    expect(body).toMatchObject({ net: 'SOL', xp: 10, sp: 10, stonkz: 0, rwa: [] });
    expect(body).not.toHaveProperty('optionz');
    expect(body.rank).toMatchObject({ i: 0, name: RANKS[0]?.[0] });
    expect(body.achievements).toEqual([]);
    expect(body.items).toEqual([]);
    expect(body.crates).toHaveLength(CRATES.length);
    expect(body.crates.every((c) => c.ready)).toBe(true);
    const bronze = body.crates.find((c) => c.tier === 'BRONZE') as MeBody['crates'][number] & {
      inventory?: number;
      openable?: boolean;
    };
    // L1 grant: BRONZE×2 — only bronze is openable until more SP is earned.
    expect(bronze?.inventory).toBe(2);
    expect(bronze?.openable).toBe(true);
    expect(body.crates.filter((c) => (c as { openable?: boolean }).openable).length).toBe(1);
    expect(body.native.unit).toBe('SOL');
    expect((body as { dailyCheckin?: { claimed: boolean } }).dailyCheckin?.claimed).toBe(true);
  });

  it('opens the streak at one on first visit and holds it the same day', async () => {
    const wallet = solanaWallet('me-streak');
    const { token } = await h.login('SOL', wallet);

    const first = (await (await h.app.request('/me', { headers: authed(token) })).json()) as MeBody;
    expect(first.streak).toBe(1);
    expect(first.streakMult).toBe(1);

    // Same UTC day: visiting again is not a second day.
    const second = (await (
      await h.app.request('/me', { headers: authed(token) })
    ).json()) as MeBody;
    expect(second.streak).toBe(1);
  });

  it('extends the streak on the next UTC day and raises the multiplier', async () => {
    const wallet = solanaWallet('me-streak-2');
    const first = await h.login('SOL', wallet);
    await h.app.request('/me', { headers: authed(first.token) });

    // A day later the access token has long expired, so this is a fresh
    // session — which is also the realistic shape of a returning visit.
    h.advance(24 * 60 * 60 * 1000);
    await h.clearRateLimits();
    const second = await h.login('SOL', wallet);

    const next = (await (
      await h.app.request('/me', { headers: authed(second.token) })
    ).json()) as MeBody;
    expect(next.streak).toBe(2);
    expect(next.streakMult).toBeGreaterThan(1);
  });

  it('reflects a crate open in the same payload the strip reads', async () => {
    const { token } = await h.login('SOL', solanaWallet('me-after-crate'));
    await h.app.request('/rewards/crates/bronze/open', { method: 'POST', headers: authed(token) });

    const body = (await (await h.app.request('/me', { headers: authed(token) })).json()) as MeBody;
    expect(body.xp).toBeGreaterThan(0);
    expect(body.achievements.map((a) => a.key)).toContain('crate');
    const bronze = body.crates.find((c) => c.tier === 'BRONZE');
    expect(bronze).toMatchObject({ ready: false, opens: 1 });
    expect(bronze?.readyAt).toBeGreaterThan(h.now());
  });

  it('prices the native balance from the oracle, not a constant', async () => {
    const wallet = solanaWallet('me-balance');
    const { token, address } = await h.login('SOL', wallet);
    h.rpcs.SOL.setBalance(address, 12.5);

    const body = (await (await h.app.request('/me', { headers: authed(token) })).json()) as MeBody;
    expect(body.native.balance).toBe(12.5);
    expect(body.native.usdPrice).toBe(214.08);
    expect(body.native.usdValue).toBeCloseTo(12.5 * 214.08, 6);
  });

  it('does not leak $STONKZ as a spendable balance before Phase 7', async () => {
    const { token } = await h.login('SOL', solanaWallet('me-no-stonkz'));
    const raw = await (await h.app.request('/me', { headers: authed(token) })).text();
    // `$STONKZ` crate payouts are off-chain reward credits (`stonkz`), not a token balance.
    expect(raw).not.toMatch(/stonkzBalance|"\$STONKZ"/);
  });
});

describe('GET /rewards', () => {
  it('publishes the advertised odds without exposing the roll', async () => {
    const { token } = await h.login('SOL', solanaWallet('rewards-odds'));
    const res = await h.app.request('/rewards', { headers: authed(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      cratesReady: number;
      achievementCount: number;
      crates: {
        tier: string;
        drops: {
          rarity: string;
          odds: number;
          kind: string;
          min: number | null;
          max: number | null;
          asset: string | null;
          item: string | null;
        }[];
      }[];
    };

    // L1 grants BRONZE×2 only — cratesReady counts openable inventory, not tiers.
    expect(body.cratesReady).toBe(1);
    expect(body.achievementCount).toBe(0);
    const bronze = body.crates.find((c) => c.tier === 'BRONZE') as (typeof body.crates)[number] & {
      inventory?: number;
      openable?: boolean;
    };
    expect(bronze?.inventory).toBe(2);
    expect(bronze?.openable).toBe(true);

    for (const crate of body.crates) {
      // Five rarity rows per crate, and the odds sum to 100.
      expect(crate.drops).toHaveLength(5);
      expect(crate.drops.reduce((sum, d) => sum + d.odds, 0)).toBeCloseTo(100, 6);
      for (const drop of crate.drops) {
        // Every row is exactly one kind and carries only that kind's fields.
        if (drop.kind === 'STONKZ') {
          expect(drop.min).not.toBeNull();
          expect(drop.max).not.toBeNull();
          expect(drop.asset).toBeNull();
          expect(drop.item).toBeNull();
        } else if (drop.kind === 'RWA') {
          expect(drop.asset).not.toBeNull();
          expect(drop.min).toBeGreaterThan(0);
          expect(drop.max).toBeGreaterThanOrEqual(drop.min as number);
          expect(drop.item).toBeNull();
        } else {
          expect(drop.kind).toBe('ITEM');
          expect(drop.item).not.toBeNull();
          expect(drop.min).toBeNull();
          expect(drop.asset).toBeNull();
        }
      }
    }
  });

  it('pays $STONKZ credits and catalog RWA assets only', async () => {
    const { token } = await h.login('SOL', solanaWallet('rewards-stonkz'));
    const res = await h.app.request('/rewards', { headers: authed(token) });
    const raw = await res.clone().text();
    expect(raw).not.toMatch(/optionz/i);
    const body = (await res.json()) as {
      stonkz: number;
      rwa: unknown[];
      crates: { drops: { kind: string; asset: string | null }[] }[];
    };
    expect(body.stonkz).toBe(0);
    expect(body.rwa).toEqual([]);
    const catalog = new Set<string>(RWA_ASSETS.map((a) => a[0]));
    const rwaRows = body.crates.flatMap((c) => c.drops.filter((d) => d.kind === 'RWA'));
    expect(rwaRows.length).toBeGreaterThan(0);
    for (const row of rwaRows) expect(catalog.has(row.asset as string)).toBe(true);
  });

  it('requires a session', async () => {
    expect((await h.app.request('/rewards')).status).toBe(401);
  });
});

describe('GET /achievements', () => {
  it('lists every definition without a session', async () => {
    const res = await h.app.request('/achievements');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      net: string | null;
      unlocked: number;
      total: number;
      achievements: { key: string; name: string; xp: number; unlockedAt: number | null }[];
    };

    expect(body.net).toBeNull();
    expect(body.total).toBe(ACH.length);
    expect(body.unlocked).toBe(0);
    // Definitions are public; unlock state is not.
    expect(body.achievements.every((a) => a.unlockedAt === null)).toBe(true);
    expect(body.achievements.map((a) => a.key).sort()).toEqual(ACH.map((a) => a.k).sort());
  });

  it('marks unlock timestamps for the session wallet', async () => {
    const { token } = await h.login('SOL', solanaWallet('ach-unlocked'));
    await h.app.request('/rewards/crates/bronze/open', { method: 'POST', headers: authed(token) });

    const res = await h.app.request('/achievements', { headers: authed(token) });
    const body = (await res.json()) as {
      net: string;
      unlocked: number;
      achievements: { key: string; unlockedAt: number | null }[];
    };
    expect(body.net).toBe('SOL');
    expect(body.unlocked).toBe(1);
    expect(body.achievements.find((a) => a.key === 'crate')?.unlockedAt).toBe(h.now());
  });

  it('keeps unlock state per wallet', async () => {
    const { token: mine } = await h.login('SOL', solanaWallet('ach-mine'));
    await h.app.request('/rewards/crates/bronze/open', { method: 'POST', headers: authed(mine) });

    const { token: theirs } = await h.login('SOL', solanaWallet('ach-theirs'));
    const res = await h.app.request('/achievements', { headers: authed(theirs) });
    expect(((await res.json()) as { unlocked: number }).unlocked).toBe(0);
  });

  it('keeps unlock state per net for the same address', async () => {
    const wallet = solanaWallet('ach-per-net');
    const { token } = await h.login('SOL', wallet);
    await h.app.request('/rewards/crates/bronze/open', { method: 'POST', headers: authed(token) });

    // The same achievement on Robinhood is a separate unlock.
    const rhKeys = await h.deps.ledger.unlockedKeys('RH', wallet.address);
    expect(rhKeys).not.toContain('crate');
  });
});

describe('GET /rewards RWA USD values', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetDefiLlamaClients();
  });

  it('prices held RWA rewards from DefiLlama', async () => {
    const { token, address } = await h.login('SOL', solanaWallet('rwa-usd'));
    await h.deps.ledger.creditRwa('SOL', address, 'PAXG', 0.5, 'test', 'rwa-usd-1');
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({
          coins: {
            'coingecko:pax-gold': {
              price: 4000,
              symbol: 'PAXG',
              timestamp: Math.floor(Date.now() / 1000),
              confidence: 0.99,
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const res = await h.app.request('/rewards', { headers: authed(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rwaUsd: {
        total: number | null;
        positions: { asset: string; units: number; usd: number | null }[];
      };
    };
    expect(calls.some((u) => u.includes('coingecko:pax-gold'))).toBe(true);
    expect(body.rwaUsd.total).toBeCloseTo(2000, 6);
    expect(body.rwaUsd.positions).toEqual([{ asset: 'PAXG', units: 0.5, usd: 2000 }]);
  });

  it('degrades to null USD when DefiLlama is down', async () => {
    const { token, address } = await h.login('SOL', solanaWallet('rwa-usd-down'));
    await h.deps.ledger.creditRwa('SOL', address, 'PAXG', 1, 'test', 'rwa-usd-2');
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('network down');
    });
    const res = await h.app.request('/rewards', { headers: authed(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rwaUsd: { total: number | null; positions: { usd: number | null }[] };
    };
    expect(body.rwaUsd.total).toBeNull();
    expect(body.rwaUsd.positions[0]?.usd).toBeNull();
  });

  it('skips DefiLlama entirely when no RWA is held', async () => {
    const { token } = await h.login('SOL', solanaWallet('rwa-usd-none'));
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await h.app.request('/rewards', { headers: authed(token) });
    const body = (await res.json()) as { rwaUsd: { total: number | null; positions: unknown[] } };
    expect(body.rwaUsd).toEqual({ total: null, positions: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
