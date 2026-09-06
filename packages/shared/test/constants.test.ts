import { describe, expect, it } from 'vitest';
import {
  ACH,
  CB_MS,
  CB_START_FEE,
  CRATES,
  GRAD,
  HOUR,
  LOCKS,
  MAJORS,
  MAX_TICKER_LEN,
  RANKS,
  RAR,
  STOCKS,
  SUPPLIES,
  SUPPLY,
} from '../src/constants.js';
import { FEE_SPLIT, OPS_SPLIT } from '../src/fees.js';

/**
 * Review gate 0.B: changing a crate odds row or one of the 20/70/10 constants
 * has to fail here. These snapshots are the tripwire.
 */

describe('scalar constants', () => {
  it('pins the numbers the whole product is built on', () => {
    expect(GRAD).toBe(69000);
    expect(SUPPLY).toBe(1e9);
    expect(CB_MS).toBe(300000);
    expect(CB_START_FEE).toBe(50);
    expect(HOUR).toBe(3600000);
    expect(MAX_TICKER_LEN).toBe(10);
  });
});

describe('fee constants', () => {
  it('snapshots the 20 / 70 / 10 curve split', () => {
    expect(FEE_SPLIT).toMatchSnapshot();
  });

  it('snapshots the 50 / 25 / 25 $STONKZ ops recipe', () => {
    expect(OPS_SPLIT).toMatchSnapshot();
  });
});

describe('crate tables', () => {
  it('snapshots all eight tiers with full drop tables', () => {
    expect(CRATES).toMatchSnapshot();
  });

  it('snapshots the rarity ladder', () => {
    expect(RAR).toMatchSnapshot();
  });

  it('has one rarity label per drop row', () => {
    for (const c of CRATES) expect(c.drops).toHaveLength(RAR.length);
  });

  it('ends every tier on an item drop', () => {
    for (const c of CRATES) {
      const last = c.drops[c.drops.length - 1];
      expect(last?.[1]).toBe('I');
    }
  });

  it('keeps token payout bands ascending within a tier', () => {
    for (const c of CRATES) {
      let prevMax = 0;
      for (const d of c.drops) {
        if (d[1] !== 'S') continue;
        expect(d[2]).toBeLessThan(d[3]);
        expect(d[2]).toBeGreaterThanOrEqual(prevMax);
        prevMax = d[3];
      }
    }
  });
});

describe('rank ladder', () => {
  it('snapshots the ten ranks', () => {
    expect(RANKS).toMatchSnapshot();
  });

  it('is strictly ascending and starts at zero', () => {
    expect(RANKS[0]?.[1]).toBe(0);
    for (let i = 1; i < RANKS.length; i++) {
      expect(RANKS[i]?.[1]).toBeGreaterThan(RANKS[i - 1]?.[1] ?? 0);
    }
  });
});

describe('achievements', () => {
  it('snapshots all ten', () => {
    expect(ACH).toMatchSnapshot();
  });

  it('has ten unique keys', () => {
    expect(ACH).toHaveLength(10);
    expect(new Set(ACH.map((a) => a.k)).size).toBe(10);
  });
});

describe('lock grid', () => {
  it('snapshots the seven lock tiers', () => {
    expect(LOCKS).toMatchSnapshot();
  });

  it('starts at flex 1x and tops out at 8x for a year', () => {
    expect(LOCKS[0]).toEqual([0, 1, 'FLEX']);
    expect(LOCKS[LOCKS.length - 1]).toEqual([365, 8, '1Y']);
  });
});

describe('supplies', () => {
  it('snapshots the four fixed supplies', () => {
    expect(SUPPLIES).toMatchSnapshot();
  });
});

describe('base mints', () => {
  it('snapshots the tokenized stock list (2026-09-06 snapshot)', () => {
    expect(STOCKS).toMatchSnapshot();
  });

  it('snapshots the majors for both networks', () => {
    expect(MAJORS).toMatchSnapshot();
  });

  it('leads each network with its native gas token', () => {
    expect(MAJORS.SOL[0][0]).toBe('SOL');
    expect(MAJORS.RH[0][0]).toBe('ETH');
  });

  it('lists twenty stocks and ten majors per network', () => {
    expect(STOCKS).toHaveLength(20);
    expect(MAJORS.SOL).toHaveLength(10);
    expect(MAJORS.RH).toHaveLength(10);
  });
});
