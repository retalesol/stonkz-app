import { describe, expect, it } from 'vitest';
import { splitFee as splitFeeAtoms } from '@stonkz/curve-sim';
import { assertFeeSplit, EventIntegrityError, type FeeAccruedEvent } from '../events.js';
import { assertOnChainFeeSplit, FeeSplitMismatchError, nativeFeeLegs } from './market.js';

/** 2.5% of 1.5 SOL, in lamports. */
const FEE = 37_500_000n;

/** The pre-upgrade 20 / 10 / 10 / 60 split, which the indexer no longer accepts. */
function splitFeeV1(fee: bigint) {
  const protocol = (fee * 2_000n) / 10_000n;
  const stonkzOps = (fee * 1_000n) / 10_000n;
  const burn = (fee * 1_000n) / 10_000n;
  return { protocol, stonkzOps, burn, creatorBucket: fee - protocol - stonkzOps - burn };
}

describe('assertOnChainFeeSplit', () => {
  it('accepts the v2 15/10/6/69 split and says so', () => {
    const v2 = splitFeeAtoms(FEE);
    expect(v2).toEqual({
      protocol: 5_625_000n,
      stonkzOps: 3_750_000n,
      burn: 2_250_000n,
      creatorBucket: 25_875_000n,
    });
    expect(
      assertOnChainFeeSplit('v2', FEE, v2.protocol, v2.stonkzOps, v2.burn, v2.creatorBucket),
    ).toBe('v2');
  });

  it('gives v2 floor dust to the bucket, exactly like the programs', () => {
    const odd = 12_345n;
    const v2 = splitFeeAtoms(odd);
    expect(v2.protocol + v2.stonkzOps + v2.burn + v2.creatorBucket).toBe(odd);
    expect(
      assertOnChainFeeSplit('dust', odd, v2.protocol, v2.stonkzOps, v2.burn, v2.creatorBucket),
    ).toBe('v2');
  });

  it('rejects the retired v1 20/10/10/60 split', () => {
    const v1 = splitFeeV1(FEE);
    expect(() =>
      assertOnChainFeeSplit('v1', FEE, v1.protocol, v1.stonkzOps, v1.burn, v1.creatorBucket),
    ).toThrow(FeeSplitMismatchError);
  });

  it('rejects legs that are off by an atom', () => {
    const v2 = splitFeeAtoms(FEE);
    expect(() =>
      assertOnChainFeeSplit(
        'bent',
        FEE,
        v2.protocol + 1n,
        v2.stonkzOps,
        v2.burn,
        v2.creatorBucket - 1n,
      ),
    ).toThrow(/not the integer 15\/69\/10\/6 split/);
    // Legs that sum to the fee but with the wrong burn leg are not a settlement either.
    expect(() =>
      assertOnChainFeeSplit(
        'mixed',
        FEE,
        v2.protocol,
        v2.stonkzOps,
        v2.burn + 1n,
        v2.creatorBucket - 1n,
      ),
    ).toThrow(FeeSplitMismatchError);
  });
});

describe('nativeFeeLegs + assertFeeSplit', () => {
  const event = (legs: ReturnType<typeof nativeFeeLegs>): FeeAccruedEvent => ({
    net: 'SOL',
    kind: 'FeeAccrued',
    txSig: 'sig',
    logIndex: 0,
    chainPosition: 1,
    blockTimeMs: 0,
    sym: 'DOGGO',
    creator: 'creator',
    creatorTokens: 0,
    ...legs,
  });

  it('rescales a v2 fill by the v2 ratios and passes the float check', () => {
    const legs = nativeFeeLegs(0.0375, 0n, 25_875_000n);
    expect(legs.protocol).toBeCloseTo(0.0375 * 0.15, 12);
    expect(legs.stonkzOps).toBeCloseTo(0.0375 * 0.1, 12);
    expect(legs.burn).toBeCloseTo(0.0375 * 0.06, 12);
    expect(legs.creatorBucket).toBeCloseTo(0.0375 * 0.69, 12);
    expect(legs.stakerShare).toBe(0);
    expect(() => assertFeeSplit(event(legs))).not.toThrow();
  });

  it('carries the staker peel across as the same fraction of the bucket, capped at half', () => {
    const quarter = nativeFeeLegs(0.0375, 25_875_000n / 4n, 25_875_000n);
    expect(quarter.stakerShare).toBeCloseTo(quarter.creatorBucket / 4, 12);
    const over = nativeFeeLegs(0.0375, 25_875_000n, 25_875_000n);
    expect(over.stakerShare).toBeCloseTo(over.creatorBucket / 2, 12);
    expect(() => assertFeeSplit(event(over))).not.toThrow();
  });

  it('rejects float legs on the retired v1 ratios', () => {
    const legs = nativeFeeLegs(0.0375, 0n, 22_500_000n);
    expect(() =>
      assertFeeSplit(
        event({
          ...legs,
          protocol: 0.0375 * 0.2,
          creatorBucket: 0.0375 * 0.6,
          stonkzOps: 0.0375 * 0.1,
          burn: 0.0375 * 0.1,
        }),
      ),
    ).toThrow(EventIntegrityError);
  });

  it('rejects float legs that match nothing', () => {
    const legs = nativeFeeLegs(1, 0n, 0n);
    expect(() =>
      assertFeeSplit(
        event({ ...legs, protocol: 0.9, creatorBucket: 0.04, stonkzOps: 0.03, burn: 0.03 }),
      ),
    ).toThrow(EventIntegrityError);
  });
});
