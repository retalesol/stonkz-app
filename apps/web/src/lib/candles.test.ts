import { describe, expect, it } from 'vitest';
import { fillCandleGaps, mergeFillIntoSeries } from './candles.js';

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
