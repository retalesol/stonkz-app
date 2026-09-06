import { describe, expect, it } from 'vitest';
import { LOCKS, SUPPLY } from '../src/constants.js';
import { circ } from '../src/curve.js';
import { creatorVsStakers } from '../src/fees.js';
import { poolFrac, stakeMult, stakedFrac, yourShare } from '../src/stake.js';
import type { Stake } from '../src/types.js';

const T0 = 1_757_000_000_000;

function stake(over: Partial<Stake> = {}): Stake {
  return { amt: 0, mult: 1, days: 0, until: 0, rewTok: 0, rewSol: 0, ...over };
}

describe('stakeMult', () => {
  it('is 1 with no position', () => {
    expect(stakeMult(null, T0)).toBe(1);
    expect(stakeMult(undefined, T0)).toBe(1);
  });

  it('is 1 for a flex position with no lock', () => {
    expect(stakeMult(stake({ amt: 100, mult: 1, until: 0 }), T0)).toBe(1);
  });

  it('applies the lock multiplier while the lock runs', () => {
    expect(stakeMult(stake({ amt: 100, mult: 2.5, until: T0 + 1 }), T0)).toBe(2.5);
  });

  it('drops back to 1 once the lock expires', () => {
    expect(stakeMult(stake({ amt: 100, mult: 2.5, until: T0 }), T0)).toBe(1);
  });

  it('defaults to the current clock', () => {
    expect(stakeMult(stake({ amt: 1, mult: 8, until: Date.now() + 60_000 }))).toBe(8);
  });

  it('covers every lock tier in the grid', () => {
    for (const [, mult] of LOCKS) {
      expect(stakeMult(stake({ amt: 1, mult, until: T0 + 1 }), T0)).toBe(mult);
    }
  });
});

describe('stakedFrac', () => {
  const coin = { supply: 1e9 }; // circ = 8e8

  it('is zero with nothing staked', () => {
    expect(stakedFrac(coin, 0)).toBe(0);
  });

  it('is the staked share of circulating supply', () => {
    expect(stakedFrac(coin, 8e7)).toBeCloseTo(0.1, 12);
    expect(stakedFrac(coin, 4e8)).toBeCloseTo(0.5, 12);
  });

  it('caps at 1 even when more than circulating is staked', () => {
    expect(stakedFrac(coin, 8e8)).toBe(1);
    expect(stakedFrac(coin, 1e12)).toBe(1);
  });

  it('uses the default supply when the coin sets none', () => {
    expect(stakedFrac({}, circ({ supply: SUPPLY }) / 2)).toBeCloseTo(0.5, 12);
  });
});

describe('poolFrac', () => {
  const coin = { supply: 1e9 };

  it('is half the staked fraction', () => {
    expect(poolFrac(coin, 0)).toBe(0);
    expect(poolFrac(coin, 8e7)).toBeCloseTo(0.05, 12);
    expect(poolFrac(coin, 4e8)).toBeCloseTo(0.25, 12);
  });

  it('tops out at 0.5 — stakers never take more than half the creator bucket', () => {
    expect(poolFrac(coin, 8e8)).toBe(0.5);
    expect(poolFrac(coin, Number.MAX_SAFE_INTEGER)).toBe(0.5);
  });

  it('caps the memecoin-staker take at 35% of the curve fee', () => {
    // The 70% bucket times the 0.5 ceiling.
    const { creator, stakers } = creatorVsStakers(0.7, poolFrac(coin, 8e8));
    expect(stakers).toBeCloseTo(0.35, 12);
    expect(creator).toBeCloseTo(0.35, 12);
  });
});

describe('yourShare', () => {
  it('is zero with no weight of your own', () => {
    expect(yourShare(0, 1000)).toBe(0);
  });

  it('is zero when the pool has no weight at all', () => {
    expect(yourShare(100, 0)).toBe(0);
  });

  it('is your weight over the pool weight', () => {
    expect(yourShare(250, 1000)).toBeCloseTo(0.25, 12);
    expect(yourShare(1000, 1000)).toBe(1);
  });

  it('rewards the lock multiplier', () => {
    const flex = stake({ amt: 100, mult: 1, until: 0 });
    const locked = stake({ amt: 100, mult: 8, until: T0 + 1 });
    const others = 100;
    const flexWeight = flex.amt * stakeMult(flex, T0);
    const lockedWeight = locked.amt * stakeMult(locked, T0);
    expect(yourShare(flexWeight, others + flexWeight)).toBeCloseTo(0.5, 12);
    expect(yourShare(lockedWeight, others + lockedWeight)).toBeCloseTo(800 / 900, 12);
  });
});
