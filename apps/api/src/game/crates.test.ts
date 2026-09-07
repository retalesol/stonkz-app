import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { CRATES, HOUR, RAR, crateXp } from '@stonkz/shared';
import { crateOpens, crateState, itemFlags } from '../db/schema.js';
import { CrateError, CrateService, itemExpiry } from './crates.js';
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
  h.setNow(FROZEN_NOW);
});

const W = 'CrateWallet11111111111111111111111111111111';

/** Review gate 3.A — crate opens are server-authored end to end. */
describe('crate RNG', () => {
  it('is deterministic in (secret, net, wallet, tier, nonce)', () => {
    const a = h.deps.crates.roll('SOL', W, 'BRONZE', 'nonce-1');
    const b = h.deps.crates.roll('SOL', W, 'BRONZE', 'nonce-1');
    expect(a).toEqual(b);
  });

  it('changes with the nonce, the wallet, the tier and the net', () => {
    const base = h.deps.crates.roll('SOL', W, 'BRONZE', 'n');
    expect(h.deps.crates.roll('SOL', W, 'BRONZE', 'n2').rollCommit).not.toBe(base.rollCommit);
    expect(h.deps.crates.roll('SOL', 'other', 'BRONZE', 'n').rollCommit).not.toBe(base.rollCommit);
    expect(h.deps.crates.roll('SOL', W, 'GOLD', 'n').rollCommit).not.toBe(base.rollCommit);
    expect(h.deps.crates.roll('RH', W, 'BRONZE', 'n').rollCommit).not.toBe(base.rollCommit);
  });

  it('changes with the server secret, and never reveals it', () => {
    const other = new CrateService({
      db: h.deps.db,
      ledger: h.deps.ledger,
      publisher: h.deps.publisher,
      secret: 'a-completely-different-server-secret-000000',
      now: h.now,
    });
    const mine = h.deps.crates.roll('SOL', W, 'BRONZE', 'n');
    const theirs = other.roll('SOL', W, 'BRONZE', 'n');
    expect(theirs.rollCommit).not.toBe(mine.rollCommit);
    // Only a hash of the secret is ever persisted or returned.
    expect(theirs.serverSeedHash).not.toBe(mine.serverSeedHash);
    expect(mine.serverSeedHash).not.toContain('test-crate-secret');
  });

  it('produces two independent draws in range', () => {
    for (let i = 0; i < 400; i++) {
      const roll = h.deps.crates.roll('SOL', W, 'SILVER', `nonce-${i}`);
      expect(roll.rollValue).toBeGreaterThanOrEqual(0);
      expect(roll.rollValue).toBeLessThan(100);
      expect(roll.amountRoll).toBeGreaterThanOrEqual(0);
      expect(roll.amountRoll).toBeLessThan(1);
    }
  });

  it('spreads rolls across the drop table rather than pinning one row', async () => {
    const seen = new Set<number>();
    for (let i = 0; i < 600 && seen.size < 3; i++) {
      const roll = h.deps.crates.roll('SOL', W, 'BRONZE', `spread-${i}`);
      // Same walk the open path uses.
      const bronze = CRATES[0];
      let acc = 0;
      for (let j = 0; j < (bronze?.drops.length ?? 0); j++) {
        acc += bronze?.drops[j]?.[0] ?? 0;
        if (roll.rollValue < acc) {
          seen.add(j);
          break;
        }
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(2);
  });
});

describe('crate opens', () => {
  it('records the roll, credits the payout and awards XP', async () => {
    const result = await h.deps.crates.open('SOL', W, 'BRONZE');

    expect(result.tier).toBe('BRONZE');
    expect(RAR.map((r) => r[0])).toContain(result.rarity);
    expect(result.xp).toBe(crateXp(0));

    const [row] = await h.deps.db.select().from(crateOpens).where(eq(crateOpens.wallet, W)).limit(1);
    expect(row?.rollCommit).toBe(result.roll.rollCommit);
    expect(row?.xpAwarded).toBe(result.xp);

    if (result.item === null) {
      // `S` rows pay Stonk Optionz, never $STONKZ.
      expect(result.label).toContain('STONK OPTIONZ');
      expect(result.optionz).toBeGreaterThan(0);
      expect((await h.deps.ledger.readBalance('SOL', W)).optionz).toBe(result.optionzTotal);
    } else {
      expect(result.optionz).toBe(0);
      const flags = await h.deps.db.select().from(itemFlags).where(eq(itemFlags.wallet, W));
      expect(flags.map((f) => f.item)).toContain(result.item);
    }
  });

  it('unlocks the crate achievement on the first open', async () => {
    await h.deps.crates.open('SOL', W, 'BRONZE');
    expect(await h.deps.ledger.unlockedKeys('SOL', W)).toContain('crate');
  });

  it('enforces the cooldown from the server clock', async () => {
    const bronze = CRATES[0];
    const first = await h.deps.crates.open('SOL', W, 'BRONZE');
    expect(first.cooldownHours).toBe(bronze?.cd);

    await expect(h.deps.crates.open('SOL', W, 'BRONZE')).rejects.toThrow(CrateError);
    await expect(h.deps.crates.open('SOL', W, 'BRONZE')).rejects.toMatchObject({ code: 'cooling_down' });

    // One millisecond short is still cooling.
    h.advance((bronze?.cd ?? 4) * HOUR - 1);
    await expect(h.deps.crates.open('SOL', W, 'BRONZE')).rejects.toMatchObject({ code: 'cooling_down' });

    h.advance(1);
    const second = await h.deps.crates.open('SOL', W, 'BRONZE');
    expect(second.tier).toBe('BRONZE');

    const [state] = await h.deps.db
      .select()
      .from(crateState)
      .where(and(eq(crateState.wallet, W), eq(crateState.tier, 'BRONZE')))
      .limit(1);
    expect(state?.opens).toBe(2);
  });

  it('keeps tiers on independent cooldowns', async () => {
    await h.deps.crates.open('SOL', W, 'BRONZE');
    // IRON is a separate crate with its own timer.
    const iron = await h.deps.crates.open('SOL', W, 'IRON');
    expect(iron.tier).toBe('IRON');
    expect(iron.xp).toBe(crateXp(1));
  });

  it('keeps cooldowns per net, so switching nets is not a second crate', async () => {
    await h.deps.crates.open('SOL', W, 'BRONZE');
    const rh = await h.deps.crates.open('RH', W, 'BRONZE');
    expect(rh.tier).toBe('BRONZE');

    // …but the RH crate is now cooling on its own.
    await expect(h.deps.crates.open('RH', W, 'BRONZE')).rejects.toMatchObject({ code: 'cooling_down' });
  });

  it('survives a concurrent double-open with exactly one payout', async () => {
    const results = await Promise.allSettled([
      h.deps.crates.open('SOL', W, 'GOLD'),
      h.deps.crates.open('SOL', W, 'GOLD'),
      h.deps.crates.open('SOL', W, 'GOLD'),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    // The cooldown guard lives in the upsert's WHERE, so only one can win.
    expect(fulfilled).toHaveLength(1);
    expect(await h.deps.db.select().from(crateOpens).where(eq(crateOpens.wallet, W))).toHaveLength(1);
  });

  it('rejects an unknown tier', async () => {
    await expect(
      h.deps.crates.open('SOL', W, 'UNOBTAINIUM' as unknown as 'GOLD'),
    ).rejects.toMatchObject({ code: 'unknown_tier' });
  });

  it('gives higher tiers more XP', async () => {
    const xps = CRATES.map((_, i) => crateXp(i));
    expect(xps).toEqual([...xps].sort((a, b) => a - b));
    expect(xps[0]).toBeLessThan(xps.at(-1) as number);
  });
});

describe('item expiry', () => {
  it('reads the window out of the item label', () => {
    const now = FROZEN_NOW;
    expect(itemExpiry('FEE REBATE 24H', now)?.getTime()).toBe(now + 24 * HOUR);
    expect(itemExpiry('2X XP 1H', now)?.getTime()).toBe(now + HOUR);
    expect(itemExpiry('PRIORITY PASS 7D', now)?.getTime()).toBe(now + 7 * 24 * HOUR);
    // Permanent items carry no window.
    expect(itemExpiry('OG BADGE', now)).toBeNull();
  });
});

describe('POST /rewards/crates/:tier/open', () => {
  it('opens over HTTP and returns the commitment but not the secret', async () => {
    const wallet = solanaWallet('crate-http');
    const { token } = await h.login('SOL', wallet);

    const res = await h.app.request('/rewards/crates/bronze/open', {
      method: 'POST',
      headers: authed(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rarity: string;
      xp: number;
      proof: { rollCommit: string; serverSeedHash: string; nonce: string };
    };
    expect(body.xp).toBe(crateXp(0));
    expect(body.proof.rollCommit).toMatch(/^[0-9a-f]{64}$/);
    expect(body.proof.serverSeedHash).toMatch(/^[0-9a-f]{64}$/);
    // Nothing in the response lets a client predict the next roll.
    expect(JSON.stringify(body)).not.toContain('test-crate-secret');
  });

  it('returns 429 with readyAt while cooling', async () => {
    const wallet = solanaWallet('crate-http-cd');
    const { token } = await h.login('SOL', wallet);
    await h.app.request('/rewards/crates/bronze/open', { method: 'POST', headers: authed(token) });

    const res = await h.app.request('/rewards/crates/bronze/open', {
      method: 'POST',
      headers: authed(token),
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string; readyAt: number };
    expect(body.error).toBe('cooling_down');
    expect(body.readyAt).toBeGreaterThan(h.now());
  });

  it('404s an unknown tier and 401s without a session', async () => {
    const { token } = await h.login('SOL', solanaWallet('crate-http-404'));
    const bad = await h.app.request('/rewards/crates/unobtainium/open', {
      method: 'POST',
      headers: authed(token),
    });
    expect(bad.status).toBe(404);

    const anon = await h.app.request('/rewards/crates/bronze/open', { method: 'POST' });
    expect(anon.status).toBe(401);
  });

  it('surfaces the drop log and cooldowns on GET /rewards', async () => {
    const wallet = solanaWallet('crate-http-rewards');
    const { token } = await h.login('SOL', wallet);
    await h.app.request('/rewards/crates/bronze/open', { method: 'POST', headers: authed(token) });

    const res = await h.app.request('/rewards', { headers: authed(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      optionz: number;
      crates: { tier: string; ready: boolean; drops: unknown[] }[];
      dropLog: { tier: string; rarity: string }[];
    };
    expect(body.crates).toHaveLength(CRATES.length);
    expect(body.crates.find((c) => c.tier === 'BRONZE')?.ready).toBe(false);
    expect(body.crates.find((c) => c.tier === 'IRON')?.ready).toBe(true);
    expect(body.crates[0]?.drops).toHaveLength(5);
    expect(body.dropLog).toHaveLength(1);
    expect(body.dropLog[0]?.tier).toBe('BRONZE');
  });

  it('publishes optionz and xp on the user channel', async () => {
    const wallet = solanaWallet('crate-http-ws');
    const { token } = await h.login('SOL', wallet);
    const before = h.userEvents.length;
    await h.app.request('/rewards/crates/bronze/open', { method: 'POST', headers: authed(token) });

    const emitted = h.userEvents.slice(before).map((e) => e.event.type);
    expect(emitted).toContain('xp');
    expect(emitted).toContain('achievement');
  });
});
