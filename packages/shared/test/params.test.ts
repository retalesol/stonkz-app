import { describe, expect, it } from 'vitest';
import {
  CB_MS,
  CB_START_FEE,
  GRAD,
  MAX_CURVE_FEE_PCT,
  MIN_CURVE_FEE_PCT,
} from '../src/constants.js';
import {
  BPS,
  DEFAULT_CURVE_PARAMS,
  DEFAULT_PARAMS_WORD,
  cbStartFeePct,
  cbWindowMs,
  curveStartMc,
  feeBoundsPct,
  feeSplitOf,
  packParamsWord,
  paramsFromWord,
  unpackParamsWord,
  validateCurveParams,
  withDefaultParams,
  type CurveParams,
  type ParamsWordFields,
} from '../src/params.js';
import { FEE_SPLIT } from '../src/fees.js';

describe('DEFAULT_CURVE_PARAMS — GOLDEN', () => {
  it('pins the contract defaults', () => {
    expect(DEFAULT_CURVE_PARAMS).toEqual({
      feeProtocolBps: 1500,
      feeOpsBps: 1000,
      feeBurnBps: 600,
      minFeeBps: 100,
      maxFeeBps: 500,
      cbStartFeeBps: 5000,
      cbWindowSecs: 300,
      gradUsd: 69_000,
      maxSupply: 1e12,
      maxBuyNative: '0',
    });
    expect(Object.isFrozen(DEFAULT_CURVE_PARAMS)).toBe(true);
  });

  it('is what the legacy constants are derived from', () => {
    expect(GRAD).toBe(DEFAULT_CURVE_PARAMS.gradUsd);
    expect(CB_MS).toBe(DEFAULT_CURVE_PARAMS.cbWindowSecs * 1000);
    expect(CB_START_FEE).toBe(DEFAULT_CURVE_PARAMS.cbStartFeeBps / 100);
    expect(MIN_CURVE_FEE_PCT).toBe(1);
    expect(MAX_CURVE_FEE_PCT).toBe(5);
    expect(feeSplitOf()).toEqual({ ...FEE_SPLIT });
  });
});

describe('derived views', () => {
  const custom: CurveParams = {
    ...DEFAULT_CURVE_PARAMS,
    feeProtocolBps: 2000,
    feeOpsBps: 500,
    feeBurnBps: 500,
    minFeeBps: 50,
    maxFeeBps: 300,
    cbStartFeeBps: 3000,
    cbWindowSecs: 120,
    gradUsd: 100_000,
  };

  it('splits by bps with the creator bucket as the remainder', () => {
    expect(feeSplitOf(custom)).toEqual({
      creatorBucket: 0.7,
      protocol: 0.2,
      buyback: 0.05,
      rwa: 0.05,
    });
    // A split that uses every bp leaves the creator nothing, never a negative share.
    expect(
      feeSplitOf({ ...custom, feeProtocolBps: 5000, feeOpsBps: 3000, feeBurnBps: 2000 })
        .creatorBucket,
    ).toBe(0);
  });

  it('converts the window, start fee, bounds and start cap', () => {
    expect(cbWindowMs(custom)).toBe(120_000);
    expect(cbStartFeePct(custom)).toBe(30);
    expect(feeBoundsPct(custom)).toEqual({ min: 0.5, max: 3 });
    expect(curveStartMc(custom)).toBe(6250);
    expect(cbWindowMs()).toBe(CB_MS);
    expect(cbStartFeePct()).toBe(CB_START_FEE);
    expect(feeBoundsPct()).toEqual({ min: 1, max: 5 });
    expect(curveStartMc()).toBe(GRAD / 16);
  });

  it('fills a partial record from the defaults', () => {
    expect(withDefaultParams({ gradUsd: 42 })).toEqual({ ...DEFAULT_CURVE_PARAMS, gradUsd: 42 });
    expect(withDefaultParams(null)).toEqual(DEFAULT_CURVE_PARAMS);
    expect(withDefaultParams(undefined)).toEqual(DEFAULT_CURVE_PARAMS);
  });
});

