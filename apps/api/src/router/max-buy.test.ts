import { describe, expect, it } from 'vitest';
import { DEFAULT_CURVE_PARAMS } from '@stonkz/shared';
import { MaxBuyExceededError } from './errors.js';
import { assertUnderMaxBuyNative, maxBuyNativeAtoms, maxBuyNativeWhole } from './max-buy.js';

const ONE_ETH = 10n ** 18n;

describe('maxBuyNative', () => {
  it('reads "0", garbage and negatives as uncapped', () => {
    expect(maxBuyNativeAtoms(DEFAULT_CURVE_PARAMS)).toBe(0n);
    expect(maxBuyNativeAtoms({ ...DEFAULT_CURVE_PARAMS, maxBuyNative: 'nope' })).toBe(0n);
    expect(maxBuyNativeAtoms({ ...DEFAULT_CURVE_PARAMS, maxBuyNative: '-5' })).toBe(0n);
    expect(maxBuyNativeWhole(DEFAULT_CURVE_PARAMS)).toBeNull();
    expect(
      maxBuyNativeWhole({ ...DEFAULT_CURVE_PARAMS, maxBuyNative: '2500000000000000000' }),
    ).toBe(2.5);
  });

  it('lets a buy through at or under the cap, and when uncapped', () => {
    const capped = { ...DEFAULT_CURVE_PARAMS, maxBuyNative: ONE_ETH.toString() };
    expect(() => assertUnderMaxBuyNative('RH', capped, ONE_ETH)).not.toThrow();
    expect(() => assertUnderMaxBuyNative('RH', capped, 1n)).not.toThrow();
    expect(() => assertUnderMaxBuyNative('RH', DEFAULT_CURVE_PARAMS, 10n ** 24n)).not.toThrow();
  });

  it('refuses over the cap with a 400 and a readable message', () => {
    const capped = { ...DEFAULT_CURVE_PARAMS, maxBuyNative: (ONE_ETH / 2n).toString() };
    let err: unknown;
    try {
      assertUnderMaxBuyNative('BASE', capped, ONE_ETH + ONE_ETH / 4n);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MaxBuyExceededError);
    const e = err as MaxBuyExceededError;
    expect(e.httpStatus).toBe(400);
    expect(e.toResponse()).toEqual({
      error: 'max_buy_exceeded',
      detail: 'BASE buys are capped at 0.5 ETH per transaction right now; this one is 1.25 ETH',
    });
  });
});
