import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ACH, CRATES, RANKS } from '@stonkz/shared';
import { authed, createTestApp, FROZEN_NOW, type TestApp } from '../test/app.js';
import { solanaWallet } from '../test/wallets.js';

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
  native: { unit: string; balance: number | null; usdPrice: number | null; usdValue: number | null };
  xp: number;
  rank: { i: number; name: string; next: number | null };
  sp: number;
  optionz: number;
  streak: number;
  streakMult: number;
  achievements: { key: string; unlockedAt: number }[];
  crates: { tier: string; ready: boolean; readyAt: number | null; opens: number }[];
  items: { item: string; count: number; expiresAt: number | null }[];
  settings: unknown;
}

/** Plan step 120 — `GET /me` hydrates the whole rewards strip in one trip. */
describe('GET /me rewards payload', () => {
  it('carries xp, rank, sp, optionz, crates, streak and achievements', async () => {
    const { token } = await h.login('SOL', solanaWallet('me-rewards'));
    const res = await h.app.request('/me', { headers: authed(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as MeBody;

    // A brand-new wallet: everything present and zeroed, nothing missing.
    expect(body).toMatchObject({ net: 'SOL', xp: 0, sp: 0, optionz: 0 });
    expect(body.rank).toMatchObject({ i: 0, name: RANKS[0]?.[0] });
    expect(body.achievements).toEqual([]);
    expect(body.items).toEqual([]);
    expect(body.crates).toHaveLength(CRATES.length);
    expect(body.crates.every((c) => c.ready)).toBe(true);
    expect(body.native.unit).toBe('SOL');
  });

  it('opens the streak at one on first visit and holds it the same day', async () => {
    const wallet = solanaWallet('me-streak');
    const { token } = await h.login('SOL', wallet);

    const first = (await (await h.app.request('/me', { headers: authed(token) })).json()) as MeBody;
    expect(first.streak).toBe(1);
    expect(first.streakMult).toBe(1);

    // Same UTC day: visiting again is not a second day.
    const second = (await (await h.app.request('/me', { headers: authed(token) })).json()) as MeBody;
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

    const next = (await (await h.app.request('/me', { headers: authed(second.token) })).json()) as MeBody;
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
    // SP and Optionz are the only reward currencies until the token exists.
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
        drops: { rarity: string; odds: number; kind: string; min: number | null; item: string | null }[];
      }[];
    };

    expect(body.cratesReady).toBe(CRATES.length);
    expect(body.achievementCount).toBe(0);

    for (const crate of body.crates) {
      // Five rarity rows per crate, and the odds sum to 100.
      expect(crate.drops).toHaveLength(5);
      expect(crate.drops.reduce((sum, d) => sum + d.odds, 0)).toBeCloseTo(100, 6);
      for (const drop of crate.drops) {
        // Every row is one kind or the other, never both, never neither.
        if (drop.kind === 'OPTIONZ') {
          expect(drop.min).not.toBeNull();
          expect(drop.item).toBeNull();
        } else {
          expect(drop.kind).toBe('ITEM');
          expect(drop.item).not.toBeNull();
          expect(drop.min).toBeNull();
        }
      }
    }
  });

  it('never labels a payout as $STONKZ', async () => {
    const { token } = await h.login('SOL', solanaWallet('rewards-optionz'));
    const raw = await (await h.app.request('/rewards', { headers: authed(token) })).text();
    expect(raw).not.toContain('$STONKZ');
    expect(raw).toContain('OPTIONZ');
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
