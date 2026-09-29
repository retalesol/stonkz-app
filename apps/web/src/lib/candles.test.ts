import { describe, expect, it } from 'vitest';
import {
  TF_MS,
  aggregateCandles,
  defaultTimeframe,
  fillCandleGaps,
  fillOhlcGaps,
  foldTrade,
  mergeFillIntoSeries,
  seriesToCandles,
  volumeSince,
  type Candle,
} from './candles.js';

describe('fillCandleGaps', () => {
  it('inserts zero-volume buckets between closes', () => {
    const filled = fillCandleGaps(
      [
        { t: 0, c: 1, v: 10 },
        { t: 180_000, c: 3, v: 5 },
      ],
      60_000,
    );
    expect(filled.map((k) => k.t)).toEqual([0, 60_000, 120_000, 180_000]);
    expect(filled[1]).toEqual({ t: 60_000, c: 1, v: 0 });
    expect(filled[2]).toEqual({ t: 120_000, c: 1, v: 0 });
    expect(filled[3]?.c).toBe(3);
  });

  it('is a no-op for contiguous buckets', () => {
    const src = [
      { t: 0, c: 1, v: 1 },
      { t: 60_000, c: 2, v: 2 },
    ];
    expect(fillCandleGaps(src, 60_000)).toEqual(src);
  });
});

describe('mergeFillIntoSeries', () => {
  it('updates the last point instead of appending', () => {
    const h = [100, 200];
    const hv = [1, 2];
    mergeFillIntoSeries(h, hv, 250, 3);
    expect(h).toEqual([100, 250]);
    expect(hv).toEqual([1, 5]);
  });
});

/* MEMEMAN on Base Sepolia: two 0.01 ETH buys 25 minutes apart, spot cap
 * 4362.93 then 4413.66 over a 1M supply (`trades.mc / supply`). */
const T1 = 1_790_686_260_000;
const T2 = 1_790_687_804_000;
const SUPPLY = 1_000_000;
const P1 = 4362.931659 / SUPPLY;
const P2 = 4413.656488 / SUPPLY;
const REST: Candle[] = [
  { t: T1, o: P1, h: P1, l: P1, c: P1, v: 27.37, n: 1 },
  { t: 1_790_687_760_000, o: P1, h: P2, l: P1, c: P2, v: 27.37, n: 1 },
];

describe('fillOhlcGaps', () => {
  it('carries the close through quiet minutes and out to now', () => {
    const now = T2 + 3 * 60_000;
    const out = fillOhlcGaps(REST, TF_MS['1m'], now);
    // T1 .. T2's bucket is 25 minutes, plus three more to "now".
    expect(out.length).toBe(26 + 3);
    expect(out[0]?.t).toBe(T1);
    const gap = out[1]!;
    expect(gap).toEqual({ t: T1 + 60_000, o: P1, h: P1, l: P1, c: P1, v: 0, n: 0 });
    expect(out[out.length - 1]?.t).toBe(Math.floor(now / 60_000) * 60_000);
    expect(out[out.length - 1]?.c).toBe(P2);
    // Volume is never invented for a gap.
    expect(out.reduce((n, k) => n + k.v, 0)).toBeCloseTo(54.74, 6);
  });

  it('keeps the newest `maxPoints` so an idle coin cannot allocate a day of 1m candles', () => {
    const out = fillOhlcGaps(REST, 60_000, T2 + 86_400_000, 200);
    expect(out.length).toBe(200);
    expect(out[out.length - 1]?.c).toBe(P2);
  });

  it('merges a duplicate bucket instead of drawing it twice', () => {
    const dup: Candle = { t: T1, o: P1, h: P1 * 1.01, l: P1, c: P1 * 1.01, v: 5, n: 1 };
    const out = fillOhlcGaps([REST[0]!, dup], 60_000);
    expect(out.length).toBe(1);
    expect(out[0]?.v).toBeCloseTo(32.37, 6);
    expect(out[0]?.c).toBe(P1 * 1.01);
  });

  it('returns nothing for nothing', () => {
    expect(fillOhlcGaps([], 60_000, T2)).toEqual([]);
  });
});

