import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { migrationsFolder } from '@stonkz/api/db/migrate';
import { createBaseMintRegistry } from '@stonkz/api/router/base-mints';
import { stakePositions, xpEvents } from '@stonkz/api/db/schema';
import type { Net } from '@stonkz/shared';
import { createIndexerRig, type IndexerTestRig } from './test/harness.js';
import type { ChainEvent, StakeClaimedEvent, StakedEvent, UnstakedEvent } from './events.js';
import { mapSolanaTransaction } from './chain/solana-map.js';
import { TokenRegistry } from './chain/registry.js';

/**
 * `Staked` / `Unstaked` / `StakeClaimed` through the `Ingestor`, on both
 * chains' event shapes.
 *
 * The load-bearing fact: `Staked.amount` is the position's **new total** on
 * both programs (`StonkzLaunchpad.stake` emits `p.amount`, Solana emits
 * `amount_after`), while `Unstaked.amount` is the amount withdrawn.
 */

const MEMEMAN = '0x847eb6311333f8F7F2cd0E9A89379214302aB2c9';
const OWNER = '0x1FA9D4Ad76D53FbF1274d10ACBA12463ae90Bdca';
const SOL_MINT = 'DoGGo1111111111111111111111111111111111111';
const SOL_OWNER = 'TRADERsoL11111111111111111111111111111111111';

let rig: IndexerTestRig;
let seq = 0;

beforeAll(async () => {
  rig = await createIndexerRig();
});
afterAll(async () => {
  await rig.close();
});
beforeEach(async () => {
  await rig.db.reset();
});

function sig(net: Net): string {
  seq++;
  return net === 'SOL' ? `stakeSig${seq}xxxxxxxx` : `0x${seq.toString(16).padStart(64, '0')}`;
}

function staked(
  net: Net,
  position: number,
  over: Partial<StakedEvent> = {},
  txSig: string = sig(net),
): StakedEvent {
  return {
    net,
    kind: 'Staked',
    txSig,
    logIndex: 0,
    chainPosition: position,
    blockTimeMs: 1_790_000_000_000 + position,
    mint: net === 'SOL' ? SOL_MINT : MEMEMAN,
    sym: 'MEMEMAN',
    wallet: net === 'SOL' ? SOL_OWNER : OWNER,
    amount: 6182,
    lockDays: 0,
    mult: 0,
    untilMs: 1_790_000_000_000,
    circulating: 100_000,
    ...over,
  };
}

function unstaked(net: Net, position: number, amount: number): UnstakedEvent {
  return {
    net,
    kind: 'Unstaked',
    txSig: sig(net),
    logIndex: 0,
    chainPosition: position,
    blockTimeMs: 1_790_000_000_000 + position,
    mint: net === 'SOL' ? SOL_MINT : MEMEMAN,
    sym: 'MEMEMAN',
    wallet: net === 'SOL' ? SOL_OWNER : OWNER,
    amount,
  };
}

function claimed(net: Net, position: number): StakeClaimedEvent {
  return {
    net,
    kind: 'StakeClaimed',
    txSig: sig(net),
    logIndex: 0,
    chainPosition: position,
    blockTimeMs: 1_790_000_000_000 + position,
    mint: net === 'SOL' ? SOL_MINT : MEMEMAN,
    sym: 'MEMEMAN',
    wallet: net === 'SOL' ? SOL_OWNER : OWNER,
    rewardNative: 0.01,
    rewardTokens: 0,
  };
}

async function position(net: Net) {
  const [row] = await rig.db.db
    .select()
    .from(stakePositions)
    .where(
      and(eq(stakePositions.net, net), eq(stakePositions.mint, net === 'SOL' ? SOL_MINT : MEMEMAN)),
    );
  return row;
}

async function apply(events: ChainEvent[]) {
  return rig.ingestor.apply(events);
}

