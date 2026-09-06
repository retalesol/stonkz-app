import { describe, expect, it } from 'vitest';
import { CB_MS, CB_START_FEE } from '../src/constants.js';
import {
  FEE_SPLIT,
  OPS_SPLIT,
  cbLeft,
  creatorVsStakers,
  effFee,
  feePie,
  inCashback,
  opsSplit,
  splitFee,
} from '../src/fees.js';

const T0 = 1_757_000_000_000;

describe('cbLeft', () => {
  it('is zero for a coin without a cashback window', () => {
    expect(cbLeft({ tfee: 2 }, T0)).toBe(0);
    expect(cbLeft({ cashback: false, cbStart: T0 }, T0)).toBe(0);
  });

  it('counts down across the five-minute window', () => {
    const c = { cashback: true, cbStart: T0 };
    expect(cbLeft(c, T0)).toBe(CB_MS);
    expect(cbLeft(c, T0 + 60_000)).toBe(240_000);
    expect(cbLeft(c, T0 + CB_MS)).toBe(0);
  });

  it('never goes negative once the window closes', () => {
    expect(cbLeft({ cashback: true, cbStart: T0 }, T0 + CB_MS + 999_999)).toBe(0);
  });

  it('treats a missing start time as long expired', () => {
    expect(cbLeft({ cashback: true }, T0)).toBe(0);
  });

  it('defaults to the current clock', () => {
    expect(cbLeft({ cashback: true, cbStart: Date.now() })).toBeGreaterThan(0);
  });
});

describe('inCashback', () => {
  it('is true only while time remains', () => {
    const c = { cashback: true, cbStart: T0 };
    expect(inCashback(c, T0)).toBe(true);
    expect(inCashback(c, T0 + CB_MS - 1)).toBe(true);
    expect(inCashback(c, T0 + CB_MS)).toBe(false);
  });

  it('is false when the coin never opted in', () => {
    expect(inCashback({ tfee: 3 }, T0)).toBe(false);
  });

  it('defaults to the current clock', () => {
    expect(inCashback({ cashback: true, cbStart: Date.now() })).toBe(true);
  });
});

describe('effFee', () => {
  it('is the creator fee outside a cashback window', () => {
    expect(effFee({ tfee: 2.5 }, T0)).toBe(2.5);
  });

  it('defaults to 1% when the coin sets no fee', () => {
    expect(effFee({}, T0)).toBe(1);
    expect(effFee({ tfee: 0 }, T0)).toBe(1);
  });

  it('decays linearly from 50% down to the creator fee', () => {
    const c = { tfee: 2, cashback: true, cbStart: T0 };
    expect(effFee(c, T0)).toBeCloseTo(CB_START_FEE, 9);
    expect(effFee(c, T0 + CB_MS / 2)).toBeCloseTo(2 + (50 - 2) * 0.5, 9);
    expect(effFee(c, T0 + CB_MS)).toBe(2);
  });

  it('defaults to the current clock', () => {
    expect(effFee({ tfee: 4 })).toBe(4);
  });
});

/* -------------------------------------------------------------------------- */
/* Golden: 20 / 70 / 10                                                        */
/* -------------------------------------------------------------------------- */

describe('splitFee — GOLDEN', () => {
  it('pins the three ratios', () => {
    expect(FEE_SPLIT).toEqual({ protocol: 0.2, creatorBucket: 0.7, stonkzOps: 0.1 });
    expect(FEE_SPLIT.protocol + FEE_SPLIT.creatorBucket + FEE_SPLIT.stonkzOps).toBeCloseTo(1, 12);
  });

  it('splits a unit fee into 0.20 / 0.70 / 0.10', () => {
    expect(splitFee(1)).toEqual({ protocol: 0.2, creatorBucket: 0.7, stonkzOps: 0.1 });
  });

  it('splits a 2% curve fee on a 1 SOL fill', () => {
    // 2.0% of 1 SOL = 0.02 SOL of fee.
    const s = splitFee(0.02);
    expect(s.protocol).toBeCloseTo(0.004, 12); // 0.40% of notional
    expect(s.stonkzOps).toBeCloseTo(0.002, 12); // 0.20% of notional
    expect(s.creatorBucket).toBeCloseTo(0.014, 12); // 1.40% of notional
  });

  it('conserves the fee', () => {
    for (const fee of [0, 1e-9, 0.0001, 1, 12.345, 1e6]) {
      const s = splitFee(fee);
      expect(s.protocol + s.creatorBucket + s.stonkzOps).toBeCloseTo(fee, 9);
    }
  });

  it('snapshots the split so drift fails CI', () => {
    expect(splitFee(100)).toMatchInlineSnapshot(`
      {
        "creatorBucket": 70,
        "protocol": 20,
        "stonkzOps": 10,
      }
    `);
  });
});

