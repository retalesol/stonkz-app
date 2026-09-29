import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { creatorVaults, treasuries, treasuryCredits } from '@stonkz/api/db/schema';
import { splitFee } from '@stonkz/shared';
import { createIndexerRig, type IndexerTestRig } from './test/harness.js';
import type { FeeAccruedEvent } from './events.js';

/**
 * `FeeAccrued` through the `Ingestor`: the creator vault books only what is
 * claimable in each unit.
 *
 * Outside a cashback window the creator's share of the 69% bucket is native
 * and the staker peel is native. Inside one, the launchpad converts the whole
 * bucket into the token before splitting it, so both shares are tokens and
 * **no** native is claimable from that fill — the vault must not show base
 * the creator can never claim. The bucket's native value still counts toward
 * the lifetime total.
 */

const MEMEMAN = '0x847eb6311333f8F7F2cd0E9A89379214302aB2c9';
const CREATOR = '0x1FA9D4Ad76D53FbF1274d10ACBA12463ae90Bdca';

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

function fee(position: number, over: Partial<FeeAccruedEvent> = {}): FeeAccruedEvent {
  seq++;
  const feeAmount = 0.004;
  const legs = splitFee(feeAmount);
  return {
    net: 'BASE',
    kind: 'FeeAccrued',
    txSig: `0x${seq.toString(16).padStart(64, '0')}`,
    logIndex: 5,
    chainPosition: position,
    blockTimeMs: 1_790_000_000_000 + position,
    mint: MEMEMAN,
    sym: 'MEMEMAN',
    creator: CREATOR,
    feeAmount,
    protocol: legs.protocol,
    creatorBucket: legs.creatorBucket,
    stonkzOps: legs.buyback,
    burn: legs.rwa,
    stakerShare: 0,
    creatorTokens: 0,
    ...over,
  };
}

async function vault() {
  const [row] = await rig.db.db
    .select()
    .from(creatorVaults)
    .where(and(eq(creatorVaults.net, 'BASE'), eq(creatorVaults.mint, MEMEMAN)));
  return row;
}

describe('FeeAccrued → creator_vaults', () => {
  it('books a plain fill: creator native = bucket - staker peel', async () => {
    const legs = splitFee(0.004);
    const peel = legs.creatorBucket / 4;
    const report = await rig.ingestor.apply([fee(100, { stakerShare: peel })]);
    expect(report.accepted).toBe(1);
    const v = await vault();
    expect(v?.unclaimedNative).toBeCloseTo(legs.creatorBucket - peel, 12);
    expect(v?.unclaimedTokens).toBe(0);
    expect(v?.stakerPoolNative).toBeCloseTo(peel, 12);
    expect(v?.stakerPoolTokens).toBe(0);
    expect(v?.lifetimeNative).toBeCloseTo(legs.creatorBucket, 12);
  });

  it('books a converted cashback fill in tokens and credits no native', async () => {
    const legs = splitFee(0.004);
    await rig.ingestor.apply([
      fee(101, { stakerShare: 0, creatorTokens: 92_592, stakerTokens: 30_864 }),
    ]);
    const v = await vault();
    expect(v?.unclaimedNative).toBe(0);
    expect(v?.unclaimedTokens).toBe(92_592);
    expect(v?.stakerPoolNative).toBe(0);
    expect(v?.stakerPoolTokens).toBe(30_864);
    // The native value of the bucket still counts toward the lifetime figure.
    expect(v?.lifetimeNative).toBeCloseTo(legs.creatorBucket, 12);
  });

  it('accumulates both kinds of fill on one vault, unit by unit', async () => {
    const legs = splitFee(0.004);
    await rig.ingestor.apply([
      fee(102, { stakerShare: legs.creatorBucket / 2 }),
      fee(103, { creatorTokens: 10, stakerTokens: 5 }),
      fee(104),
    ]);
    const v = await vault();
    expect(v?.unclaimedNative).toBeCloseTo(legs.creatorBucket / 2 + legs.creatorBucket, 12);
    expect(v?.unclaimedTokens).toBe(10);
    expect(v?.stakerPoolNative).toBeCloseTo(legs.creatorBucket / 2, 12);
    expect(v?.stakerPoolTokens).toBe(5);
    expect(v?.lifetimeNative).toBeCloseTo(3 * legs.creatorBucket, 12);
  });

  it('credits the three treasuries with the exact legs, once per fill', async () => {
    const legs = splitFee(0.004);
    const e = fee(105);
    await rig.ingestor.apply([e]);
    // A replay of the same event is a duplicate: no second credit.
    await rig.ingestor.apply([e]);
    const rows = await rig.db.db
      .select()
      .from(treasuryCredits)
      .where(eq(treasuryCredits.txSig, e.txSig));
    expect(rows.map((r) => r.kind).sort()).toEqual(['buyback', 'protocol', 'rwa']);
    const by = (kind: string) => rows.find((r) => r.kind === kind)?.amount ?? -1;
    expect(by('protocol')).toBeCloseTo(legs.protocol, 12);
    expect(by('buyback')).toBeCloseTo(legs.buyback, 12);
    expect(by('rwa')).toBeCloseTo(legs.rwa, 12);
    const bal = await rig.db.db.select().from(treasuries).where(eq(treasuries.net, 'BASE'));
    const nat = (kind: string) => bal.find((r) => r.kind === kind)?.nativeBalance ?? -1;
    expect(nat('protocol')).toBeCloseTo(legs.protocol, 12);
    expect(nat('buyback')).toBeCloseTo(legs.buyback, 12);
    expect(nat('rwa')).toBeCloseTo(legs.rwa, 12);
  });
});
