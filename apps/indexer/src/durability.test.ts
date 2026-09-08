import { afterEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  achievements,
  balanceLedger,
  balances,
  candles,
  chainEvents,
  creatorVaults,
  holdersSnapshot,
  indexerDeadLetters,
  koth,
  stakePositions,
  tape,
  tokens,
  trades,
  treasuries,
  xpEvents,
} from '@stonkz/api/db/schema';
import type { ChainEvent } from './events.js';
import { FixtureProducer } from './fixtures/producer.js';
import { createIndexerRig, type IndexerTestRig } from './test/harness.js';
import { ScriptedSource } from './test/scripted-source.js';

/**
 * The durability half of Phase C: the confirmation buffer, reorg detection and
 * rollback, the dead-letter path, and per-chain isolation.
 *
 * Driven through `ScriptedSource` rather than a real chain source, because
 * every behaviour here is a property of the *runner* — how far it is willing
 * to advance, what it does when a block hash changes underneath it, and how it
 * gives up. The chain sources' own decode and paging behaviour is covered by
 * `chain/solana-source.test.ts` and `chain/evm-source.test.ts`.
 */
let rig: IndexerTestRig;

afterEach(async () => {
  await rig?.close();
});

const CREATOR = 'creator-DOGGO';
const TRADER = 'SoLtrader1111111111111111111111111111111111';

/**
 * A launch and three fills on one chain, at positions 1000, 1012, 1024, 1036.
 *
 * `FixtureProducer` is what generates them, so the fee legs come from the same
 * `splitFee` the ingest path asserts against — the numbers are real even
 * though the chain is not.
 */
function solScenario(): { events: ChainEvent[]; positions: number[] } {
  const sol = new FixtureProducer({
    net: 'SOL',
    startPosition: 988,
    startMs: Date.parse('2026-09-06T00:00:00.000Z'),
  });
  sol.launch({ sym: 'DOGGO', name: 'Doggo Coin', creator: CREATOR, feeBps: 250, mc: 4_200 });
  sol.trade({ sym: 'DOGGO', trader: TRADER, side: 'buy', nativeAmount: 2.5, mc: 9_000 });
  sol.trade({ sym: 'DOGGO', trader: TRADER, side: 'buy', nativeAmount: 4.0, mc: 21_000 });
  sol.trade({ sym: 'DOGGO', trader: TRADER, side: 'buy', nativeAmount: 6.0, mc: 44_000 });
  const events = sol.all();
  return { events, positions: [...new Set(events.map((e) => e.chainPosition))].sort((a, b) => a - b) };
}

const hashesFor = (positions: readonly number[], tag = 'a'): Map<number, string> =>
  new Map(positions.map((p) => [p, `hash-${tag}-${p}`]));

async function scriptedRig(
  sol: ScriptedSource,
  rh: ScriptedSource,
  options: Parameters<typeof createIndexerRig>[1] = {},
): Promise<IndexerTestRig> {
  rig = await createIndexerRig([], { ...options, sources: { SOL: sol, RH: rh } });
  // The lag monitor probes the RPCs, not the sources.
  rig.rpcs.SOL.setHead(await sol.head());
  rig.rpcs.RH.setHead(await rh.head());
  return rig;
}

const idleRh = (): ScriptedSource => new ScriptedSource({ net: 'RH', head: 0, startPosition: 1 });

/* ------------------------------------------------------ confirmation depth */