describe('validateCurveParams — the contract rules', () => {
  it('accepts the defaults and a valid custom record', () => {
    expect(validateCurveParams(DEFAULT_CURVE_PARAMS)).toEqual([]);
    expect(
      validateCurveParams({
        ...DEFAULT_CURVE_PARAMS,
        feeProtocolBps: 4000,
        feeOpsBps: 3000,
        feeBurnBps: 3000,
        minFeeBps: 0,
        maxFeeBps: 10_000,
        cbStartFeeBps: 10_000,
        cbWindowSecs: 1,
        gradUsd: 1,
        maxSupply: 1,
        maxBuyNative: '123',
      }),
    ).toEqual([]);
  });

  it('refuses a split over 100%', () => {
    const errs = validateCurveParams({
      ...DEFAULT_CURVE_PARAMS,
      feeProtocolBps: 5000,
      feeOpsBps: 3000,
      feeBurnBps: 2001,
    });
    expect(errs).toEqual(['protocol + ops + burn must be at most 10000 bps']);
  });

  it('enforces min <= max <= cbStart <= 10000', () => {
    expect(validateCurveParams({ ...DEFAULT_CURVE_PARAMS, minFeeBps: 600 })).toContain(
      'minFeeBps must be at most maxFeeBps',
    );
    expect(validateCurveParams({ ...DEFAULT_CURVE_PARAMS, maxFeeBps: 6000 })).toContain(
      'maxFeeBps must be at most cbStartFeeBps',
    );
    expect(validateCurveParams({ ...DEFAULT_CURVE_PARAMS, cbStartFeeBps: BPS + 1 })).toContain(
      `cbStartFeeBps must be an integer between 0 and ${BPS}`,
    );
    expect(validateCurveParams({ ...DEFAULT_CURVE_PARAMS, feeOpsBps: 1.5 })).toContain(
      `feeOpsBps must be an integer between 0 and ${BPS}`,
    );
  });

  it('enforces window > 0, grad > 0, maxSupply in (0, 1e12] and a decimal maxBuyNative', () => {
    expect(validateCurveParams({ ...DEFAULT_CURVE_PARAMS, cbWindowSecs: 0 })).toEqual([
      'cbWindowSecs must be a positive integer (uint32)',
    ]);
    expect(validateCurveParams({ ...DEFAULT_CURVE_PARAMS, cbWindowSecs: 2 ** 32 })).toEqual([
      'cbWindowSecs must be a positive integer (uint32)',
    ]);
    expect(validateCurveParams({ ...DEFAULT_CURVE_PARAMS, gradUsd: 0 })).toEqual([
      'gradUsd must be positive',
    ]);
    expect(validateCurveParams({ ...DEFAULT_CURVE_PARAMS, maxSupply: 0 })).toEqual([
      'maxSupply must be in (0, 1e12]',
    ]);
    expect(validateCurveParams({ ...DEFAULT_CURVE_PARAMS, maxSupply: 1e12 + 1 })).toEqual([
      'maxSupply must be in (0, 1e12]',
    ]);
    expect(validateCurveParams({ ...DEFAULT_CURVE_PARAMS, maxBuyNative: '1.5' })).toEqual([
      'maxBuyNative must be a decimal integer string',
    ]);
    expect(validateCurveParams({ ...DEFAULT_CURVE_PARAMS, maxBuyNative: '-1' })).toEqual([
      'maxBuyNative must be a decimal integer string',
    ]);
  });

  it('reports every violation at once', () => {
    const errs = validateCurveParams({
      ...DEFAULT_CURVE_PARAMS,
      feeProtocolBps: 9000,
      feeOpsBps: 9000,
      cbWindowSecs: -1,
      gradUsd: Number.NaN,
    });
    expect(errs.length).toBe(3);
  });
});

