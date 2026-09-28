import { describe, expect, it } from 'vitest';
import { CB_MS, CB_START_FEE } from '../src/constants.js';
import {
  FEE_SPLIT,
  BUYBACK_SPLIT,
  cbLeft,
  creatorVsStakers,
  effFee,
  feePie,
  inCashback,
  buybackSplit,
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
  it('pins the four ratios', () => {
    expect(FEE_SPLIT).toEqual({ creatorBucket: 0.69, protocol: 0.15, buyback: 0.1, rwa: 0.06 });
    expect(
      FEE_SPLIT.protocol + FEE_SPLIT.creatorBucket + FEE_SPLIT.buyback + FEE_SPLIT.rwa,
    ).toBeCloseTo(1, 12);
  });

  it('splits a unit fee into 0.69 / 0.15 / 0.10 / 0.06', () => {
    expect(splitFee(1)).toEqual({ protocol: 0.15, creatorBucket: 0.69, buyback: 0.1, rwa: 0.06 });
  });

  it('splits a 2% curve fee on a 1 SOL fill', () => {
    // 2.0% of 1 SOL = 0.02 SOL of fee.
    const s = splitFee(0.02);
    expect(s.protocol).toBeCloseTo(0.003, 12); // 0.30% of notional
    expect(s.buyback).toBeCloseTo(0.002, 12); // 0.20% of notional
    expect(s.rwa).toBeCloseTo(0.0012, 12); // 0.12% of notional
    expect(s.creatorBucket).toBeCloseTo(0.0138, 12); // 1.38% of notional
  });

  it('conserves the fee', () => {
    for (const fee of [0, 1e-9, 0.0001, 1, 12.345, 1e6]) {
      const s = splitFee(fee);
      expect(s.protocol + s.creatorBucket + s.buyback + s.rwa).toBeCloseTo(fee, 9);
    }
  });

  it('snapshots the split so drift fails CI', () => {
    expect(splitFee(100)).toMatchInlineSnapshot(`
      {
        "buyback": 10,
        "creatorBucket": 69,
        "protocol": 15,
        "rwa": 6,
      }
    `);
  });
});

describe('creatorVsStakers — GOLDEN', () => {
  it('gives the creator everything when nothing is staked', () => {
    expect(creatorVsStakers(0.69, 0)).toEqual({ creator: 0.69, stakers: 0 });
  });

  it('splits the bucket in half when the coin is fully staked', () => {
    // poolFrac maxes out at 0.5 -> stakers take half of the 69% bucket.
    const r = creatorVsStakers(0.69, 0.5);
    expect(r.creator).toBeCloseTo(0.345, 12);
    expect(r.stakers).toBeCloseTo(0.345, 12);
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

describe('buybackSplit — GOLDEN', () => {
  it('pins the recipe: half of the bought $STONKZ to crates, half burned', () => {
    expect(BUYBACK_SPLIT).toEqual({ crates: 0.5, burn: 0.5 });
  });

  it('splits the accrued 10% for the sweep', () => {
    expect(buybackSplit(1)).toEqual({ crates: 0.5, burn: 0.5 });
    expect(buybackSplit(0.002)).toEqual({ crates: 0.001, burn: 0.001 });
  });

  it('conserves the sweep', () => {
    for (const v of [0, 0.5, 3.7, 1e5]) {
      const s = buybackSplit(v);
      expect(s.crates + s.burn).toBeCloseTo(v, 9);
    }
  });

  it('snapshots the recipe so drift fails CI', () => {
    expect(buybackSplit(100)).toMatchInlineSnapshot(`
      {
        "burn": 50,
        "crates": 50,
      }
    `);
  });
});

describe('feePie — GOLDEN', () => {
  it('reproduces the worked example from the brief', () => {
    // 2.0% curve fee on a 1 SOL notional, coin fully staked.
    const pie = feePie(0.02, 0.5);
    expect(pie.protocol).toBeCloseTo(0.003, 12); // 0.30% of notional
    expect(pie.buyback).toBeCloseTo(0.002, 12); // 0.20% of notional
    expect(pie.rwa).toBeCloseTo(0.0012, 12); // 0.12% of notional
    expect(pie.creator).toBeCloseTo(0.0069, 12); // 0.69% of notional
    expect(pie.stakers).toBeCloseTo(0.0069, 12); // 0.69% of notional
  });

  it('gives the creator the whole 69% when nothing is staked', () => {
    const pie = feePie(1, 0);
    expect(pie).toEqual({ protocol: 0.15, buyback: 0.1, rwa: 0.06, creator: 0.69, stakers: 0 });
  });

  it('never leaks platform, buyback or RWA into the staker slice', () => {
    for (const f of [0, 0.2, 0.5, 5]) {
      const pie = feePie(1, f);
      expect(pie.protocol).toBeCloseTo(0.15, 12);
      expect(pie.buyback).toBeCloseTo(0.1, 12);
      expect(pie.rwa).toBeCloseTo(0.06, 12);
      expect(pie.stakers).toBeLessThanOrEqual(0.345 + 1e-12);
      expect(pie.creator).toBeGreaterThanOrEqual(0.345 - 1e-12);
    }
  });

  it('conserves the whole fee', () => {
    const pie = feePie(3.3, 0.4);
    expect(pie.protocol + pie.buyback + pie.rwa + pie.creator + pie.stakers).toBeCloseTo(3.3, 9);
  });
});
