import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { RANKS, achOf, rankOf, xpForTrade, xpMult } from '@stonkz/shared';
import { balanceLedger, chainEvents, xpEvents } from '../db/schema.js';
import { UnverifiedEventError } from './ledger.js';
import { previousUtcDay, utcDayKey } from './day.js';
import { createTestApp, FROZEN_NOW, type TestApp } from '../test/app.js';

let h: TestApp;
const W = 'LedgerWallet1111111111111111111111111111111';

beforeAll(async () => {
  h = await createTestApp({ env: { DAILY_XP_CAP: '500', DAILY_SP_CAP: '500' } });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.db.reset();
  h.setNow(FROZEN_NOW);
});

/** Registers a chain event so a chain-derived reason is allowed to pay out. */
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

/** Review gate 3.A — the ledger's invariants. */
describe('no XP without a verified event', () => {
  it('refuses a chain reason with no chain_events row', async () => {
    await expect(
      h.deps.ledger.award({ net: 'SOL', wallet: W, reason: 'trade', baseXp: 100, txSig: 'never-seen' }),
    ).rejects.toThrow(UnverifiedEventError);

    expect(await h.deps.ledger.readBalance('SOL', W)).toMatchObject({ xp: 0, sp: 0 });
  });

  it('refuses a chain reason with no signature at all', async () => {
    await expect(
      h.deps.ledger.award({ net: 'SOL', wallet: W, reason: 'trade', baseXp: 100 }),
    ).rejects.toThrow(UnverifiedEventError);
  });

  it('will not accept an event verified on the other chain', async () => {
    await verifyEvent('sig-sol-only', 'SOL');
    await expect(
      h.deps.ledger.award({ net: 'RH', wallet: W, reason: 'trade', baseXp: 100, txSig: 'sig-sol-only' }),
    ).rejects.toThrow(UnverifiedEventError);
  });

  it('pays once the event exists', async () => {
    await verifyEvent('sig-ok');
    const result = await h.deps.ledger.award({
      net: 'SOL',
      wallet: W,
      reason: 'trade',
      baseXp: 100,
      txSig: 'sig-ok',
    });
    expect(result.awarded).toBe(true);
    expect(result.xp).toBe(100);
  });

  it('allows server-authored reasons without a signature', async () => {
    // Crate XP is rolled by this process, so there is nothing to verify.
    const result = await h.deps.ledger.award({ net: 'SOL', wallet: W, reason: 'crate', baseXp: 20 });
    expect(result.awarded).toBe(true);
    expect(result.xp).toBe(20);
  });
});

describe('replay safety', () => {
  it('pays a (signature, reason) pair exactly once', async () => {
    await verifyEvent('sig-replay');
    const input = { net: 'SOL' as const, wallet: W, reason: 'trade', baseXp: 40, txSig: 'sig-replay' };

    const first = await h.deps.ledger.award(input);
    expect(first).toMatchObject({ awarded: true, xp: 40 });

    const second = await h.deps.ledger.award(input);
    expect(second).toMatchObject({ awarded: false, xp: 0, sp: 0 });

    expect((await h.deps.ledger.readBalance('SOL', W)).xp).toBe(40);
  });

  it('still pays a different reason on the same signature', async () => {
    await verifyEvent('sig-two-reasons');
    await h.deps.ledger.award({ net: 'SOL', wallet: W, reason: 'trade', baseXp: 40, txSig: 'sig-two-reasons' });
    const unlock = await h.deps.ledger.unlock('SOL', W, 'first', 'sig-two-reasons');
    expect(unlock.unlocked).toBe(true);
    expect((await h.deps.ledger.readBalance('SOL', W)).xp).toBe(40 + (achOf('first')?.xp ?? 0));
  });

  it('keeps balances as an exact fold of the append-only tables', async () => {
    await verifyEvent('sig-fold');
    await h.deps.ledger.award({ net: 'SOL', wallet: W, reason: 'trade', baseXp: 90, txSig: 'sig-fold' });
    await h.deps.ledger.award({ net: 'SOL', wallet: W, reason: 'crate', baseXp: 35 });

    const events = await h.deps.db
      .select()
      .from(xpEvents)
      .where(and(eq(xpEvents.wallet, W), eq(xpEvents.net, 'SOL')));
    const summed = events.reduce((n, e) => n + e.amount, 0);
    expect((await h.deps.ledger.readBalance('SOL', W)).xp).toBe(summed);

    // Every balance move is traceable to the xp_event that caused it.
    const rows = await h.deps.db
      .select()
      .from(balanceLedger)
      .where(and(eq(balanceLedger.wallet, W), eq(balanceLedger.asset, 'XP')));
    expect(rows.every((r) => r.refType === 'xp_event' && r.refId !== null)).toBe(true);
    expect(rows.at(-1)?.balanceAfter).toBe(summed);
  });
});

