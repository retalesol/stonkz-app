import { describe, expect, it } from 'vitest';
import { CRATES, HOUR, RAR, type Crate, type CrateDrop } from '../src/constants.js';
import {
  crateBy,
  crateReady,
  crateReadyAt,
  crateXp,
  rollCrateAmount,
  rollRwaUnits,
  rollDrop,
} from '../src/crates.js';
import type { CrateTier } from '../src/types.js';

const T0 = 1_757_000_000_000;

/** A fixed source so the odds table is pinned rather than sampled. */
const fixed = (v: number) => () => v;

describe('crateBy', () => {
  it('finds every tier', () => {
    for (const c of CRATES) expect(crateBy(c.k)).toEqual(c);
  });

  it('returns null for an unknown tier', () => {
    expect(crateBy('TITANIUM' as CrateTier)).toBeNull();
  });
});

describe('rollDrop — GOLDEN odds table', () => {
  it('every tier sums to exactly 100', () => {
    for (const c of CRATES) {
      const total = c.drops.reduce((acc, d) => acc + d[0], 0);
      expect(total, `${c.k} odds`).toBe(100);
    }
  });

  it('maps cumulative odds onto BRONZE 58 / 26 / 11 / 4 / 1', () => {
    const bronze = crateBy('BRONZE') as Crate;
    expect(rollDrop(bronze, fixed(0))).toBe(0);
    expect(rollDrop(bronze, fixed(0.5799))).toBe(0);
    expect(rollDrop(bronze, fixed(0.58))).toBe(0); // inclusive upper edge
    expect(rollDrop(bronze, fixed(0.5801))).toBe(1);
    expect(rollDrop(bronze, fixed(0.84))).toBe(1);
    expect(rollDrop(bronze, fixed(0.8401))).toBe(2);
    expect(rollDrop(bronze, fixed(0.95))).toBe(2);
    expect(rollDrop(bronze, fixed(0.9501))).toBe(3);
    expect(rollDrop(bronze, fixed(0.99))).toBe(3);
    expect(rollDrop(bronze, fixed(0.9901))).toBe(4);
  });

  it('lands the RHODIUM legendary on the last 2%', () => {
    const rhodium = crateBy('RHODIUM') as Crate;
    expect(rollDrop(rhodium, fixed(0.9799))).toBe(3);
    expect(rollDrop(rhodium, fixed(0.9801))).toBe(4);
  });

  it('always returns a valid index for every tier', () => {
    for (const c of CRATES) {
      for (const v of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.999999]) {
        const i = rollDrop(c, fixed(v));
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(RAR.length);
      }
    }
  });

  it('falls back to the last row when a table under-sums', () => {
    const short = {
      drops: [
        [10, 'S', 1, 2],
        [10, 'S', 2, 3],
        [10, 'S', 3, 4],
        [10, 'S', 4, 5],
        [10, 'S', 5, 6],
      ],
    } as unknown as Pick<Crate, 'drops'>;
    expect(rollDrop(short, fixed(0.99))).toBe(4);
  });

  it('defaults to Math.random', () => {
    const bronze = crateBy('BRONZE') as Crate;
    const i = rollDrop(bronze);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i).toBeLessThan(5);
  });

  it('honours the published distribution over a uniform sweep', () => {
    const bronze = crateBy('BRONZE') as Crate;
    const N = 20_000;
    const counts = new Map<number, number>();
    for (let n = 0; n < N; n++) {
      const i = rollDrop(bronze, fixed((n + 0.5) / N));
      counts.set(i, (counts.get(i) ?? 0) + 1);
    }
    expect((counts.get(0) ?? 0) / N).toBeCloseTo(0.58, 3);
    expect((counts.get(1) ?? 0) / N).toBeCloseTo(0.26, 3);
    expect((counts.get(2) ?? 0) / N).toBeCloseTo(0.11, 3);
    expect((counts.get(3) ?? 0) / N).toBeCloseTo(0.04, 3);
    expect((counts.get(4) ?? 0) / N).toBeCloseTo(0.01, 3);
  });
});

