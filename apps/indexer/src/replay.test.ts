import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { achOf, xpForFeeClaim, xpForTrade, type Net } from '@stonkz/shared';
import {
  achievements,
  balances,
  candles,
  chainEvents,
  creatorVaults,
  holdersSnapshot,
  koth,
  stakePositions,
  tape,
  tokens,
  trades,
  treasuries,
  xpEvents,
} from '@stonkz/api/db/schema';
import { canonicalScenario, type ScenarioResult } from './fixtures/producer.js';
import { createIndexerRig, type IndexerTestRig } from './test/harness.js';

let rig: IndexerTestRig;
let scenario: ScenarioResult;

beforeAll(async () => {
  scenario = canonicalScenario();
  rig = await createIndexerRig(scenario.events);
  await rig.runner.drain();
});
afterAll(async () => {
  await rig.close();
});

const xpOf = async (net: Net, wallet: string): Promise<number> => {
  const [row] = await rig.db.db
    .select()
    .from(balances)
    .where(and(eq(balances.wallet, wallet), eq(balances.net, net)))
    .limit(1);
  return row?.xp ?? 0;
};

/** Review gate 1.C — replay the fixtures, then check the read tables. */
describe('fixture replay: read path', () => {
  it('records every event exactly once and advances both cursors', async () => {
    const recorded = await rig.db.db.select().from(chainEvents);
    expect(recorded).toHaveLength(scenario.events.length);

    const cursors = await rig.cursors.readAll();
    expect(cursors.SOL.position).toBeGreaterThanOrEqual(scenario.heads.SOL);
    expect(cursors.RH.position).toBeGreaterThanOrEqual(scenario.heads.RH);
    // Independent rows: the two chains are nowhere near each other.
    expect(cursors.SOL.position).not.toBe(cursors.RH.position);
  });

  it('is idempotent — a full re-replay changes nothing', async () => {
    const before = {
      events: (await rig.db.db.select().from(chainEvents)).length,
      trades: (await rig.db.db.select().from(trades)).length,
      xpEvents: (await rig.db.db.select().from(xpEvents)).length,
      solXp: await xpOf('SOL', scenario.actors.solTrader),
      treasuries: await rig.db.db.select().from(treasuries),
    };

    await rig.cursors.rewind('SOL', 0);
    await rig.cursors.rewind('RH', 0);
    const results = await rig.runner.drain();

    const duplicates = results.reduce((n, r) => n + r.report.duplicates, 0);
    const accepted = results.reduce((n, r) => n + r.report.accepted, 0);
    expect(duplicates).toBe(scenario.events.length);
    expect(accepted).toBe(0);

    expect((await rig.db.db.select().from(chainEvents)).length).toBe(before.events);
    expect((await rig.db.db.select().from(trades)).length).toBe(before.trades);
    expect((await rig.db.db.select().from(xpEvents)).length).toBe(before.xpEvents);
    expect(await xpOf('SOL', scenario.actors.solTrader)).toBe(before.solXp);
    // A replay must not inflate a treasury.
    expect(await rig.db.db.select().from(treasuries)).toEqual(before.treasuries);
  });

  it('materialises tokens on both chains with the right lanes', async () => {
    const rows = await rig.db.db.select().from(tokens);
    const byKey = new Map(rows.map((r) => [`${r.net}:${r.sym}`, r]));

    expect([...byKey.keys()].sort()).toEqual(['RH:RHDOG', 'SOL:CASHY', 'SOL:DOGGO']);
    expect(byKey.get('SOL:DOGGO')?.lane).toBe('grad');
    expect(byKey.get('SOL:DOGGO')?.graduatedAt).not.toBeNull();
    // RHDOG reached $40,100 — past 55% of the $69K cap, so it sits in `soon`.
    expect(byKey.get('RH:RHDOG')?.lane).toBe('soon');
    expect(byKey.get('SOL:CASHY')?.cashback).toBe(false);
  });

  it('builds trades, tape and every candle timeframe', async () => {
    const tradeRows = await rig.db.db.select().from(trades);
    const tradeEvents = scenario.events.filter((e) => e.kind === 'Trade');
    expect(tradeRows).toHaveLength(tradeEvents.length);
    expect((await rig.db.db.select().from(tape))).toHaveLength(tradeEvents.length);

    const candleRows = await rig.db.db
      .select()
      .from(candles)
      .where(and(eq(candles.net, 'SOL'), eq(candles.sym, 'DOGGO')));
    expect(new Set(candleRows.map((c) => c.tf))).toEqual(
      new Set(['1m', '5m', '15m', '1h', '4h', '1d']),
    );
    // Every SOL:DOGGO fill lands in the same UTC day bucket.
    const daily = candleRows.filter((c) => c.tf === '1d');
    expect(daily).toHaveLength(1);
    expect(daily[0]?.trades).toBe(tradeEvents.filter((e) => e.kind === 'Trade' && e.sym === 'DOGGO').length);
    expect(daily[0]?.h).toBeGreaterThanOrEqual(daily[0]?.l ?? 0);
  });

  it('tracks holder positions and native cost basis through a sell', async () => {
    const [position] = await rig.db.db
      .select()
      .from(holdersSnapshot)
      .where(
        and(
          eq(holdersSnapshot.net, 'SOL'),
          eq(holdersSnapshot.sym, 'DOGGO'),
          eq(holdersSnapshot.wallet, scenario.actors.solTrader),
        ),
      )
      .limit(1);
    expect(position).toBeDefined();
    // Bought 1.5 SOL worth, then sold part of it: cost basis retired pro rata.
    expect(position?.costNative).toBeLessThan(1.5);
    expect(position?.costNative).toBeGreaterThan(0);
    expect(position?.tokenAmount).toBeGreaterThan(0);
  });

  it('crowns a king per net and re-crowns on a lane change', async () => {
    const crowns = await rig.db.db.select().from(koth);
    const byNet = new Map(crowns.map((k) => [k.net, k]));
    // DOGGO graduated, so the crown moved to the best non-grad token.
    expect(byNet.get('SOL')?.sym).toBe('CASHY');
    expect(byNet.get('RH')?.sym).toBe('RHDOG');
  });

  it('splits fees 20/70/10 into the treasuries and the creator vault', async () => {
    const feeEvents = scenario.events.filter((e) => e.kind === 'FeeAccrued');
    const expectSum = (net: Net, leg: 'protocol' | 'stonkzOps'): number =>
      feeEvents
        .filter((e) => e.net === net)
        .reduce((total, e) => total + (e.kind === 'FeeAccrued' ? e[leg] : 0), 0);

    const vaults = await rig.db.db.select().from(treasuries);
    const find = (net: Net, kind: string): number =>
      vaults.find((v) => v.net === net && v.kind === kind)?.nativeBalance ?? 0;

    expect(find('SOL', 'protocol')).toBeCloseTo(expectSum('SOL', 'protocol'), 9);
    // The standalone TreasuryCredit of 0.01 rides on top of the accruals.
    expect(find('SOL', 'stonkz_ops')).toBeCloseTo(expectSum('SOL', 'stonkzOps') + 0.01, 9);
    expect(find('RH', 'protocol')).toBeCloseTo(expectSum('RH', 'protocol'), 9);

    const [doggoVault] = await rig.db.db
      .select()
      .from(creatorVaults)
      .where(and(eq(creatorVaults.net, 'SOL'), eq(creatorVaults.sym, 'DOGGO')))
      .limit(1);
    // Claimed 0.42 SOL, so lifetime exceeds what is still unclaimed.
    expect(doggoVault?.claimedNative).toBeCloseTo(0.42, 9);
    expect(doggoVault?.lifetimeNative).toBeGreaterThan(0);
  });

  it('records the stake position', async () => {
    const [stake] = await rig.db.db
      .select()
      .from(stakePositions)
      .where(and(eq(stakePositions.net, 'SOL'), eq(stakePositions.sym, 'DOGGO')))
      .limit(1);
    expect(stake?.amount).toBe(40_000_000);
    expect(stake?.lockDays).toBe(30);
    expect(stake?.rewardNative).toBeCloseTo(0.05, 9);
  });

  it('publishes board, token, tape and user events', async () => {
    const channels = new Set(rig.published.map((p) => p.channel));
    expect(channels.has('board')).toBe(true);
    expect(channels.has('tape')).toBe(true);
    expect([...channels].some((c) => c.startsWith('token:'))).toBe(true);
    expect([...channels].some((c) => c.startsWith('user:'))).toBe(true);

    const types = new Set(rig.userEvents.map((e) => e.type));
    // The seven ceremonies the rewards UI listens for, minus the crate-only ones.
    expect(types.has('xp')).toBe(true);
    expect(types.has('sp')).toBe(true);
    expect(types.has('streak')).toBe(true);
    expect(types.has('achievement')).toBe(true);
    expect(types.has('rank_up')).toBe(true);
  });
});