describe('foldTrade', () => {
  it('a same-bucket fill moves the close and adds volume', () => {
    const k = fillOhlcGaps(REST, 60_000);
    const last = k[k.length - 1]!;
    foldTrade(k, { t: last.t + 30_000, price: P2 * 1.02, usd: 10 }, 60_000);
    const after = k[k.length - 1]!;
    expect(after.t).toBe(last.t);
    expect(after.c).toBeCloseTo(P2 * 1.02, 12);
    expect(after.h).toBeCloseTo(P2 * 1.02, 12);
    expect(after.v).toBeCloseTo(37.37, 6);
    expect(after.n).toBe(2);
  });

  it('a later fill opens a candle whose open is the previous close, carrying quiet buckets', () => {
    const k = fillOhlcGaps(REST, 60_000);
    const last = k[k.length - 1]!;
    foldTrade(
      k,
      { t: last.t + 3 * 60_000 + 5_000, price: P2 * 0.9, usd: 8, pending: true },
      60_000,
    );
    expect(k.length).toBe(26 + 3);
    const opened = k[k.length - 1]!;
    expect(opened.o).toBe(P2);
    expect(opened.c).toBeCloseTo(P2 * 0.9, 12);
    expect(opened.l).toBeCloseTo(P2 * 0.9, 12);
    expect(opened.h).toBe(P2);
    expect(opened.pending).toBe(true);
    // The carried candles are flat and unmarked.
    expect(k[k.length - 2]).toEqual({
      t: last.t + 2 * 60_000,
      o: P2,
      h: P2,
      l: P2,
      c: P2,
      v: 0,
      n: 0,
    });
  });

  it('a late print only adds volume and range to its own bucket', () => {
    const k = fillOhlcGaps(REST, 60_000);
    const closeBefore = k[k.length - 1]!.c;
    foldTrade(k, { t: T1 + 10_000, price: P1 * 1.5, usd: 3 }, 60_000);
    expect(k[0]?.v).toBeCloseTo(30.37, 6);
    expect(k[0]?.h).toBeCloseTo(P1 * 1.5, 12);
    expect(k[0]?.c).toBe(P1);
    expect(k[k.length - 1]?.c).toBe(closeBefore);
  });

  it('starts a series from nothing', () => {
    const k: Candle[] = [];
    foldTrade(k, { t: T1 + 1, price: P1, usd: 27.37 }, 60_000);
    expect(k).toEqual([{ t: T1, o: P1, h: P1, l: P1, c: P1, v: 27.37, n: 1 }]);
  });

  it('ignores a print without a price', () => {
    const k: Candle[] = [];
    foldTrade(k, { t: T1, price: 0, usd: 1 }, 60_000);
    expect(k).toEqual([]);
  });
});

describe('aggregateCandles', () => {
  it('rolls 1m candles into 5m buckets with OHLC and summed volume', () => {
    const one = fillOhlcGaps(REST, 60_000);
    const five = aggregateCandles(one, TF_MS['5m']);
    expect(five[0]?.t).toBe(1_790_686_200_000);
    expect(five[five.length - 1]?.t).toBe(1_790_687_700_000);
    expect(five.reduce((n, k) => n + k.v, 0)).toBeCloseTo(54.74, 6);
    expect(five[0]?.o).toBe(P1);
    expect(five[five.length - 1]?.c).toBe(P2);
    expect(five[five.length - 1]?.h).toBe(P2);
    expect(five[five.length - 1]?.l).toBe(P1);
  });
});

describe('seriesToCandles', () => {
  it('turns the sim cap series into candles ending at the given bucket', () => {
    const k = seriesToCandles([1000, 1100, 1050], [1, 2, 3], 1e9, 600_000, 60_000);
    expect(k.map((x) => x.t)).toEqual([480_000, 540_000, 600_000]);
    expect(k[1]?.o).toBeCloseTo(1e-6, 12);
    expect(k[1]?.c).toBeCloseTo(1.1e-6, 12);
    expect(k[2]?.h).toBeCloseTo(1.1e-6, 12);
    expect(k[2]?.l).toBeCloseTo(1.05e-6, 12);
    expect(k[2]?.v).toBe(3);
  });
});

describe('defaultTimeframe / volumeSince', () => {
  it('picks a coarser bucket for an older coin', () => {
    expect(defaultTimeframe(30)).toBe('1m');
    expect(defaultTimeframe(410)).toBe('5m');
    expect(defaultTimeframe(2 * 1440)).toBe('15m');
    expect(defaultTimeframe(10 * 1440)).toBe('1h');
    expect(defaultTimeframe(60 * 1440)).toBe('4h');
  });

  it('sums the trailing window only', () => {
    const k = fillOhlcGaps(REST, 60_000, T2 + 60_000);
    expect(volumeSince(k, T2 + 60_000, 30 * 60_000)).toBeCloseTo(54.74, 6);
    expect(volumeSince(k, T2 + 60_000, 10 * 60_000)).toBeCloseTo(27.37, 6);
  });
});
