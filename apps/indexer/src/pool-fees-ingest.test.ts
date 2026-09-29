import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { creatorVaults, treasuries } from '@stonkz/api/db/schema';
import { splitFee } from '@stonkz/shared';
import { createIndexerRig, type IndexerTestRig } from './test/harness.js';
import type { FeeAccruedEvent } from './events.js';

/**
 * A post-graduation pool-fee claim through the `Ingestor`. Unlike a cashback
 * fill, whose token slices *replace* the native ones, a `FeeLocker` claim
 * carries base fees (with a native staker peel) and token fees at the same
 * time — the vault must book both, and the treasuries must be credited the
 * base legs exactly as they are for a curve fill, so `/fees` totals include
 * post-bond fees.
 */

const MINT = '0x847eb6311333f8F7F2cd0E9A89379214302aB2c9';
const CREATOR = '0x1FA9D4Ad76D53FbF1274d10ACBA12463ae90Bdca';

let rig: IndexerTestRig;

beforeAll(async () => {
  rig = await createIndexerRig();
});
afterAll(async () => {
  await rig.close();
});
beforeEach(async () => {
  await rig.db.reset();
});

function poolClaim(position: number, over: Partial<FeeAccruedEvent> = {}): FeeAccruedEvent {
  const feeAmount = 0.02;
  const legs = splitFee(feeAmount);
  return {
    net: 'BASE',
    kind: 'FeeAccrued',
    txSig: `0x${position.toString(16).padStart(64, '0')}`,
    logIndex: 3,
    chainPosition: position,
    blockTimeMs: 1_790_000_000_000 + position,
    mint: MINT,
    sym: 'MEMEMAN',
    creator: CREATOR,
    feeAmount,
    protocol: legs.protocol,
    creatorBucket: legs.creatorBucket,
    stonkzOps: legs.buyback,
    burn: legs.rwa,
    stakerShare: legs.creatorBucket / 4,
    creatorTokens: 200,
    stakerTokens: 100,
    postGraduation: true,
    ...over,
  };
}

async function vault() {
  const [row] = await rig.db.db
    .select()
    .from(creatorVaults)
    .where(and(eq(creatorVaults.net, 'BASE'), eq(creatorVaults.mint, MINT)));
  return row;
}

async function treasury(kind: 'protocol' | 'buyback' | 'rwa') {
  const [row] = await rig.db.db
    .select()
    .from(treasuries)
    .where(and(eq(treasuries.net, 'BASE'), eq(treasuries.kind, kind)));
  return row;
}

describe('post-graduation FeeAccrued → creator_vaults + treasuries', () => {
  it('books native and token fees at once, peel included', async () => {
    const legs = splitFee(0.02);
    const report = await rig.ingestor.apply([poolClaim(500)]);
    expect(report.accepted).toBe(1);
    const v = await vault();
    expect(v?.unclaimedNative).toBeCloseTo(legs.creatorBucket * 0.75, 12);
    expect(v?.stakerPoolNative).toBeCloseTo(legs.creatorBucket / 4, 12);
    expect(v?.unclaimedTokens).toBe(200);
    expect(v?.stakerPoolTokens).toBe(100);
    expect(v?.lifetimeNative).toBeCloseTo(legs.creatorBucket, 12);
  });

  it('credits the treasuries the base legs, like any curve fill', async () => {
    const legs = splitFee(0.02);
    const before = {
      protocol: (await treasury('protocol'))?.nativeBalance ?? 0,
      buyback: (await treasury('buyback'))?.nativeBalance ?? 0,
      rwa: (await treasury('rwa'))?.nativeBalance ?? 0,
    };
    await rig.ingestor.apply([poolClaim(501)]);
    expect(((await treasury('protocol'))?.nativeBalance ?? 0) - before.protocol).toBeCloseTo(
      legs.protocol,
      12,
    );
    expect(((await treasury('buyback'))?.nativeBalance ?? 0) - before.buyback).toBeCloseTo(
      legs.buyback,
      12,
    );
    expect(((await treasury('rwa'))?.nativeBalance ?? 0) - before.rwa).toBeCloseTo(legs.rwa, 12);
  });

  it('still treats a converted cashback fill as tokens-only', async () => {
    await rig.ingestor.apply([
      poolClaim(502, { postGraduation: false, stakerShare: 0, creatorTokens: 7, stakerTokens: 3 }),
    ]);
    const v = await vault();
    expect(v?.unclaimedNative).toBe(0);
    expect(v?.unclaimedTokens).toBe(7);
    expect(v?.stakerPoolTokens).toBe(3);
  });
});