describe('daily caps', () => {
  it('clamps an award to the remaining cap and marks why', async () => {
    await verifyEvent('sig-cap-a');
    await verifyEvent('sig-cap-b');

    const first = await h.deps.ledger.award({
      net: 'SOL',
      wallet: W,
      reason: 'trade',
      baseXp: 400,
      txSig: 'sig-cap-a',
    });
    expect(first).toMatchObject({ xp: 400, cappedBy: 'none' });

    const second = await h.deps.ledger.award({
      net: 'SOL',
      wallet: W,
      reason: 'trade',
      baseXp: 400,
      txSig: 'sig-cap-b',
    });
    // 500 cap, 400 already banked — only 100 left.
    expect(second).toMatchObject({ xp: 100, baseXp: 400, cappedBy: 'daily_xp' });
    expect((await h.deps.ledger.readBalance('SOL', W)).xp).toBe(500);
  });

  it('awards zero once the cap is spent, but still records the event', async () => {
    await verifyEvent('sig-full');
    await verifyEvent('sig-over');
    await h.deps.ledger.award({ net: 'SOL', wallet: W, reason: 'trade', baseXp: 500, txSig: 'sig-full' });

    const over = await h.deps.ledger.award({
      net: 'SOL',
      wallet: W,
      reason: 'trade',
      baseXp: 250,
      txSig: 'sig-over',
    });
    expect(over).toMatchObject({ awarded: true, xp: 0, cappedBy: 'daily_xp' });
    // Recorded at zero, so a re-delivery cannot pay it tomorrow.
    const rows = await h.deps.db.select().from(xpEvents).where(eq(xpEvents.txSig, 'sig-over'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toBe(0);
  });

  it('resets at the UTC day boundary, not the client’s', async () => {
    await verifyEvent('sig-day1');
    await h.deps.ledger.award({ net: 'SOL', wallet: W, reason: 'trade', baseXp: 500, txSig: 'sig-day1' });

    h.setNow(Date.parse('2026-09-07T00:00:01.000Z'));
    await verifyEvent('sig-day2');
    const next = await h.deps.ledger.award({
      net: 'SOL',
      wallet: W,
      reason: 'trade',
      baseXp: 300,
      txSig: 'sig-day2',
    });
    expect(next).toMatchObject({ xp: 300, cappedBy: 'none' });
  });

  it('caps SP alongside XP', async () => {
    await verifyEvent('sig-sp');
    const result = await h.deps.ledger.award({
      net: 'SOL',
      wallet: W,
      reason: 'trade',
      baseXp: 900,
      txSig: 'sig-sp',
    });
    expect(result.xp).toBe(500);
    expect(result.sp).toBe(500);
    expect((await h.deps.ledger.readBalance('SOL', W)).sp).toBe(500);
  });
});

describe('streaks', () => {
  it('counts one per UTC day and is idempotent within a day', async () => {
    const first = await h.deps.ledger.touchStreak('SOL', W);
    expect(first).toMatchObject({ count: 1, advanced: true });

    const again = await h.deps.ledger.touchStreak('SOL', W);
    expect(again).toMatchObject({ count: 1, advanced: false });
  });

  it('increments on consecutive days and resets after a gap', async () => {
    await h.deps.ledger.touchStreak('SOL', W);
    h.setNow(Date.parse('2026-09-07T06:00:00.000Z'));
    expect((await h.deps.ledger.touchStreak('SOL', W)).count).toBe(2);

    h.setNow(Date.parse('2026-09-08T23:59:00.000Z'));
    expect((await h.deps.ledger.touchStreak('SOL', W)).count).toBe(3);

    // Skip 2026-09-09 entirely.
    h.setNow(Date.parse('2026-09-10T00:00:01.000Z'));
    expect((await h.deps.ledger.touchStreak('SOL', W)).count).toBe(1);
  });

  it('applies the shared multiplier to awards', async () => {
    // Walk to a 5-day streak.
    for (let day = 6; day <= 10; day++) {
      h.setNow(Date.parse(`2026-09-${String(day).padStart(2, '0')}T12:00:00.000Z`));
      await h.deps.ledger.touchStreak('SOL', W);
    }
    expect(await h.deps.ledger.currentStreak('SOL', W)).toBe(5);

    await verifyEvent('sig-mult');
    const result = await h.deps.ledger.award({
      net: 'SOL',
      wallet: W,
      reason: 'trade',
      baseXp: 100,
      txSig: 'sig-mult',
    });
    expect(result.mult).toBe(xpMult(5));
    expect(result.mult).toBeGreaterThan(1);
    // Multiplied first, then capped at 500.
    expect(result.xp).toBe(Math.min(500, Math.round(100 * xpMult(5))));
  });

  it('unlocks streak7 on the seventh consecutive day', async () => {
    for (let day = 1; day <= 7; day++) {
      h.setNow(Date.parse(`2026-09-0${day}T12:00:00.000Z`));
      const result = await h.deps.ledger.touchStreak('SOL', W);
      expect(result.count).toBe(day);
      expect(result.unlockedStreak7).toBe(day === 7);
    }
    expect(await h.deps.ledger.unlockedKeys('SOL', W)).toContain('streak7');
  });

  it('uses server UTC, so a client-side date cannot move it', async () => {
    // 23:30 UTC on the 6th and 00:30 UTC on the 7th are different days even
    // though they are ~1h apart, and the request carries no date at all.
    h.setNow(Date.parse('2026-09-06T23:30:00.000Z'));
    expect((await h.deps.ledger.touchStreak('SOL', W)).count).toBe(1);
    h.setNow(Date.parse('2026-09-07T00:30:00.000Z'));
    expect((await h.deps.ledger.touchStreak('SOL', W)).count).toBe(2);

    const today = utcDayKey(Date.parse('2026-09-07T00:30:00.000Z'));
    expect(today).toBe('2026-09-07');
    expect(previousUtcDay(today)).toBe('2026-09-06');
  });
});

describe('achievements and ranks', () => {
  it('unlocks once and pays the ACH table’s XP', async () => {
    const first = await h.deps.ledger.unlock('SOL', W, 'crate');
    expect(first).toMatchObject({ unlocked: true, xp: achOf('crate')?.xp });

    const again = await h.deps.ledger.unlock('SOL', W, 'crate');
    expect(again).toMatchObject({ unlocked: false, xp: 0 });
    expect((await h.deps.ledger.readBalance('SOL', W)).xp).toBe(achOf('crate')?.xp);
  });

  it('reports a rank-up and publishes it', async () => {
    // RANKS rows are `[name, xpRequired]` tuples.
    const target = RANKS[1]?.[1] ?? 250;
    expect(target).toBe(250);
    // The cap is 500/day, so climb across days.
    let banked = 0;
    let day = 6;
    while (banked < target) {
      h.setNow(Date.parse(`2026-09-${String(day).padStart(2, '0')}T12:00:00.000Z`));
      const sig = `sig-rank-${day}`;
      await verifyEvent(sig);
      const result = await h.deps.ledger.award({
        net: 'SOL',
        wallet: W,
        reason: 'trade',
        baseXp: 500,
        txSig: sig,
      });
      banked = result.totalXp;
      if (result.rankedUp) {
        expect(rankOf(result.totalXp).i).toBeGreaterThan(result.rankBefore);
        break;
      }
      day++;
      if (day > 20) break;
    }
    expect(rankOf(banked).i).toBeGreaterThan(0);
    expect(h.userEvents.some((e) => e.event.type === 'rank_up')).toBe(true);
  });

  it('releases the claim when the award is refused', async () => {
    // `first` is a chain-verified achievement, so unlocking it without a
    // signature must fail *and* leave nothing behind.
    await expect(h.deps.ledger.unlock('SOL', W, 'first')).rejects.toThrow(UnverifiedEventError);
    expect(await h.deps.ledger.unlockedKeys('SOL', W)).not.toContain('first');

    // The retry, now with a verified event, succeeds and pays.
    await verifyEvent('sig-retry');
    const retry = await h.deps.ledger.unlock('SOL', W, 'first', 'sig-retry');
    expect(retry).toMatchObject({ unlocked: true, xp: achOf('first')?.xp });
  });

  it('lists every achievement with its unlock state', async () => {
    await verifyEvent('sig-list');
    await h.deps.ledger.unlock('SOL', W, 'first', 'sig-list');
    const list = await h.deps.ledger.achievementList('SOL', W);
    expect(list).toHaveLength(10);
    expect(list.find((a) => a.key === 'first')?.unlockedAt).toBeTypeOf('number');
    expect(list.find((a) => a.key === 'whale')?.unlockedAt).toBeNull();
  });
});

describe('native notional weighting', () => {
  it('weights trade XP on native amount, never on USD', async () => {
    // Same USD value, wildly different native amounts: 1 ETH ~ 19.6 SOL at the
    // frozen prices, and the award must follow the native figure.
    expect(xpForTrade(1)).toBe(40);
    expect(xpForTrade(19.6)).toBe(784);
    // The floor keeps a tiny (but non-dust) fill worth something.
    expect(xpForTrade(0.02)).toBe(5);
  });

  it('gives a dust fill zero without unlocking anything', async () => {
    await verifyEvent('sig-dust');
    const outcome = await h.deps.awards.trade({
      net: 'SOL',
      wallet: W,
      sym: 'TEST',
      txSig: 'sig-dust',
      side: 'buy',
      nativeNotional: 0.004,
    });
    expect(outcome).toMatchObject({ xp: 0, sp: 0, dust: true, unlocked: [] });
    expect(await h.deps.ledger.unlockedKeys('SOL', W)).not.toContain('first');
  });

  it('unlocks first and whale above the cut, on a buy only', async () => {
    await verifyEvent('sig-sell-big');
    const sell = await h.deps.awards.trade({
      net: 'SOL',
      wallet: W,
      sym: 'TEST',
      txSig: 'sig-sell-big',
      side: 'sell',
      nativeNotional: 50,
    });
    // index.html:1973 gates whale on `buy && sol >= 5`.
    expect(sell.unlocked).toEqual(['first']);

    await verifyEvent('sig-buy-big');
    const buy = await h.deps.awards.trade({
      net: 'SOL',
      wallet: W,
      sym: 'TEST',
      txSig: 'sig-buy-big',
      side: 'buy',
      nativeNotional: 6,
    });
    expect(buy.unlocked).toEqual(['whale']);
  });
});