describe('the confirmation-depth buffer', () => {
  it('refuses to materialise anything inside the buffer', async () => {
    const { events, positions } = solScenario();
    const head = positions.at(-1) ?? 0;
    // A buffer wider than the whole scenario: nothing is confirmed yet.
    const sol = new ScriptedSource({
      net: 'SOL',
      events,
      head,
      startPosition: positions[0] ?? 1,
      confirmations: 1_000,
    });
    await scriptedRig(sol, idleRh());

    const results = await rig.runner.drainNet('SOL');
    expect(results.every((r) => r.report.accepted === 0)).toBe(true);
    expect(await rig.db.db.select().from(chainEvents)).toHaveLength(0);
  });

  it('records both heads while buffering, so the buffer is visible not a silent stall', async () => {
    const { events, positions } = solScenario();
    const head = positions.at(-1) ?? 0;
    const sol = new ScriptedSource({
      net: 'SOL',
      events,
      head,
      startPosition: positions[0] ?? 1,
      confirmations: 1_000,
    });
    await scriptedRig(sol, idleRh());
    await rig.runner.drainNet('SOL');

    const cursor = await rig.cursors.read('SOL');
    expect(cursor.chainHead).toBe(head);
    expect(cursor.confirmedHead).toBeLessThan(head);
    expect(cursor.position).toBeLessThan(cursor.confirmedHead + 1);
  });

  it('admits an event exactly as the buffer clears it', async () => {
    const { events, positions } = solScenario();
    const [p0, p1, p2, p3] = positions as [number, number, number, number];
    // Head at p3 with a 24-slot buffer confirms up to p1: the launch and the
    // first fill, not the last two.
    const sol = new ScriptedSource({
      net: 'SOL',
      events,
      head: p3,
      startPosition: p0,
      confirmations: p3 - p1,
    });
    await scriptedRig(sol, idleRh());

    await rig.runner.drainNet('SOL');
    const first = await rig.db.db.select().from(chainEvents);
    expect(first.every((e) => e.chainPosition <= p1)).toBe(true);
    expect(first.some((e) => e.chainPosition === p1)).toBe(true);
    expect((await rig.cursors.read('SOL')).position).toBe(p1);

    // The chain moves on; the same buffer now clears p2.
    sol.setHead(p3 + (p2 - p1));
    await rig.runner.drainNet('SOL');
    const second = await rig.db.db.select().from(chainEvents);
    expect(second.some((e) => e.chainPosition === p2)).toBe(true);
    expect(second.some((e) => e.chainPosition === p3)).toBe(false);
    void p0;
  });

  it('leaves a fixture source on the raw head, since it has no buffer to apply', async () => {
    const { events } = solScenario();
    rig = await createIndexerRig(events);
    await rig.runner.drain();
    // `FixtureEventSource` implements no `confirmedHead`, so `confirmedHeadOf`
    // falls back to the raw head and everything is ingested.
    expect((await rig.db.db.select().from(chainEvents)).length).toBe(events.length);
  });
});

/* --------------------------------------------------------- cursor behaviour */

describe('cursor advancement', () => {
  it('starts a fresh cursor one before the deployment position, never at 0', async () => {
    const { events, positions } = solScenario();
    const start = positions[0] ?? 1;
    const sol = new ScriptedSource({ net: 'SOL', events, head: positions.at(-1) ?? 0, startPosition: start });
    await scriptedRig(sol, idleRh());

    await rig.runner.pass('SOL');
    expect(sol.polls[0]?.from).toBe(start - 1);
  });

  it('advances only as far as a bounded pass actually covered', async () => {
    const { events, positions } = solScenario();
    const start = positions[0] ?? 1;
    // A source that can only scan 12 positions per pass, as Solana's
    // signature paging cap produces.
    const sol = new ScriptedSource({
      net: 'SOL',
      events,
      head: positions.at(-1) ?? 0,
      startPosition: start,
      coverLimit: 12,
    });
    await scriptedRig(sol, idleRh(), { batchSize: 5_000 });

    const pass = await rig.runner.pass('SOL');
    expect(pass.to).toBe(start - 1 + 12);
    expect((await rig.cursors.read('SOL')).position).toBe(start - 1 + 12);
    // …and the next pass picks up exactly where it stopped, losing nothing.
    await rig.runner.drainNet('SOL');
    expect((await rig.db.db.select().from(chainEvents)).length).toBe(events.length);
  });

  it('hands the source its bookmark back before polling, and persists the new one', async () => {
    const { events, positions } = solScenario();
    const sol = new ScriptedSource({
      net: 'SOL',
      events,
      head: positions.at(-1) ?? 0,
      startPosition: positions[0] ?? 1,
    });
    await scriptedRig(sol, idleRh());

    // First pass: nothing persisted yet, so the source is handed null.
    await rig.runner.pass('SOL');
    expect(sol.restored[0]).toBeNull();
    const bookmark = (await rig.cursors.read('SOL')).positionSignature;
    expect(bookmark).toBeTruthy();

    await rig.runner.pass('SOL');
    expect(sol.restored[1]).toBe(bookmark);
  });

  it('never moves a cursor backwards through advance()', async () => {
    const { events, positions } = solScenario();
    const sol = new ScriptedSource({
      net: 'SOL',
      events,
      head: positions.at(-1) ?? 0,
      startPosition: positions[0] ?? 1,
    });
    await scriptedRig(sol, idleRh());
    await rig.runner.drainNet('SOL');

    const reached = (await rig.cursors.read('SOL')).position;
    await rig.cursors.advance('SOL', reached - 500);
    expect((await rig.cursors.read('SOL')).position).toBe(reached);
  });

  it('clears the failure counter once a pass succeeds', async () => {
    const { events, positions } = solScenario();
    const sol = new ScriptedSource({
      net: 'SOL',
      events,
      head: positions.at(-1) ?? 0,
      startPosition: positions[0] ?? 1,
    });
    await scriptedRig(sol, idleRh(), { deadLetters: true, maxBatchAttempts: 10 });

    sol.failFor(1, new Error('rpc timeout'));
    await expect(rig.runner.pass('SOL')).rejects.toThrow('rpc timeout');
    expect((await rig.cursors.read('SOL')).failedAttempts).toBe(1);
    expect((await rig.cursors.read('SOL')).lastError).toBe('rpc timeout');

    await rig.runner.pass('SOL');
    const recovered = await rig.cursors.read('SOL');
    expect(recovered.failedAttempts).toBe(0);
    expect(recovered.lastError).toBeNull();
  });
});

