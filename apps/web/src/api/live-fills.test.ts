import { describe, expect, it } from 'vitest';
import { BUCKET_MS, FillLedger, applyFillToSeries, bucketOf, sigKey } from './live-fills.js';

const SIG = '0x0DF81A74760DFFCA76878FB466324DBC1CB13F70B0BB8F9A42F81EBBE8542CA0';
const FID0 = `${SIG.toLowerCase()}:0`;
const T0 = 1_790_686_260_000;

describe('FillLedger', () => {
  it('trader: local print adds, the provisional and indexed twins only update', () => {
    const l = new FillLedger();
    expect(l.admit({ sig: SIG, source: 'local' }, T0)).toBe('add');
    expect(l.admit({ sig: SIG.toLowerCase(), fid: FID0, source: 'provisional' }, T0)).toBe(
      'update',
    );
    expect(l.isFinal(SIG)).toBe(false);
    expect(l.admit({ sig: SIG, fid: FID0, source: 'authoritative' }, T0)).toBe('update');
    expect(l.isFinal(SIG)).toBe(true);
    expect(l.hasPending()).toBe(false);
  });

  it('other viewer: the provisional print adds, the indexed one updates', () => {
    const l = new FillLedger();
    expect(l.admit({ sig: SIG, fid: FID0, source: 'provisional' }, T0)).toBe('add');
    expect(l.admit({ sig: SIG, fid: FID0, source: 'authoritative' }, T0)).toBe('update');
  });

  it('keeps two fills of one transaction apart by fid', () => {
    const l = new FillLedger();
    const fid1 = `${SIG.toLowerCase()}:1`;
    expect(l.admit({ sig: SIG, fid: FID0, source: 'provisional' }, T0)).toBe('add');
    expect(l.admit({ sig: SIG, fid: fid1, source: 'provisional' }, T0)).toBe('add');
    expect(l.admit({ sig: SIG, fid: fid1, source: 'authoritative' }, T0)).toBe('update');
    expect(l.admit({ sig: SIG, fid: FID0, source: 'authoritative' }, T0)).toBe('update');
  });

  it('a provisional print that beat the wallet makes the local one an update', () => {
    const l = new FillLedger();
    expect(l.admit({ sig: SIG, fid: FID0, source: 'provisional' }, T0)).toBe('add');
    expect(l.admit({ sig: SIG, source: 'local' }, T0)).toBe('update');
  });

  it('an indexed fill nobody printed early is new', () => {
    const l = new FillLedger();
    expect(l.admit({ sig: SIG, fid: FID0, source: 'authoritative' }, T0)).toBe('add');
    expect(l.admit({ source: 'authoritative' }, T0)).toBe('add'); // no sig: cannot dedupe
  });

  it('reports provisional prints the indexer never confirmed (reorged out)', () => {
    const l = new FillLedger();
    l.admit({ sig: SIG, fid: FID0, source: 'provisional' }, T0);
    l.admit({ sig: 'other', fid: 'other:0', source: 'provisional' }, T0 + 100_000);
    expect(l.stale(T0 + 60_000, 120_000)).toEqual([]);
    expect(l.stale(T0 + 125_000, 120_000)).toEqual([SIG.toLowerCase()]);
    l.forget(SIG);
    expect(l.stale(T0 + 125_000, 120_000)).toEqual([]);
    expect(l.hasPending()).toBe(true);
  });

  it('compares EVM hashes case-insensitively and base58 signatures exactly', () => {
    expect(sigKey('0xABC')).toBe('0xabc');
    expect(sigKey('5Abc')).toBe('5Abc');
  });
});

describe('applyFillToSeries', () => {
  const minute = bucketOf(T0);

  it('updates the open candle within its minute', () => {
    const h = [100, 110];
    const hv = [5, 7];
    const anchor = { lastBucket: minute };
    applyFillToSeries(h, hv, anchor, { t: minute + 30_000, mc: 120, volUsd: 27 }, true);
    expect(h).toEqual([100, 120]);
    expect(hv).toEqual([5, 34]);
  });

  it('opens a new candle in a later minute, carrying the close across gaps', () => {
    // The reported bug: a buy two minutes after the last candle only moved
    // the old point; no new candle appeared until a reload.
    const h = [100];
    const hv = [5];
    const anchor = { lastBucket: minute };
    applyFillToSeries(h, hv, anchor, { t: minute + 2 * BUCKET_MS + 5, mc: 130, volUsd: 27 }, true);
    expect(h).toEqual([100, 100, 130]);
    expect(hv).toEqual([5, 0, 27]);
    expect(anchor.lastBucket).toBe(minute + 2 * BUCKET_MS);
  });

  it('starts the series on a token with no candles yet', () => {
    const h: number[] = [];
    const hv: number[] = [];
    const anchor = { lastBucket: null };
    applyFillToSeries(h, hv, anchor, { t: T0, mc: 4_362.93, volUsd: 27.37 }, true);
    expect(h).toEqual([4_362.93]);
    expect(hv).toEqual([27.37]);
    expect(anchor.lastBucket).toBe(minute);
  });

  it('an update restates the close without counting volume twice', () => {
    const h = [100];
    const hv = [5];
    const anchor = { lastBucket: minute };
    applyFillToSeries(h, hv, anchor, { t: minute + 1, mc: 111, volUsd: 27 }, true); // local
    applyFillToSeries(h, hv, anchor, { t: minute + 2, mc: 112, volUsd: 27 }, false); // provisional
    applyFillToSeries(h, hv, anchor, { t: minute + 2, mc: 112, volUsd: 27 }, false); // indexed
    expect(h).toEqual([112]);
    expect(hv).toEqual([32]);
  });

  it('puts a late print’s volume on its own minute without moving the close', () => {
    const h = [100, 110];
    const hv = [5, 7];
    const anchor = { lastBucket: minute };
    applyFillToSeries(h, hv, anchor, { t: minute - BUCKET_MS + 1, mc: 90, volUsd: 3 }, true);
    expect(h).toEqual([100, 110]);
    expect(hv).toEqual([8, 7]);
  });

  it('caps the series length', () => {
    const h = [1, 2, 3];
    const hv = [0, 0, 0];
    const anchor = { lastBucket: minute };
    applyFillToSeries(
      h,
      hv,
      anchor,
      { t: minute + BUCKET_MS, mc: 4, volUsd: 1 },
      true,
      BUCKET_MS,
      3,
    );
    expect(h).toEqual([2, 3, 4]);
    expect(hv).toEqual([0, 0, 1]);
  });
});