describe('creatorVsStakers — GOLDEN', () => {
  it('gives the creator everything when nothing is staked', () => {
    expect(creatorVsStakers(0.7, 0)).toEqual({ creator: 0.7, stakers: 0 });
  });

  it('splits the bucket in half when the coin is fully staked', () => {
    // poolFrac maxes out at 0.5 -> stakers take half of the 70% bucket.
    const r = creatorVsStakers(0.7, 0.5);
    expect(r.creator).toBeCloseTo(0.35, 12);
    expect(r.stakers).toBeCloseTo(0.35, 12);
  });

  it('never lets stakers exceed half the bucket, however large poolFrac is', () => {
    for (const f of [0.5, 0.75, 1, 10]) {
      const r = creatorVsStakers(1, f);
      expect(r.stakers).toBeLessThanOrEqual(0.5);
      expect(r.creator).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('clamps negative pool fractions to zero', () => {
    expect(creatorVsStakers(1, -0.3)).toEqual({ creator: 1, stakers: 0 });
  });

  it('scales linearly in between', () => {
    const r = creatorVsStakers(1, 0.25);
    expect(r.stakers).toBeCloseTo(0.25, 12);
    expect(r.creator).toBeCloseTo(0.75, 12);
  });

  it('conserves the bucket', () => {
    for (const f of [0, 0.1, 0.33, 0.5]) {
      const r = creatorVsStakers(1.4, f);
      expect(r.creator + r.stakers).toBeCloseTo(1.4, 12);
    }
  });
});

describe('opsSplit — GOLDEN', () => {
  it('pins the 50 / 25 / 25 recipe', () => {
    expect(OPS_SPLIT).toEqual({ burnBuy: 0.5, lpTokenBuy: 0.25, lpNative: 0.25 });
  });

  it('splits the accrued 10% for the Phase 7 sweep', () => {
    expect(opsSplit(1)).toEqual({ burnBuy: 0.5, lpTokenBuy: 0.25, lpNative: 0.25 });
    expect(opsSplit(0.002)).toEqual({ burnBuy: 0.001, lpTokenBuy: 0.0005, lpNative: 0.0005 });
  });

  it('conserves the sweep', () => {
    for (const v of [0, 0.5, 3.7, 1e5]) {
      const s = opsSplit(v);
      expect(s.burnBuy + s.lpTokenBuy + s.lpNative).toBeCloseTo(v, 9);
    }
  });

  it('keeps both LP legs equal', () => {
    const s = opsSplit(9);
    expect(s.lpTokenBuy).toBe(s.lpNative);
    expect(s.burnBuy).toBe(s.lpTokenBuy + s.lpNative);
  });

  it('snapshots the recipe so drift fails CI', () => {
    expect(opsSplit(100)).toMatchInlineSnapshot(`
      {
        "burnBuy": 50,
        "lpNative": 25,
        "lpTokenBuy": 25,
      }
    `);
  });
});

describe('feePie — GOLDEN', () => {
  it('reproduces the worked example from the plan', () => {
    // 2.0% curve fee on a 1 SOL notional, coin fully staked.
    const pie = feePie(0.02, 0.5);
    expect(pie.protocol).toBeCloseTo(0.004, 12); // 0.40% of notional
    expect(pie.stonkzOps).toBeCloseTo(0.002, 12); // 0.20% of notional
    expect(pie.creator).toBeCloseTo(0.007, 12); // 0.70% of notional
    expect(pie.stakers).toBeCloseTo(0.007, 12); // 0.70% of notional
  });

  it('gives the creator the whole 70% when nothing is staked', () => {
    const pie = feePie(1, 0);
    expect(pie).toEqual({ protocol: 0.2, stonkzOps: 0.1, creator: 0.7, stakers: 0 });
  });

  it('never leaks protocol or ops into the staker slice', () => {
    for (const f of [0, 0.2, 0.5, 5]) {
      const pie = feePie(1, f);
      expect(pie.protocol).toBeCloseTo(0.2, 12);
      expect(pie.stonkzOps).toBeCloseTo(0.1, 12);
      expect(pie.stakers).toBeLessThanOrEqual(0.35 + 1e-12);
      expect(pie.creator).toBeGreaterThanOrEqual(0.35 - 1e-12);
    }
  });

  it('conserves the whole fee', () => {
    const pie = feePie(3.3, 0.4);
    expect(pie.protocol + pie.stonkzOps + pie.creator + pie.stakers).toBeCloseTo(3.3, 9);
  });
});
