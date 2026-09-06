import { describe, expect, it } from 'vitest';
import { CIRC_FRACTION, GRAD, SUPPLY } from '../src/constants.js';
import { circ, curve, curveMc, laneOf, liq, price, vol24 } from '../src/curve.js';

describe('curveMc', () => {
  it('starts at the base market cap with no dev buy', () => {
    expect(curveMc(0)).toBe(1400);
  });

  it('matches 1400 + 2600 * sol^1.12', () => {
    expect(curveMc(1)).toBe(4000);
    expect(curveMc(0.5)).toBeCloseTo(1400 + 2600 * Math.pow(0.5, 1.12), 9);
    expect(curveMc(10)).toBeCloseTo(1400 + 2600 * Math.pow(10, 1.12), 9);
  });

  it('clamps negative dev buys to zero', () => {
    expect(curveMc(-5)).toBe(1400);
  });

  it('is monotonic', () => {
    let prev = curveMc(0);
    for (let sol = 0.25; sol <= 25; sol += 0.25) {
      const next = curveMc(sol);
      expect(next).toBeGreaterThan(prev);
      prev = next;
    }
  });
});

describe('laneOf', () => {
  it('puts anything at or above the graduation cap in grad', () => {
    expect(laneOf({ mc: GRAD })).toBe('grad');
    expect(laneOf({ mc: 3020000 })).toBe('grad');
  });

  it('puts 55% to 100% of the curve in soon', () => {
    expect(laneOf({ mc: GRAD * 0.55 })).toBe('soon');
    expect(laneOf({ mc: 67900 })).toBe('soon');
    expect(laneOf({ mc: GRAD - 1 })).toBe('soon');
  });

  it('puts everything below 55% in new', () => {
    expect(laneOf({ mc: GRAD * 0.55 - 1 })).toBe('new');
    expect(laneOf({ mc: 4200 })).toBe('new');
    expect(laneOf({ mc: 0 })).toBe('new');
  });
});

describe('curve', () => {
  it('reports fill as a percentage of the graduation cap', () => {
    expect(curve({ mc: 0 })).toBe(0);
    expect(curve({ mc: GRAD / 2 })).toBe(50);
    expect(curve({ mc: GRAD })).toBe(100);
  });

  it('caps at 100 after graduation', () => {
    expect(curve({ mc: 3020000 })).toBe(100);
  });
});

describe('price', () => {
  it('divides market cap by supply', () => {
    expect(price({ mc: 69000, supply: 1e9 })).toBeCloseTo(0.000069, 12);
    expect(price({ mc: 1000, supply: 1e6 })).toBeCloseTo(0.001, 12);
  });

  it('falls back to the default supply', () => {
    expect(price({ mc: 69000 })).toBe(69000 / SUPPLY);
    expect(price({ mc: 69000, supply: 0 })).toBe(69000 / SUPPLY);
  });
});

describe('liq', () => {
  it('is 14% of market cap', () => {
    expect(liq({ mc: 100000 })).toBeCloseTo(14000, 9);
    expect(liq({ mc: 0 })).toBe(0);
  });
});

describe('vol24', () => {
  it('is deterministic in the coin seed', () => {
    // seed 1009 % 40 === 9 -> multiplier 0.69
    expect(vol24({ mc: 100000, seed: 1009 })).toBeCloseTo(69000, 9);
    expect(vol24({ mc: 100000, seed: 1009 })).toBe(vol24({ mc: 100000, seed: 1009 }));
  });

  it('spans 0.60x to 0.99x of market cap', () => {
    for (let seed = 0; seed < 200; seed++) {
      const v = vol24({ mc: 1000, seed });
      expect(v).toBeGreaterThanOrEqual(600);
      expect(v).toBeLessThanOrEqual(990);
    }
  });
});

describe('circ', () => {
  it('is 80% of supply in the simulation', () => {
    expect(circ({ supply: 1e9 })).toBe(8e8);
    expect(circ({ supply: 1e6 })).toBe(8e5);
    expect(CIRC_FRACTION).toBe(0.8);
  });

  it('falls back to the default supply', () => {
    expect(circ({})).toBe(SUPPLY * CIRC_FRACTION);
    expect(circ({ supply: 0 })).toBe(SUPPLY * CIRC_FRACTION);
  });
});
