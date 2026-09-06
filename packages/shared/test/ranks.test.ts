import { describe, expect, it } from 'vitest';
import { ACH, RANKS } from '../src/constants.js';
import {
  XP_CASHBACK_LAUNCH,
  XP_DIAMOND_HANDS,
  XP_FOLLOW,
  XP_GRADUATE,
  XP_LAUNCH,
  XP_STAKE_CLAIM,
  XP_WALL_POST,
  achOf,
  applyXpMult,
  dayKey,
  rankOf,
  xpForFeeClaim,
  xpForStake,
  xpForTrade,
  xpMult,
} from '../src/ranks.js';
import type { AchievementKey } from '../src/types.js';

describe('rankOf', () => {
  it('starts at LURKER', () => {
    const r = rankOf(0);
    expect(r.i).toBe(0);
    expect(r.name).toBe('LURKER');
    expect(r.cur).toBe(0);
    expect(r.next).toBe(250);
    expect(r.pct).toBe(0);
    expect(r.toNext).toBe(250);
  });

  it('lands exactly on a threshold', () => {
    const r = rankOf(250);
    expect(r.i).toBe(1);
    expect(r.name).toBe('BAG HOLDER');
    expect(r.pct).toBe(0);
    expect(r.toNext).toBe(450);
  });

  it('reports progress inside a rank', () => {
    // 1840 XP: TRENCH RAT (1500) -> SNIPER (3000).
    const r = rankOf(1840);
    expect(r.name).toBe('TRENCH RAT');
    expect(r.i).toBe(3);
    expect(r.cur).toBe(1500);
    expect(r.next).toBe(3000);
    expect(r.pct).toBeCloseTo(((1840 - 1500) / 1500) * 100, 9);
    expect(r.toNext).toBe(1160);
  });

  it('saturates at STONK LORD', () => {
    const r = rankOf(1_000_000);
    expect(r.i).toBe(RANKS.length - 1);
    expect(r.name).toBe('STONK LORD');
    expect(r.next).toBeNull();
    expect(r.pct).toBe(100);
    expect(r.toNext).toBe(0);
  });

  it('clamps below the first threshold', () => {
    const r = rankOf(-500);
    expect(r.i).toBe(0);
    expect(r.pct).toBe(0);
  });

  it('walks every rank boundary in order', () => {
    RANKS.forEach(([name, xp], i) => {
      const r = rankOf(xp);
      expect(r.i).toBe(i);
      expect(r.name).toBe(name);
    });
  });
});

describe('dayKey', () => {
  it('is YYYY-M-D with no zero padding', () => {
    expect(dayKey(new Date(2026, 8, 6))).toBe('2026-9-6');
    expect(dayKey(new Date(2026, 0, 1))).toBe('2026-1-1');
    expect(dayKey(new Date(2026, 11, 31))).toBe('2026-12-31');
  });

  it('defaults to today', () => {
    expect(dayKey()).toBe(dayKey(new Date()));
  });
});

describe('xpMult — GOLDEN', () => {
  it('is 1.00x on day one', () => {
    expect(xpMult(1)).toBe(1);
    expect(xpMult(0)).toBe(1);
    expect(xpMult(null)).toBe(1);
    expect(xpMult(undefined)).toBe(1);
  });

  it('adds 5% per streak day', () => {
    expect(xpMult(2)).toBeCloseTo(1.05, 12);
    expect(xpMult(4)).toBeCloseTo(1.15, 12);
  });

  it('caps at 1.30x from day seven', () => {
    expect(xpMult(7)).toBeCloseTo(1.3, 12);
    expect(xpMult(30)).toBeCloseTo(1.3, 12);
  });

  it('ignores negative streaks', () => {
    expect(xpMult(-5)).toBe(1);
  });
});

describe('applyXpMult', () => {
  it('rounds after scaling', () => {
    expect(applyXpMult(100, 1)).toBe(100);
    expect(applyXpMult(100, 7)).toBe(130);
    expect(applyXpMult(5, 2)).toBe(5); // 5.25 -> 5
    expect(applyXpMult(XP_LAUNCH, 7)).toBe(195);
  });
});

describe('XP formulas — GOLDEN', () => {
  it('trade XP is max(5, round(native * 40))', () => {
    expect(xpForTrade(0)).toBe(5);
    expect(xpForTrade(0.01)).toBe(5);
    expect(xpForTrade(0.125)).toBe(5);
    expect(xpForTrade(0.5)).toBe(20);
    expect(xpForTrade(1)).toBe(40);
    expect(xpForTrade(5)).toBe(200);
    expect(xpForTrade(2.34)).toBe(94); // round(93.6)
  });

  it('launch XP is a flat 150', () => {
    expect(XP_LAUNCH).toBe(150);
    expect(XP_CASHBACK_LAUNCH).toBe(150);
  });

  it('fee-claim XP is max(10, round(native * 30))', () => {
    expect(xpForFeeClaim(0)).toBe(10);
    expect(xpForFeeClaim(0.2)).toBe(10);
    expect(xpForFeeClaim(1)).toBe(30);
    expect(xpForFeeClaim(2.26)).toBe(68); // round(67.8)
  });

  it('stake XP is max(5, round(amount / circulating * 400))', () => {
    expect(xpForStake(0, 8e8)).toBe(5);
    expect(xpForStake(8e8, 8e8)).toBe(400);
    expect(xpForStake(8e7, 8e8)).toBe(40);
    // The Math.max(1, ...) guard keeps a zero circulating supply from exploding.
    expect(xpForStake(2, 0)).toBe(800);
  });

  it('pins the flat awards', () => {
    expect(XP_STAKE_CLAIM).toBe(12);
    expect(XP_FOLLOW).toBe(6);
    expect(XP_WALL_POST).toBe(8);
    expect(XP_GRADUATE).toBe(250);
    expect(XP_DIAMOND_HANDS).toBe(200);
  });
});

describe('achOf', () => {
  it('finds every achievement by key', () => {
    for (const a of ACH) {
      expect(achOf(a.k)).toEqual(a);
    }
  });

  it('returns null for an unknown key', () => {
    expect(achOf('nope' as AchievementKey)).toBeNull();
  });
});