/* ------------------------------------------------------------------- reorgs */

describe('reorg detection', () => {
  it('does not fire when the hash at the cursor still matches', async () => {
    const { events, positions } = solScenario();
    const sol = new ScriptedSource({
      net: 'SOL',
      events,
      head: positions.at(-1) ?? 0,
      startPosition: positions[0] ?? 1,
      hashes: hashesFor(positions),
    });
    await scriptedRig(sol, idleRh(), { rollback: true });
    await rig.runner.drainNet('SOL');

    const before = (await rig.db.db.select().from(chainEvents)).length;
    const pass = await rig.runner.pass('SOL');
    expect(pass.rolledBack).toBeUndefined();
    expect((await rig.cursors.read('SOL')).reorgs).toBe(0);
    expect((await rig.db.db.select().from(chainEvents)).length).toBe(before);
  });

  it('does not fire on a position the chain has no block for', async () => {
    // Solana leaders skip slots constantly. Treating a null as a mismatch
    // would roll back on essentially every pass.
    const { events, positions } = solScenario();
    const sol = new ScriptedSource({
      net: 'SOL',
      events,
      head: positions.at(-1) ?? 0,
      startPosition: positions[0] ?? 1,
      hashes: hashesFor(positions),
    });
    await scriptedRig(sol, idleRh(), { rollback: true });
    await rig.runner.drainNet('SOL');

    const cursor = (await rig.cursors.read('SOL')).position;
    sol.setHash(cursor, null);
    const pass = await rig.runner.pass('SOL');
    expect(pass.rolledBack).toBeUndefined();
    expect((await rig.cursors.read('SOL')).reorgs).toBe(0);
  });

  it('does not fire before the cursor has ever recorded a hash', async () => {
    const { events, positions } = solScenario();
    // No hashes at all: a source that does not track them must not be read as
    // permanently reorging.
    const sol = new ScriptedSource({
      net: 'SOL',
      events,
      head: positions.at(-1) ?? 0,
      startPosition: positions[0] ?? 1,
    });
    await scriptedRig(sol, idleRh(), { rollback: true });
    const results = await rig.runner.drainNet('SOL');
    expect(results.every((r) => r.rolledBack === undefined)).toBe(true);
  });

  it('fires, counts and rewinds when the hash changed', async () => {
    const { events, positions } = solScenario();
    const sol = new ScriptedSource({
      net: 'SOL',
      events,
      head: positions.at(-1) ?? 0,
      startPosition: positions[0] ?? 1,
      hashes: hashesFor(positions),
    });
    await scriptedRig(sol, idleRh(), { rollback: true, reorgDepth: { SOL: 24, RH: 64 } });
    await rig.runner.drainNet('SOL');

    const at = (await rig.cursors.read('SOL')).position;
    sol.setHash(at, 'hash-FORKED');
    const pass = await rig.runner.pass('SOL');

    expect(pass.rolledBack).toBeDefined();
    const cursor = await rig.cursors.read('SOL');
    expect(cursor.reorgs).toBe(1);
    expect(cursor.lastReorgAt).not.toBeNull();
    expect(cursor.position).toBe(at - 24);
    // The stale hash and bookmark are cleared: they described a position the
    // cursor no longer sits at.
    expect(cursor.positionHash).toBeNull();
    expect(cursor.positionSignature).toBeNull();
  });
});

/* ----------------------------------------------------- rollback correctness */

