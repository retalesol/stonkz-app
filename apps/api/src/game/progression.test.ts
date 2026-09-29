import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { HOUR, XP_DAILY_CHECKIN, applyXpMult } from '@stonkz/shared';
import { chainEvents, xpEvents } from '../db/schema.js';
import { authed, createTestApp, FROZEN_NOW, type TestApp } from '../test/app.js';
import { evmWallet } from '../test/wallets.js';
import { ITEM_XP_BOOST } from './items.js';

/**
 * Progression audit: the pieces that sit between the ledger's own invariants
 * (`ledger.test.ts`) and the crate flow (`crates.test.ts`) — item effects,
 * per-net dedupe of synthetic award keys, and the earning paths the rewards
 * page depends on.
 */

let h: TestApp;
const W = 'ProgressWallet1111111111111111111111111111';

beforeAll(async () => {
  h = await createTestApp({ env: { DAILY_XP_CAP: '1000', DAILY_SP_CAP: '1000' } });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.db.reset();
  await h.clearRateLimits();
  h.setNow(FROZEN_NOW);
});

async function verifyEvent(txSig: string, net: 'SOL' | 'RH' = 'SOL'): Promise<void> {
  await h.deps.db.insert(chainEvents).values({
    net,
    kind: 'Trade',
    sym: 'TEST',
    wallet: W,
    txSig,
    logIndex: 0,
    chainPosition: 1,
    blockTime: new Date(h.now()),
    payload: {},
  });
}

describe('XP BOOST 2X 1H item', () => {
  it('doubles XP and SP while active, records the boost, and expires', async () => {
    await h.deps.ledger.grantItem('SOL', W, ITEM_XP_BOOST, new Date(h.now() + HOUR));
    await verifyEvent('boosted');
    const boosted = await h.deps.ledger.award({
      net: 'SOL',
      wallet: W,
      reason: 'trade',
      baseXp: 40,
      txSig: 'boosted',
    });
    expect(boosted).toMatchObject({ xp: 80, sp: 80 });
    const [row] = await h.deps.db.select().from(xpEvents).where(eq(xpEvents.txSig, 'boosted'));
    expect(row?.meta).toMatchObject({ boost: 2 });
    expect(row?.baseAmount).toBe(40);

    h.advance(HOUR + 1);
    await verifyEvent('after-boost');
    const plain = await h.deps.ledger.award({
      net: 'SOL',
      wallet: W,
      reason: 'trade',
      baseXp: 40,
      txSig: 'after-boost',
    });
    expect(plain.xp).toBe(40);
    expect(await h.deps.ledger.activeItems('SOL', W)).toEqual([]);
  });

  it('never lifts an award above the daily cap', async () => {
    await h.deps.ledger.grantItem('SOL', W, ITEM_XP_BOOST, new Date(h.now() + HOUR));
    await verifyEvent('cap-a');
    const a = await h.deps.ledger.award({
      net: 'SOL',
      wallet: W,
      reason: 'trade',
      baseXp: 400,
      txSig: 'cap-a',
    });
    expect(a.xp).toBe(800);
    await verifyEvent('cap-b');
    const b = await h.deps.ledger.award({
      net: 'SOL',
      wallet: W,
      reason: 'trade',
      baseXp: 400,
      txSig: 'cap-b',
    });
    expect(b).toMatchObject({ xp: 200, cappedBy: 'daily_xp' });
    expect((await h.deps.ledger.readBalance('SOL', W)).xp).toBe(1000);
  });

  it('does not touch a zero (dust) award', async () => {
    await h.deps.ledger.grantItem('SOL', W, ITEM_XP_BOOST, new Date(h.now() + HOUR));
    await verifyEvent('dust');
    const res = await h.deps.ledger.award({
      net: 'SOL',
      wallet: W,
      reason: 'trade',
      baseXp: 0,
      txSig: 'dust',
      zeroAward: true,
    });
    expect(res.xp).toBe(0);
  });
});