/** Review gate 3.B — the ledger's own assertions over the same replay. */
describe('fixture replay: game ledger', () => {
  it('awards trade XP by native notional, using the shared formula', async () => {
    const rows = await rig.db.db
      .select()
      .from(xpEvents)
      .where(and(eq(xpEvents.net, 'SOL'), eq(xpEvents.wallet, scenario.actors.solWhale), eq(xpEvents.reason, 'trade')));

    const notionals = scenario.events
      .filter((e) => e.kind === 'Trade' && e.trader === scenario.actors.solWhale)
      .map((e) => (e.kind === 'Trade' ? e.nativeAmount : 0));
    expect(rows).toHaveLength(notionals.length);

    for (const notional of notionals) {
      const base = xpForTrade(notional);
      expect(rows.some((r) => r.baseAmount === base)).toBe(true);
    }
  });

  it('gives a dust trade zero XP, zero SP and no achievement', async () => {
    const [event] = await rig.db.db
      .select()
      .from(xpEvents)
      .where(and(eq(xpEvents.wallet, scenario.actors.solDust), eq(xpEvents.reason, 'trade')));

    // The event is still recorded, so a replay cannot revisit the decision.
    expect(event).toBeDefined();
    expect(event?.amount).toBe(0);
    expect((event?.meta as { cappedBy: string }).cappedBy).toBe('dust');

    expect(await xpOf('SOL', scenario.actors.solDust)).toBe(0);
    const unlocks = await rig.db.db
      .select()
      .from(achievements)
      .where(eq(achievements.wallet, scenario.actors.solDust));
    // Not even FIRST BLOOD — a 0.004 SOL fill is exactly the farm to block.
    // The same wallet was still holding DOGGO when it graduated, and does not
    // collect GRADUATE either: dust earns nothing anywhere.
    expect(unlocks).toHaveLength(0);
  });

  it('does award grad to a non-dust holder in the same graduation', async () => {
    const unlocks = await rig.db.db
      .select()
      .from(achievements)
      .where(and(eq(achievements.net, 'SOL'), eq(achievements.wallet, scenario.actors.solWhale)));
    expect(unlocks.map((a) => a.key)).toContain('grad');
  });

  it('unlocks whale only over that chain’s cut, on a buy', async () => {
    const solWhale = await rig.db.db
      .select()
      .from(achievements)
      .where(and(eq(achievements.net, 'SOL'), eq(achievements.wallet, scenario.actors.solWhale)));
    expect(solWhale.map((a) => a.key).sort()).toContain('whale');

    // 1.5 SOL is over the dust floor but under the 5 SOL cut.
    const solTrader = await rig.db.db
      .select()
      .from(achievements)
      .where(and(eq(achievements.net, 'SOL'), eq(achievements.wallet, scenario.actors.solTrader)));
    expect(solTrader.map((a) => a.key)).not.toContain('whale');

    // 2.5 ETH clears the 2 ETH cut.
    const rhWhale = await rig.db.db
      .select()
      .from(achievements)
      .where(and(eq(achievements.net, 'RH'), eq(achievements.wallet, scenario.actors.rhWhale)));
    expect(rhWhale.map((a) => a.key)).toContain('whale');
  });

  it('pays the achievement XP from the shared ACH table', async () => {
    const [row] = await rig.db.db
      .select()
      .from(xpEvents)
      .where(and(eq(xpEvents.wallet, scenario.actors.solWhale), eq(xpEvents.reason, 'ach:whale')))
      .limit(1);
    expect(row?.baseAmount).toBe(achOf('whale')?.xp);
  });

  it('awards launch, deploy and cashback to the creator', async () => {
    const reasons = (
      await rig.db.db
        .select()
        .from(xpEvents)
        .where(and(eq(xpEvents.net, 'SOL'), eq(xpEvents.wallet, scenario.actors.solCreator)))
    ).map((r) => r.reason);

    expect(reasons.filter((r) => r === 'launch')).toHaveLength(2);
    expect(reasons).toContain('ach:deploy');
    // CASHY launched with the window open.
    expect(reasons).toContain('ach:cashback');
    expect(reasons).toContain('fee_claim');
  });

  it('uses the shared fee-claim formula', async () => {
    const [row] = await rig.db.db
      .select()
      .from(xpEvents)
      .where(and(eq(xpEvents.wallet, scenario.actors.solCreator), eq(xpEvents.reason, 'fee_claim')))
      .limit(1);
    expect(row?.baseAmount).toBe(xpForFeeClaim(0.42));
  });

  it('unlocks grad for a holder at graduation', async () => {
    const unlocks = await rig.db.db
      .select()
      .from(achievements)
      .where(and(eq(achievements.net, 'SOL'), eq(achievements.wallet, scenario.actors.solWhale)));
    expect(unlocks.map((a) => a.key)).toContain('grad');
  });

  it('unlocks stake and pays the stake-claim flat award', async () => {
    const rows = await rig.db.db
      .select()
      .from(xpEvents)
      .where(and(eq(xpEvents.net, 'SOL'), eq(xpEvents.wallet, scenario.actors.solTrader)));
    const reasons = rows.map((r) => r.reason);
    expect(reasons).toContain('ach:stake');
    expect(reasons).toContain('stake');
    // index.html:3203 — a flat 12.
    expect(rows.find((r) => r.reason === 'stake_claim')?.baseAmount).toBe(12);
  });

  it('keeps balances equal to the sum of the append-only events', async () => {
    for (const wallet of Object.values(scenario.actors)) {
      for (const net of ['SOL', 'RH'] as const) {
        const events = await rig.db.db
          .select()
          .from(xpEvents)
          .where(and(eq(xpEvents.wallet, wallet), eq(xpEvents.net, net)));
        const summed = events.reduce((total, e) => total + e.amount, 0);
        expect(await xpOf(net, wallet)).toBe(summed);
      }
    }
  });

  it('never mixes balances across nets for the same wallet string', async () => {
    // rhTrader traded only on RH, so its SOL ledger must be empty.
    expect(await xpOf('SOL', scenario.actors.rhTrader)).toBe(0);
    expect(await xpOf('RH', scenario.actors.rhTrader)).toBeGreaterThan(0);
    expect(await xpOf('RH', scenario.actors.solTrader)).toBe(0);
  });

  it('mirrors SP 1:1 with XP', async () => {
    const [row] = await rig.db.db
      .select()
      .from(balances)
      .where(and(eq(balances.net, 'SOL'), eq(balances.wallet, scenario.actors.solWhale)))
      .limit(1);
    expect(row?.sp).toBe(row?.xp);
  });
});