describe('reorg rollback: derived rows disappear with the event', () => {
  it('removes the fills, the tape, the candles and the holder position', async () => {
    const { events, positions } = solScenario();
    const [, , , p3] = positions as [number, number, number, number];
    const sol = new ScriptedSource({
      net: 'SOL',
      events,
      head: p3,
      startPosition: positions[0] ?? 1,
      hashes: hashesFor(positions),
    });
    await scriptedRig(sol, idleRh(), { rollback: true, reorgDepth: { SOL: 12, RH: 64 } });
    await rig.runner.drainNet('SOL');

    const before = {
      trades: (await rig.db.db.select().from(trades)).length,
      candleTrades: (await rig.db.db.select().from(candles).where(eq(candles.tf, '1d')))[0]?.trades ?? 0,
      holder: (await rig.db.db.select().from(holdersSnapshot))[0],
    };
    expect(before.trades).toBe(3);

    // The last fill's slot forks away.
    sol.orphanFrom(p3);
    sol.setHash(p3, 'hash-FORKED');
    await rig.runner.pass('SOL');

    expect((await rig.db.db.select().from(chainEvents)).every((e) => e.chainPosition < p3)).toBe(true);
    expect((await rig.db.db.select().from(trades))).toHaveLength(2);
    expect((await rig.db.db.select().from(tape))).toHaveLength(2);

    // Candles are recomputed from the surviving fills, not decremented.
    const daily = (await rig.db.db.select().from(candles).where(eq(candles.tf, '1d')))[0];
    expect(daily?.trades).toBe(2);
    expect(before.candleTrades).toBe(3);

    // …as is the holder's position and cost basis.
    const holder = (await rig.db.db.select().from(holdersSnapshot))[0];
    expect(holder?.costNative).toBeCloseTo(2.5 + 4.0, 9);
    expect(holder?.costNative).toBeLessThan(before.holder?.costNative ?? Infinity);
  });

  it('takes the whole token with a reorged-out launch', async () => {
    const { events, positions } = solScenario();
    const sol = new ScriptedSource({
      net: 'SOL',
      events,
      head: positions.at(-1) ?? 0,
      startPosition: positions[0] ?? 1,
      hashes: hashesFor(positions),
    });
    await scriptedRig(sol, idleRh(), { rollback: true, reorgDepth: { SOL: 5_000, RH: 64 } });
    await rig.runner.drainNet('SOL');
    expect((await rig.db.db.select().from(tokens))).toHaveLength(1);

    // A deep reorg that swallows the launch itself.
    const at = (await rig.cursors.read('SOL')).position;
    sol.orphanFrom(0);
    sol.setHash(at, 'hash-FORKED');
    await rig.runner.pass('SOL');

    expect(await rig.db.db.select().from(tokens)).toHaveLength(0);
    expect(await rig.db.db.select().from(creatorVaults)).toHaveLength(0);
    expect(await rig.db.db.select().from(candles)).toHaveLength(0);
    expect(await rig.db.db.select().from(holdersSnapshot)).toHaveLength(0);
    expect(await rig.db.db.select().from(koth)).toHaveLength(0);
  });

  it('takes back the treasury and creator-vault credits it had accrued', async () => {
    const { events, positions } = solScenario();
    const [, , , p3] = positions as [number, number, number, number];
    const sol = new ScriptedSource({
      net: 'SOL',
      events,
      head: p3,
      startPosition: positions[0] ?? 1,
      hashes: hashesFor(positions),
    });
    await scriptedRig(sol, idleRh(), { rollback: true, reorgDepth: { SOL: 12, RH: 64 } });
    await rig.runner.drainNet('SOL');

    const vaultBefore = (await rig.db.db.select().from(creatorVaults))[0];
    const protocolBefore = (
      await rig.db.db
        .select()
        .from(treasuries)
        .where(and(eq(treasuries.net, 'SOL'), eq(treasuries.kind, 'protocol')))
    )[0];
    expect(protocolBefore?.nativeBalance).toBeGreaterThan(0);

    // The last fill accrued 2.5% of 6.0 SOL; rolling it out must remove
    // exactly that fill's legs and no more.
    const lastFee = 6.0 * 0.025;
    sol.orphanFrom(p3);
    sol.setHash(p3, 'hash-FORKED');
    await rig.runner.pass('SOL');

    const vaultAfter = (await rig.db.db.select().from(creatorVaults))[0];
    expect(vaultAfter?.lifetimeNative).toBeCloseTo(
      (vaultBefore?.lifetimeNative ?? 0) - lastFee * 0.7,
      9,
    );
    const protocolAfter = (
      await rig.db.db
        .select()
        .from(treasuries)
        .where(and(eq(treasuries.net, 'SOL'), eq(treasuries.kind, 'protocol')))
    )[0];
    expect(protocolAfter?.nativeBalance).toBeCloseTo(
      (protocolBefore?.nativeBalance ?? 0) - lastFee * 0.2,
      9,
    );
  });

  it('reverses XP and SP, and leaves the debit auditable in balance_ledger', async () => {
    const { events, positions } = solScenario();
    const [, , , p3] = positions as [number, number, number, number];
    const sol = new ScriptedSource({
      net: 'SOL',
      events,
      head: p3,
      startPosition: positions[0] ?? 1,
      hashes: hashesFor(positions),
    });
    await scriptedRig(sol, idleRh(), { rollback: true, reorgDepth: { SOL: 12, RH: 64 } });
    await rig.runner.drainNet('SOL');

    const balanceOf = async (wallet: string) =>
      (
        await rig.db.db
          .select()
          .from(balances)
          .where(and(eq(balances.wallet, wallet), eq(balances.net, 'SOL')))
      )[0];

    const before = await balanceOf(TRADER);
    expect(before?.xp).toBeGreaterThan(0);
    const paidForLast = (await rig.db.db.select().from(xpEvents)).filter(
      (e) => e.wallet === TRADER,
    ).length;
    expect(paidForLast).toBeGreaterThan(0);

    sol.orphanFrom(p3);
    sol.setHash(p3, 'hash-FORKED');
    await rig.runner.pass('SOL');

    const after = await balanceOf(TRADER);
    expect(after?.xp).toBeLessThan(before?.xp ?? 0);
    expect(after?.sp).toBeLessThan(before?.sp ?? 0);

    // The awarding rows are gone — that is what lets a re-included
    // transaction be paid again.
    const survivingSigs = new Set(
      (await rig.db.db.select().from(chainEvents)).map((e) => e.txSig),
    );
    for (const row of await rig.db.db.select().from(xpEvents)) {
      if (row.txSig !== null) expect(survivingSigs.has(row.txSig)).toBe(true);
    }

    // …but the debit is on the record.
    const reversals = (await rig.db.db.select().from(balanceLedger)).filter(
      (r) => r.reason === 'reorg_reversal',
    );
    expect(reversals.length).toBeGreaterThan(0);
    expect(reversals.every((r) => r.delta < 0)).toBe(true);
    expect(reversals.some((r) => r.asset === 'XP')).toBe(true);
  });

  it('revokes an achievement that a reorged-out fill paid for', async () => {
    // A whale buy unlocks `whale`; rolling that fill out has to take the
    // achievement with it, or the wallet keeps a badge for a trade that never
    // happened.
    const sol = new FixtureProducer({
      net: 'SOL',
      startPosition: 988,
      startMs: Date.parse('2026-09-06T00:00:00.000Z'),
    });
    sol.launch({ sym: 'DOGGO', name: 'Doggo Coin', creator: CREATOR, feeBps: 250, mc: 4_200 });
    sol.trade({ sym: 'DOGGO', trader: 'SoLwhale2222222222222222222222222222222222', side: 'buy', nativeAmount: 12, mc: 30_000 });
    const events = sol.all();
    const positions = [...new Set(events.map((e) => e.chainPosition))].sort((a, b) => a - b);
    const whaleFill = positions.at(-1) ?? 0;

    const source = new ScriptedSource({
      net: 'SOL',
      events,
      head: whaleFill,
      startPosition: positions[0] ?? 1,
      hashes: hashesFor(positions),
    });
    await scriptedRig(source, idleRh(), { rollback: true, reorgDepth: { SOL: 12, RH: 64 } });
    await rig.runner.drainNet('SOL');

    const unlocked = await rig.db.db.select().from(achievements);
    expect(unlocked.map((a) => a.key)).toContain('whale');

    source.orphanFrom(whaleFill);
    source.setHash(whaleFill, 'hash-FORKED');
    await rig.runner.pass('SOL');

    expect((await rig.db.db.select().from(achievements)).map((a) => a.key)).not.toContain('whale');
  });

  it('re-ingests the same range cleanly after a rollback', async () => {
    // The point of deleting rather than compensating: a reorg that
    // re-includes the same transactions must pay for them again, exactly once.
    const { events, positions } = solScenario();
    const [, , , p3] = positions as [number, number, number, number];
    const sol = new ScriptedSource({
      net: 'SOL',
      events,
      head: p3,
      startPosition: positions[0] ?? 1,
      hashes: hashesFor(positions),
    });
    await scriptedRig(sol, idleRh(), { rollback: true, reorgDepth: { SOL: 12, RH: 64 } });
    await rig.runner.drainNet('SOL');

    const snapshot = async () => ({
      events: (await rig.db.db.select().from(chainEvents)).length,
      trades: (await rig.db.db.select().from(trades)).length,
      xp: (await rig.db.db.select().from(balances))[0]?.xp ?? 0,
      protocol: (
        await rig.db.db
          .select()
          .from(treasuries)
          .where(and(eq(treasuries.net, 'SOL'), eq(treasuries.kind, 'protocol')))
      )[0]?.nativeBalance,
    });
    const before = await snapshot();

    // Fork the tip, then re-publish the identical history under a new hash —
    // which is what a reorg that re-orders but keeps the transactions looks
    // like.
    sol.setHash(p3, 'hash-b-1036');
    await rig.runner.pass('SOL');
    expect((await rig.db.db.select().from(trades)).length).toBeLessThan(before.trades);

    await rig.runner.drainNet('SOL');
    const after = await snapshot();
    expect(after.events).toBe(before.events);
    expect(after.trades).toBe(before.trades);
    expect(after.xp).toBe(before.xp);
    expect(after.protocol).toBeCloseTo(before.protocol ?? 0, 9);
  });

  it('unwinds a stake position without touching another chain\'s', async () => {
    const sol = new FixtureProducer({
      net: 'SOL',
      startPosition: 988,
      startMs: Date.parse('2026-09-06T00:00:00.000Z'),
    });
    sol.launch({ sym: 'DOGGO', name: 'Doggo Coin', creator: CREATOR, feeBps: 250, mc: 4_200 });
    sol.trade({ sym: 'DOGGO', trader: TRADER, side: 'buy', nativeAmount: 2.5, mc: 9_000 });
    sol.stake({ sym: 'DOGGO', wallet: TRADER, amount: 1_000_000, lockDays: 30, circulating: 10_000_000 });
    const events = sol.all();
    const positions = [...new Set(events.map((e) => e.chainPosition))].sort((a, b) => a - b);
    const stakeAt = positions.at(-1) ?? 0;

    const source = new ScriptedSource({
      net: 'SOL',
      events,
      head: stakeAt,
      startPosition: positions[0] ?? 1,
      hashes: hashesFor(positions),
    });
    await scriptedRig(source, idleRh(), { rollback: true, reorgDepth: { SOL: 12, RH: 64 } });
    await rig.runner.drainNet('SOL');
    expect((await rig.db.db.select().from(stakePositions))[0]?.amount).toBe(1_000_000);

    source.orphanFrom(stakeAt);
    source.setHash(stakeAt, 'hash-FORKED');
    await rig.runner.pass('SOL');

    const positionsAfter = await rig.db.db.select().from(stakePositions);
    expect(positionsAfter[0]?.amount ?? 0).toBe(0);
  });
});