describe.each<Net>(['BASE', 'SOL'])('stake ingest on %s', (net) => {
  it('records a first stake as the position (the MEMEMAN FLEX case)', async () => {
    const report = await apply([staked(net, 100)]);
    expect(report.accepted).toBe(1);
    const row = await position(net);
    expect(row?.amount).toBe(6182);
    expect(row?.lockDays).toBe(0);
    expect(row?.mult).toBe(0);
    expect(row?.wallet).toBe(net === 'SOL' ? SOL_OWNER : OWNER);
  });

  it('sets a top-up to the new total instead of adding it on top', async () => {
    await apply([staked(net, 100, { amount: 1000, lockDays: 30, mult: 1.5 })]);
    await apply([staked(net, 110, { amount: 1500, lockDays: 30, mult: 1.5 })]);
    expect((await position(net))?.amount).toBe(1500);
  });

  it('pays stake XP on the added amount only', async () => {
    await apply([staked(net, 100, { amount: 1000, lockDays: 30, mult: 1.5, circulating: 4000 })]);
    await apply([staked(net, 110, { amount: 1500, lockDays: 30, mult: 1.5, circulating: 4000 })]);
    const awards = await rig.db.db
      .select({ baseXp: xpEvents.amount })
      .from(xpEvents)
      .where(eq(xpEvents.reason, 'stake'));
    // xpForStake = round(amount / circulating * 400): 1000 -> 100, then the
    // 500 added -> 50. Scoring the top-up on its 1,500 total would pay 150.
    expect(awards.map((a) => a.baseXp).sort((x, y) => x - y)).toEqual([50, 100]);
  });

  it('is idempotent when the same batch is delivered twice', async () => {
    const batch = [
      staked(net, 100, { amount: 2000, lockDays: 7, mult: 1.25 }),
      unstaked(net, 120, 500),
    ];
    await apply(batch);
    const again = await apply(batch);
    expect(again.duplicates).toBe(2);
    expect((await position(net))?.amount).toBe(1500);
  });

  it('decrements on Unstaked and snaps float dust to zero', async () => {
    await apply([staked(net, 100, { amount: 0.3 })]);
    await apply([unstaked(net, 101, 0.1), unstaked(net, 102, 0.2)]);
    // 0.3 - 0.1 - 0.2 is 2.7e-17 in doubles, which would count as a staker.
    expect((await position(net))?.amount).toBe(0);
  });

  it('zeros claimable rewards on StakeClaimed and keeps the position', async () => {
    await apply([staked(net, 100, { amount: 800, lockDays: 30, mult: 1.5 })]);
    await rig.db.db.update(stakePositions).set({ rewardNative: 0.5, rewardTokens: 3 });
    await apply([claimed(net, 105)]);
    const row = await position(net);
    expect(row?.amount).toBe(800);
    expect(row?.rewardNative).toBe(0);
    expect(row?.rewardTokens).toBe(0);
  });

  it('rebuilds the position from surviving events when a top-up is reorged out', async () => {
    await apply([
      staked(net, 100, { amount: 1000, lockDays: 30, mult: 1.5 }),
      unstaked(net, 110, 200),
      staked(net, 120, { amount: 1300, lockDays: 30, mult: 1.5 }),
    ]);
    expect((await position(net))?.amount).toBe(1300);
    await rig.rollback.rollback(net, 120);
    // What the chain holds after block 110: 1000 staked, 200 withdrawn.
    expect((await position(net))?.amount).toBe(800);
    await rig.rollback.rollback(net, 100);
    expect((await position(net))?.amount).toBe(0);
  });
});

describe('Solana stake mapping', () => {
  it('maps amount_after as the total and FLEX as zero weight', async () => {
    const registry = new TokenRegistry(rig.db.db);
    registry.remember({
      net: 'SOL',
      mint: SOL_MINT,
      sym: 'MEMEMAN',
      creator: SOL_OWNER,
      baseMint: 'So11111111111111111111111111111111111111112',
      baseDecimals: 9,
      tokenDecimals: 6,
      basePrice1e6: 200_000_000n,
      supplyAtoms: 1_000_000_000_000_000n,
      tokensForSale: 800_000_000_000_000n,
      feeBps: 100,
      circulatingAtoms: 100_000_000_000n,
    });
    const events = await mapSolanaTransaction(
      [
        {
          kind: 'Staked',
          mint: SOL_MINT,
          owner: SOL_OWNER,
          amount: 6_182_000_000n,
          lockDays: 0,
          weight: 0n,
          lockUntil: 1_790_000_000n,
          eligibleStaked: 0n,
          totalWeight: 0n,
          ts: 1_790_000_000n,
        },
        {
          kind: 'Unstaked',
          mint: SOL_MINT,
          owner: SOL_OWNER,
          amount: 1_000_000n,
          eligibleStaked: 0n,
          totalWeight: 0n,
          ts: 1_790_000_001n,
        },
      ],
      {
        txSig: 'solMapSig',
        slot: 500,
        blockTimeMs: 1_790_000_000_000,
        registry,
        baseMints: createBaseMintRegistry(),
        nativeUsdPrice: 200,
      },
    );
    const stake = events.find((e) => e.kind === 'Staked');
    if (stake?.kind !== 'Staked') throw new Error('expected Staked');
    expect(stake.amount).toBe(6182);
    expect(stake.mult).toBe(0);
    expect(stake.circulating).toBe(100_000);
    const un = events.find((e) => e.kind === 'Unstaked');
    if (un?.kind !== 'Unstaked') throw new Error('expected Unstaked');
    expect(un.amount).toBe(1);
  });
});

describe('migration 0020 (stake position totals)', () => {
  it('rebuilds a row the old additive ingest double-counted', async () => {
    await apply([
      staked('BASE', 100, { amount: 1000, lockDays: 30, mult: 1.5 }),
      staked('BASE', 110, { amount: 1500, lockDays: 30, mult: 1.5 }),
      unstaked('BASE', 120, 200),
    ]);
    // What the additive ingest used to leave behind: 1000 + 1500 - 200.
    await rig.db.db.update(stakePositions).set({ amount: 2300 });
    const body = readFileSync(join(migrationsFolder(), '0020_stake_position_totals.sql'), 'utf8');
    await rig.db.db.execute(sql.raw(body));
    expect((await position('BASE'))?.amount).toBe(1300);
    // Idempotent.
    await rig.db.db.execute(sql.raw(body));
    expect((await position('BASE'))?.amount).toBe(1300);
  });
});