describe('rollCrateAmount', () => {
  it('rounds token payouts to the nearest ten', () => {
    const drop: CrateDrop = [58, 'S', 50, 150];
    expect(rollCrateAmount(drop, fixed(0))).toBe(50);
    expect(rollCrateAmount(drop, fixed(1))).toBe(150);
    expect(rollCrateAmount(drop, fixed(0.5))).toBe(100);
    expect(rollCrateAmount(drop, fixed(0.234))).toBe(70); // 73.4 -> 70
  });

  it('pays nothing for item drops', () => {
    expect(rollCrateAmount([1, 'I', 'FEE REBATE 24H'], fixed(0.5))).toBe(0);
  });

  it('defaults to Math.random', () => {
    const amt = rollCrateAmount([58, 'S', 50, 150]);
    expect(amt).toBeGreaterThanOrEqual(50);
    expect(amt).toBeLessThanOrEqual(150);
    expect(amt % 10).toBe(0);
  });
});

describe('crateXp', () => {
  it('is 10 for BRONZE and rises 10 per tier', () => {
    expect(crateXp(0)).toBe(10);
    expect(crateXp(1)).toBe(20);
    expect(crateXp(3)).toBe(40); // GOLD
    expect(crateXp(CRATES.length - 1)).toBe(10 + (CRATES.length - 1) * 10); // RHODIUM
  });
});

describe('crate cooldowns', () => {
  it('schedules the next open by the tier cooldown', () => {
    expect(crateReadyAt({ cd: 1 }, T0)).toBe(T0 + HOUR);
    expect(crateReadyAt({ cd: 168 }, T0)).toBe(T0 + 168 * HOUR);
  });

  it('pins the published cooldown ladder', () => {
    expect(CRATES.map((c) => c.cd)).toEqual([1, 2, 4, 6, 12, 24, 72, 168]);
  });

  it('is ready when never opened or once the cooldown elapses', () => {
    expect(crateReady(undefined, T0)).toBe(true);
    expect(crateReady(0, T0)).toBe(true);
    expect(crateReady(T0, T0)).toBe(true);
    expect(crateReady(T0 + 1, T0)).toBe(false);
  });

  it('defaults to the current clock', () => {
    expect(crateReady(Date.now() + 60_000)).toBe(false);
  });
});

describe('rollRwaUnits', () => {
  it('draws fractional units inside the row bounds, to four decimals', () => {
    const drop = [6, 'R', 'PAXG', 0.002, 0.01] as const;
    expect(rollRwaUnits(drop, fixed(0))).toBe(0.002);
    expect(rollRwaUnits(drop, fixed(1))).toBe(0.01);
    expect(rollRwaUnits(drop, fixed(0.5))).toBe(0.006);
    expect(rollRwaUnits(drop, fixed(0.33333))).toBe(0.0047);
  });

  it('is zero for token and item rows', () => {
    expect(rollRwaUnits([58, 'S', 50, 150] as const, fixed(0.5))).toBe(0);
    expect(rollRwaUnits([1, 'I', 'FEE REBATE 24H'] as const, fixed(0.5))).toBe(0);
  });

  it('defaults to Math.random', () => {
    const u = rollRwaUnits([6, 'R', 'PAXG', 0.002, 0.01] as const);
    expect(u).toBeGreaterThanOrEqual(0.002);
    expect(u).toBeLessThanOrEqual(0.01);
  });

  it('every tier from Silver up carries exactly one RWA row and Bronze / Iron none', () => {
    for (const c of CRATES) {
      const rwaRows = c.drops.filter((d) => d[1] === 'R').length;
      expect(rwaRows, c.k).toBe(c.k === 'BRONZE' || c.k === 'IRON' ? 0 : 1);
    }
  });
});