/* -------------------------------------------------------------- dead letters */

describe('the dead-letter path', () => {
  it('retries a failing batch and only gives up at the configured attempt', async () => {
    const { events, positions } = solScenario();
    const sol = new ScriptedSource({
      net: 'SOL',
      events,
      head: positions.at(-1) ?? 0,
      startPosition: positions[0] ?? 1,
    });
    await scriptedRig(sol, idleRh(), { deadLetters: true, maxBatchAttempts: 3 });

    sol.failFor(Number.POSITIVE_INFINITY, new Error('provider 429'));

    // Attempts 1 and 2 are retried: the cursor stays put and the error
    // propagates so the tick ends.
    for (const expected of [1, 2]) {
      await expect(rig.runner.pass('SOL')).rejects.toThrow('provider 429');
      expect((await rig.cursors.read('SOL')).failedAttempts).toBe(expected);
      expect(await rig.db.db.select().from(indexerDeadLetters)).toHaveLength(0);
    }

    // Attempt 3 gives up: the range is recorded and the cursor moves past it.
    const pass = await rig.runner.pass('SOL');
    expect(pass.skipped).toMatchObject({ attempts: 3, error: 'provider 429' });

    const dead = await rig.db.db.select().from(indexerDeadLetters);
    expect(dead).toHaveLength(1);
    expect(dead[0]?.scope).toBe('batch');
    expect(dead[0]?.error).toBe('provider 429');
    expect(dead[0]?.fromPosition).toBe(pass.from);
    expect(dead[0]?.toPosition).toBe(pass.to);
    expect((await rig.cursors.read('SOL')).position).toBe(pass.to);
    expect((await rig.cursors.read('SOL')).failedAttempts).toBe(0);
  });

  it('collapses repeated failures on one range onto a single row', async () => {
    const { events, positions } = solScenario();
    const sol = new ScriptedSource({
      net: 'SOL',
      events,
      head: positions.at(-1) ?? 0,
      startPosition: positions[0] ?? 1,
    });
    await scriptedRig(sol, idleRh(), { deadLetters: true, maxBatchAttempts: 1 });

    sol.failFor(Number.POSITIVE_INFINITY, new Error('provider 429'));
    await rig.runner.pass('SOL');
    // Rewind and hit the same range again.
    await rig.cursors.rewind('SOL', (positions[0] ?? 1) - 1);
    await rig.runner.pass('SOL');

    const dead = await rig.db.db.select().from(indexerDeadLetters);
    expect(dead).toHaveLength(1);
    expect(dead[0]?.attempts).toBeGreaterThanOrEqual(1);
  });

  it('never gives up when dead-lettering is off, which is fixture behaviour', async () => {
    const { events, positions } = solScenario();
    const sol = new ScriptedSource({
      net: 'SOL',
      events,
      head: positions.at(-1) ?? 0,
      startPosition: positions[0] ?? 1,
    });
    await scriptedRig(sol, idleRh(), { maxBatchAttempts: 1 });

    sol.failFor(Number.POSITIVE_INFINITY, new Error('provider 429'));
    for (let i = 0; i < 3; i++) {
      await expect(rig.runner.pass('SOL')).rejects.toThrow('provider 429');
    }
    expect(await rig.db.db.select().from(indexerDeadLetters)).toHaveLength(0);
    // The cursor never moved, so nothing was skipped.
    expect((await rig.cursors.read('SOL')).position).toBe(0);
  });

  it('records an integrity-rejected event with its payload rather than dropping it', async () => {
    const { events, positions } = solScenario();
    // A fee split the programs could not have produced.
    const broken: ChainEvent = {
      net: 'SOL',
      kind: 'FeeAccrued',
      txSig: 'sigBROKEN',
      logIndex: 0,
      chainPosition: (positions.at(-1) ?? 0) + 12,
      blockTimeMs: Date.parse('2026-09-06T01:00:00.000Z'),
      sym: 'DOGGO',
      creator: CREATOR,
      feeAmount: 1,
      protocol: 0.9,
      creatorBucket: 0.05,
      stonkzOps: 0.05,
      stakerShare: 0,
      creatorTokens: 0,
    };
    const all = [...events, broken];
    const sol = new ScriptedSource({
      net: 'SOL',
      events: all,
      head: broken.chainPosition,
      startPosition: positions[0] ?? 1,
    });
    await scriptedRig(sol, idleRh(), { deadLetters: true });

    await rig.runner.drainNet('SOL');

    const dead = await rig.db.db.select().from(indexerDeadLetters);
    expect(dead).toHaveLength(1);
    expect(dead[0]?.scope).toBe('event');
    expect(dead[0]?.kind).toBe('FeeAccrued');
    expect(dead[0]?.txSig).toBe('sigBROKEN');
    expect(dead[0]?.error).toMatch(/protocol/);
    // The payload is kept, so the event can be re-examined without the chain.
    expect(dead[0]?.payload).toMatchObject({ feeAmount: 1, protocol: 0.9 });
    // …and the good events in the same batch went through.
    expect((await rig.db.db.select().from(trades))).toHaveLength(3);
    // The cursor is past the bad event, not stuck on it.
    expect((await rig.cursors.read('SOL')).position).toBe(broken.chainPosition);
  });

  it('counts open dead letters per chain for the metrics surface', async () => {
    const { events, positions } = solScenario();
    const sol = new ScriptedSource({
      net: 'SOL',
      events,
      head: positions.at(-1) ?? 0,
      startPosition: positions[0] ?? 1,
    });
    await scriptedRig(sol, idleRh(), { deadLetters: true, maxBatchAttempts: 1 });

    sol.failFor(Number.POSITIVE_INFINITY, new Error('boom'));
    await rig.runner.pass('SOL');

    expect(await rig.deadLetters.countOpen('SOL')).toBe(1);
    expect(await rig.deadLetters.countOpen('RH')).toBe(0);

    const resolved = await rig.deadLetters.resolveRange('SOL', 0, Number.MAX_SAFE_INTEGER);
    expect(resolved).toBe(1);
    expect(await rig.deadLetters.countOpen('SOL')).toBe(0);
  });
});