describe('daily check-in across EVM nets', () => {
  it('pays the same address once per UTC day on each net it uses', async () => {
    const w = evmWallet('multi-net');
    const rh = await h.login('RH', w);
    const base = await h.login('BASE', w);

    const a = (await (await h.app.request('/rewards', { headers: authed(rh.token) })).json()) as {
      sp: number;
    };
    const b = (await (await h.app.request('/rewards', { headers: authed(base.token) })).json()) as {
      sp: number;
    };
    // Before 0025 the second net's `checkin:<day>` collided with the first
    // and the flag rolled back every visit.
    expect(a.sp).toBe(XP_DAILY_CHECKIN);
    expect(b.sp).toBe(XP_DAILY_CHECKIN);

    // Same day, same net: no second payout.
    const again = (await (
      await h.app.request('/rewards', { headers: authed(base.token) })
    ).json()) as { sp: number };
    expect(again.sp).toBe(XP_DAILY_CHECKIN);
  });

  it('pays again after the UTC day boundary', async () => {
    const w = evmWallet('day-boundary');
    const first = await h.login('RH', w);
    await h.app.request('/rewards', { headers: authed(first.token) });
    h.setNow(Date.parse('2026-09-06T23:59:59.000Z'));
    // Fresh tokens after each clock move: the access JWT is short-lived.
    const late = await h.login('RH', w);
    await h.app.request('/rewards', { headers: authed(late.token) });
    h.setNow(Date.parse('2026-09-07T00:00:00.000Z'));
    const { token } = await h.login('RH', w);
    const next = (await (await h.app.request('/rewards', { headers: authed(token) })).json()) as {
      sp: number;
      streak: number;
    };
    // Day two's check-in rides the streak multiplier (×1.05 → 11).
    expect(next.sp).toBe(XP_DAILY_CHECKIN + applyXpMult(XP_DAILY_CHECKIN, 2));
    expect(next.streak).toBe(2);
  });
});

describe('GET /rewards progression payload', () => {
  it('carries the level ladder, the next commitment, items and the claims state', async () => {
    const { token } = await h.login('RH', evmWallet('payload'));
    const res = await h.app.request('/rewards', { headers: authed(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      nextCommit: string;
      claims: { open: boolean; stonkz: { open: boolean; reason: string } };
      spLevel: {
        level: number;
        claimed: number[];
        levels: { level: number; claimed: boolean; reached: boolean }[];
      };
      items: unknown[];
      tables: { crates: boolean; levels: boolean };
    };
    expect(body.nextCommit).toMatch(/^[0-9a-f]{64}$/);
    expect(body.claims.open).toBe(false);
    expect(body.claims.stonkz.reason).toBe('claims_open_soon');
    expect(body.spLevel.level).toBe(1);
    expect(body.spLevel.claimed).toEqual([1]);
    expect(body.spLevel.levels[0]).toMatchObject({ level: 1, claimed: true, reached: true });
    expect(body.spLevel.levels[1]).toMatchObject({ level: 2, claimed: false, reached: false });
    expect(body.items).toEqual([]);
    expect(body.tables).toEqual({ crates: false, levels: false });
  });

  it('lists a held item with its effect and whether it is live', async () => {
    const w = evmWallet('items');
    const { token, address } = await h.login('RH', w);
    await h.deps.ledger.grantItem('RH', address, ITEM_XP_BOOST, new Date(h.now() + HOUR));
    await h.deps.ledger.grantItem('RH', address, 'FEE REBATE 24H', new Date(h.now() + 24 * HOUR));
    const body = (await (await h.app.request('/rewards', { headers: authed(token) })).json()) as {
      items: { item: string; active: boolean; implemented: boolean; effect: string }[];
    };
    const byItem = new Map(body.items.map((i) => [i.item, i]));
    expect(byItem.get(ITEM_XP_BOOST)).toMatchObject({
      active: true,
      implemented: true,
      effect: 'xp_boost',
    });
    expect(byItem.get('FEE REBATE 24H')).toMatchObject({
      active: true,
      implemented: false,
      effect: 'fee_rebate',
    });
  });
});

describe('replay across nets', () => {
  it('still dedupes a chain signature per net and pays it on the other net', async () => {
    await verifyEvent('shared-sig', 'SOL');
    await verifyEvent('shared-sig', 'RH');
    const sol = await h.deps.ledger.award({
      net: 'SOL',
      wallet: W,
      reason: 'trade',
      baseXp: 40,
      txSig: 'shared-sig',
    });
    const solAgain = await h.deps.ledger.award({
      net: 'SOL',
      wallet: W,
      reason: 'trade',
      baseXp: 40,
      txSig: 'shared-sig',
    });
    const rh = await h.deps.ledger.award({
      net: 'RH',
      wallet: W,
      reason: 'trade',
      baseXp: 40,
      txSig: 'shared-sig',
    });
    expect(sol.awarded).toBe(true);
    expect(solAgain.awarded).toBe(false);
    expect(rh.awarded).toBe(true);
    const rows = await h.deps.db
      .select()
      .from(xpEvents)
      .where(and(eq(xpEvents.wallet, W), eq(xpEvents.txSig, 'shared-sig')));
    expect(rows).toHaveLength(2);
  });
});
