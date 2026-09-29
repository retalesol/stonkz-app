import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { SP_LEVELS, levelGrantTotals } from '@stonkz/shared';
import { crateInventory, spLevelClaims } from '../db/schema.js';
import { createTestApp, FROZEN_NOW, type TestApp } from '../test/app.js';
import { clearProgressionOverrides, setProgressionOverrides } from './tables.js';

let h: TestApp;
const W = 'LevelWallet11111111111111111111111111111111';

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
afterEach(() => clearProgressionOverrides());

async function inventoryOf(tier: string): Promise<number> {
  const [row] = await h.deps.db
    .select()
    .from(crateInventory)
    .where(
      and(
        eq(crateInventory.wallet, W),
        eq(crateInventory.net, 'SOL'),
        eq(crateInventory.tier, tier),
      ),
    );
  return row?.count ?? 0;
}

describe('SP level grants', () => {
  it('grants level 1 to a fresh wallet and nothing twice', async () => {
    const first = await h.deps.spLevels.sync('SOL', W, 0);
    expect(first.newlyClaimed).toEqual([1]);
    expect(first.granted).toEqual({ BRONZE: 2 });
    expect(first.claimed).toEqual([1]);

    const again = await h.deps.spLevels.sync('SOL', W, 0);
    expect(again.newlyClaimed).toEqual([]);
    expect(again.granted).toEqual({});
    expect(await inventoryOf('BRONZE')).toBe(2);
  });

  it('catches up every level crossed at once and publishes one level_up per level', async () => {
    const before = h.userEvents.length;
    const res = await h.deps.spLevels.sync('SOL', W, 3_500);
    expect(res.newlyClaimed).toEqual([1, 2, 3, 4, 5]);
    expect(res.level.level).toBe(5);
    // L1 2 + L2 2 + L3 1 = 5 BRONZE; L3 1 + L4 2 + L5 1 = 4 IRON; L5 1 SILVER.
    expect(res.granted).toEqual({ BRONZE: 5, IRON: 4, SILVER: 1 });
    expect(await inventoryOf('BRONZE')).toBe(5);
    expect(await inventoryOf('IRON')).toBe(4);
    const ups = h.userEvents.slice(before).filter((e) => e.event.type === 'level_up');
    expect(ups.map((e) => (e.event as { level: number }).level)).toEqual([1, 2, 3, 4, 5]);
    expect(ups[4]?.event).toMatchObject({
      level: 5,
      grants: { IRON: 1, SILVER: 1 },
      totalSp: 3_500,
    });
  });

  it('grants exactly once under concurrent syncs (double-click / parallel awards)', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => h.deps.spLevels.sync('SOL', W, 1_800)),
    );
    const claimedTotal = results.flatMap((r) => r.newlyClaimed);
    expect([...claimedTotal].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    // Inventory is the sum of the ladder through L4, not six times it.
    expect(await inventoryOf('BRONZE')).toBe(5);
    expect(await inventoryOf('IRON')).toBe(3);
    const claims = await h.deps.db
      .select()
      .from(spLevelClaims)
      .where(and(eq(spLevelClaims.wallet, W), eq(spLevelClaims.net, 'SOL')));
    expect(claims).toHaveLength(4);
  });

  it('fires automatically off an SP credit through the ledger hook', async () => {
    await h.deps.ledger.award({ net: 'SOL', wallet: W, reason: 'follow', baseXp: 250 });
    expect(await inventoryOf('BRONZE')).toBe(4); // L1 + L2
    const snap = await h.deps.spLevels.snapshot('SOL', W, 250);
    expect(snap.level.level).toBe(2);
    expect(snap.nextLevel?.level).toBe(3);
    expect(snap.levels.filter((l) => l.claimed).map((l) => l.level)).toEqual([1, 2]);
    expect(snap.levels).toHaveLength(SP_LEVELS.length);
  });

  it('keeps the whole ladder consistent: reached ⇒ claimed after a snapshot', async () => {
    const snap = await h.deps.spLevels.snapshot('SOL', W, 250_000);
    expect(snap.levels.every((l) => l.reached === l.claimed)).toBe(true);
    expect(snap.level.next).toBeNull();
    expect(snap.nextLevel).toBeNull();
    const totals = levelGrantTotals();
    expect(await inventoryOf('RHODIUM')).toBe(totals.RHODIUM ?? 0);
  });

  it('keeps nets separate for the same address', async () => {
    await h.deps.spLevels.sync('SOL', W, 750);
    const rh = await h.deps.spLevels.sync('RH', W, 0);
    expect(rh.newlyClaimed).toEqual([1]);
    expect(await inventoryOf('IRON')).toBe(1);
  });

  it('follows an operator level table injected through getLevelTable()', async () => {
    setProgressionOverrides({
      levels: [
        { level: 1, sp: 0, grants: { BRONZE: 1 } },
        { level: 2, sp: 100, grants: { GOLD: 1 } },
      ],
    });
    const res = await h.deps.spLevels.sync('SOL', W, 150);
    expect(res.newlyClaimed).toEqual([1, 2]);
    expect(res.granted).toEqual({ BRONZE: 1, GOLD: 1 });
    expect(res.level.level).toBe(2);
    expect(res.level.next).toBeNull();
    const snap = await h.deps.spLevels.snapshot('SOL', W, 150);
    expect(snap.levels).toHaveLength(2);
  });
});