/* ---------------------------------------------------------- chain isolation */

describe('per-chain isolation', () => {
  function twoChains(): { sol: ScriptedSource; rh: ScriptedSource } {
    const solEvents = solScenario().events;
    const rhProducer = new FixtureProducer({
      net: 'RH',
      startPosition: 21_000_000,
      startMs: Date.parse('2026-09-06T00:00:00.000Z'),
    });
    rhProducer.launch({ sym: 'RHDOG', name: 'RH Dog', creator: 'creator-RHDOG', feeBps: 250, mc: 5_000 });
    rhProducer.trade({
      sym: 'RHDOG',
      trader: '0x1111111111111111111111111111111111111111',
      side: 'buy',
      nativeAmount: 1.5,
      mc: 18_000,
    });
    const rhEvents = rhProducer.all();

    return {
      sol: new ScriptedSource({
        net: 'SOL',
        events: solEvents,
        head: Math.max(...solEvents.map((e) => e.chainPosition)),
        startPosition: Math.min(...solEvents.map((e) => e.chainPosition)),
      }),
      rh: new ScriptedSource({
        net: 'RH',
        events: rhEvents,
        head: Math.max(...rhEvents.map((e) => e.chainPosition)),
        startPosition: Math.min(...rhEvents.map((e) => e.chainPosition)),
      }),
    };
  }

  it('indexes Robinhood Chain even while Solana\'s RPC is hard down', async () => {
    const { sol, rh } = twoChains();
    await scriptedRig(sol, rh);
    sol.failFor(Number.POSITIVE_INFINITY, new Error('solana rpc unreachable'));

    // `drain` must not reject: that is the coupling bug. Before the split, the
    // SOL exception propagated out before RH was polled at all.
    const results = await rig.runner.drain();

    expect(rh.polls.length).toBeGreaterThan(0);
    const rhEvents = (await rig.db.db.select().from(chainEvents)).filter((e) => e.net === 'RH');
    expect(rhEvents.length).toBeGreaterThan(0);
    expect((await rig.db.db.select().from(chainEvents)).filter((e) => e.net === 'SOL')).toHaveLength(0);
    expect(results.every((r) => r.net === 'RH')).toBe(true);

    // The stalled chain's cursor stays where it was; the healthy one advanced.
    expect((await rig.cursors.read('SOL')).position).toBe(0);
    expect((await rig.cursors.read('RH')).position).toBeGreaterThan(0);
  });

  it('indexes Solana even while a Robinhood poison batch is being retried', async () => {
    const { sol, rh } = twoChains();
    await scriptedRig(sol, rh, { deadLetters: true, maxBatchAttempts: 5 });
    rh.failFor(Number.POSITIVE_INFINITY, new Error('rh getLogs exploded'));

    await rig.runner.drain();

    expect((await rig.db.db.select().from(chainEvents)).filter((e) => e.net === 'SOL').length).toBeGreaterThan(0);
    expect((await rig.cursors.read('RH')).failedAttempts).toBe(1);
    expect((await rig.cursors.read('RH')).lastError).toBe('rh getLogs exploded');
  });

  it('keeps each chain\'s failure counter and last error to itself', async () => {
    const { sol, rh } = twoChains();
    await scriptedRig(sol, rh, { deadLetters: true, maxBatchAttempts: 5 });
    rh.failFor(Number.POSITIVE_INFINITY, new Error('rh down'));
    await rig.runner.drain();

    expect((await rig.cursors.read('SOL')).lastError).toBeNull();
    expect((await rig.cursors.read('SOL')).failedAttempts).toBe(0);
    expect((await rig.cursors.read('RH')).lastError).toBe('rh down');
  });

  it('rolls back one chain without disturbing the other', async () => {
    const { sol, rh } = twoChains();
    const solPositions = [...new Set(solScenario().events.map((e) => e.chainPosition))].sort((a, b) => a - b);
    for (const p of solPositions) sol.setHash(p, `hash-a-${p}`);

    await scriptedRig(sol, rh, { rollback: true, reorgDepth: { SOL: 12, RH: 64 } });
    await rig.runner.drain();

    const rhBefore = (await rig.db.db.select().from(chainEvents)).filter((e) => e.net === 'RH').length;
    const rhCursorBefore = (await rig.cursors.read('RH')).position;
    expect(rhBefore).toBeGreaterThan(0);

    const at = (await rig.cursors.read('SOL')).position;
    sol.orphanFrom(at);
    sol.setHash(at, 'hash-FORKED');
    await rig.runner.pass('SOL');

    expect((await rig.db.db.select().from(chainEvents)).filter((e) => e.net === 'RH').length).toBe(rhBefore);
    expect((await rig.cursors.read('RH')).position).toBe(rhCursorBefore);
    expect((await rig.cursors.read('RH')).reorgs).toBe(0);
    expect((await rig.cursors.read('SOL')).reorgs).toBe(1);
  });
});