describe('packParamsWord / unpackParamsWord — the launchpad uint256', () => {
  it('packs the defaults into the documented bit layout', () => {
    const w = packParamsWord(DEFAULT_CURVE_PARAMS);
    expect(w).toBe(DEFAULT_PARAMS_WORD);
    expect(Number(w & 0xffffn)).toBe(1500);
    expect(Number((w >> 16n) & 0xffffn)).toBe(1000);
    expect(Number((w >> 32n) & 0xffffn)).toBe(600);
    expect(Number((w >> 48n) & 0xffffn)).toBe(100);
    expect(Number((w >> 64n) & 0xffffn)).toBe(500);
    expect(Number((w >> 80n) & 0xffffn)).toBe(5000);
    expect(Number((w >> 96n) & 0xffffffffn)).toBe(300);
    expect((w >> 128n) & ((1n << 64n) - 1n)).toBe(69_000_000_000n);
    expect(w >> 192n).toBe(1_000_000_000_000n);
    // Nothing above bit 255 and nothing lost: the word is exactly the sum of its fields.
    expect(w >> 256n).toBe(0n);
  });

  it('round-trips an arbitrary record', () => {
    const p: ParamsWordFields = {
      feeProtocolBps: 1,
      feeOpsBps: 65_535,
      feeBurnBps: 7,
      minFeeBps: 50,
      maxFeeBps: 300,
      cbStartFeeBps: 2500,
      cbWindowSecs: 4_294_967_295,
      gradUsd: 123_456.789,
      maxSupply: 5e8,
    };
    const back = unpackParamsWord(packParamsWord(p));
    expect(back).toEqual({ ...p, gradUsd: 123_456.789 });
    expect(unpackParamsWord(DEFAULT_PARAMS_WORD)).toEqual({
      feeProtocolBps: 1500,
      feeOpsBps: 1000,
      feeBurnBps: 600,
      minFeeBps: 100,
      maxFeeBps: 500,
      cbStartFeeBps: 5000,
      cbWindowSecs: 300,
      gradUsd: 69_000,
      maxSupply: 1e12,
    });
  });

  it('refuses a field that does not fit', () => {
    expect(() => packParamsWord({ ...DEFAULT_CURVE_PARAMS, feeOpsBps: 65_536 })).toThrow(
      RangeError,
    );
    expect(() => packParamsWord({ ...DEFAULT_CURVE_PARAMS, cbWindowSecs: -1 })).toThrow(RangeError);
    expect(() => packParamsWord({ ...DEFAULT_CURVE_PARAMS, cbWindowSecs: 2 ** 32 })).toThrow(
      RangeError,
    );
    expect(() => packParamsWord({ ...DEFAULT_CURVE_PARAMS, gradUsd: Number.NaN })).toThrow(
      RangeError,
    );
    expect(() => packParamsWord({ ...DEFAULT_CURVE_PARAMS, maxSupply: 2 ** 64 })).toThrow(
      RangeError,
    );
    expect(() => unpackParamsWord(-1n)).toThrow(RangeError);
    expect(() => unpackParamsWord(1n << 256n)).toThrow(RangeError);
  });

  it('reads a zero word as the contract defaults', () => {
    const { maxBuyNative: _omit, ...defaults } = DEFAULT_CURVE_PARAMS;
    expect(paramsFromWord(0n)).toEqual(defaults);
    expect(paramsFromWord(DEFAULT_PARAMS_WORD)).toEqual(defaults);
    expect(paramsFromWord(packParamsWord({ ...defaults, gradUsd: 42 })).gradUsd).toBe(42);
    expect(unpackParamsWord(0n).feeProtocolBps).toBe(0);
  });

  it('validateCurveParams also wants a positive maxFeeBps', () => {
    expect(validateCurveParams({ ...DEFAULT_CURVE_PARAMS, minFeeBps: 0, maxFeeBps: 0 })).toEqual([
      'maxFeeBps must be positive',
    ]);
  });
});
