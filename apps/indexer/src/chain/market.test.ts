import { describe, expect, it } from 'vitest';
import { splitFee as splitFeeAtoms } from '@stonkz/curve-sim';
import { assertFeeSplit, EventIntegrityError, type FeeAccruedEvent } from '../events.js';
import {
  assertOnChainFeeSplit,
  FeeSplitMismatchError,
  LEGACY_V1_SPLIT_BPS,
  nativeFeeLegs,
  splitFeeLegacyV1,
} from './market.js';

/** 2.5% of 1.5 SOL, in lamports. */
const FEE = 37_500_000n;

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

  it('accepts the legacy v1 20/10/10/60 split during the upgrade window', () => {
    const v1 = splitFeeLegacyV1(FEE);
    expect(LEGACY_V1_SPLIT_BPS).toMatchObject({ protocol: 2_000n, ops: 1_000n, burn: 1_000n });
    expect(v1).toEqual({
      protocol: 7_500_000n,
      stonkzOps: 3_750_000n,
      burn: 3_750_000n,
      creatorBucket: 22_500_000n,
    });
    expect(
      assertOnChainFeeSplit('v1', FEE, v1.protocol, v1.stonkzOps, v1.burn, v1.creatorBucket),
    ).toBe('v1');
  });

  it('gives v1 floor dust to the bucket, exactly like the programs', () => {
    const odd = 12_345n;
    const v1 = splitFeeLegacyV1(odd);
    expect(v1.protocol + v1.stonkzOps + v1.burn + v1.creatorBucket).toBe(odd);
    expect(
      assertOnChainFeeSplit('dust', odd, v1.protocol, v1.stonkzOps, v1.burn, v1.creatorBucket),
    ).toBe('v1');
  });

  it('rejects legs that match neither split', () => {
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
    ).toThrow(FeeSplitMismatchError);
    // A mix of the two (v2 protocol, v1 burn) is not a valid settlement either.
    const v1 = splitFeeLegacyV1(FEE);
    expect(() =>
      assertOnChainFeeSplit(
        'mixed',
        FEE,
        v2.protocol,
        v2.stonkzOps,
        v1.burn,
        FEE - v2.protocol - v2.stonkzOps - v1.burn,
      ),
    ).toThrow(/match neither/);
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
    expect(() => assertFeeSplit(event(legs))).not.toThrow();
  });

  it('rescales a v1 fill by the v1 ratios and passes the float check', () => {
    const legs = nativeFeeLegs(0.0375, 0n, 22_500_000n, 'v1');
    expect(legs.protocol).toBeCloseTo(0.0375 * 0.2, 12);
    expect(legs.burn).toBeCloseTo(0.0375 * 0.1, 12);
    expect(legs.creatorBucket).toBeCloseTo(0.0375 * 0.6, 12);
    expect(() => assertFeeSplit(event(legs))).not.toThrow();
  });

  it('rejects float legs that match neither split', () => {
    const legs = nativeFeeLegs(1, 0n, 0n);
    expect(() =>
      assertFeeSplit(
        event({ ...legs, protocol: 0.9, creatorBucket: 0.04, stonkzOps: 0.03, burn: 0.03 }),
      ),
    ).toThrow(EventIntegrityError);
  });
});
