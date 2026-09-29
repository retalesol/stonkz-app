import { describe, expect, it } from 'vitest';
import {
  BUCKET_MS,
  FillLedger,
  applyFillToSeries,
  bucketOf,
  capUsd,
  coinBaseUsd,
  isNativeBase,
  nudgedCap,
  remarkCaps,
  sigKey,
} from './live-fills.js';

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

describe('market caps: base × live mark (Pump.fun)', () => {
  const marks = { SOL: 200, ETH: 4000, USDC: 1 } as const;
  const mark = (u: keyof typeof marks): number => marks[u];

  it('knows which bases are the chain gas token', () => {
    expect(isNativeBase('ETH', 'WETH')).toBe(true);
    expect(isNativeBase('ETH', 'eth')).toBe(true);
    expect(isNativeBase('ETH', undefined)).toBe(true);
    expect(isNativeBase('ETH', 'USDC')).toBe(false);
    expect(isNativeBase('SOL', 'WSOL')).toBe(true);
    expect(isNativeBase('SOL', 'AAPLx')).toBe(false);
  });

  it('prices a native-paired coin off the footer mark and any other base off the served price', () => {
    expect(coinBaseUsd({ net: 'BASE', base: 'WETH' }, mark)).toBe(4000);
    expect(coinBaseUsd({ net: 'SOL' }, mark)).toBe(200);
    // A USDC-paired coin on Base: $1 from the API, never the ETH mark.
    expect(coinBaseUsd({ net: 'BASE', base: 'USDC', baseUsd: 1 }, mark)).toBe(1);
    // A stock base whose live price the API served.
    expect(coinBaseUsd({ net: 'RH', base: 'AAPLx', baseUsd: 231.5 }, mark)).toBe(231.5);
    // Unknown base and nothing served: no mark.
    expect(coinBaseUsd({ net: 'RH', base: 'AAPLx' }, mark)).toBe(0);
    // Native base but the footer has no price yet: fall back to what was served.
    expect(coinBaseUsd({ net: 'SOL', base: 'SOL', baseUsd: 190 }, () => 0)).toBe(190);
  });

  it('converts a base cap and falls back to the frame USD when it cannot', () => {
    expect(capUsd(1.61, 4000, 4413)).toBeCloseTo(6440, 9);
    expect(capUsd(undefined, 4000, 4413)).toBe(4413);
    expect(capUsd(1.61, 0, 4413)).toBe(4413);
    expect(capUsd(0, 4000, 4413)).toBe(4413);
  });

  it('a live fill and a REST read of the same fill agree to the cent', () => {
    // The indexer frame: mc at the launch snapshot ($2,736.6/ETH), mcBase the truth.
    const frame = { mc: 4413.656488, mcBase: 4413.656488 / 2736.6 };
    const fromFrame = capUsd(
      frame.mcBase,
      coinBaseUsd({ net: 'BASE', base: 'WETH' }, mark),
      frame.mc,
    );
    // What GET /tokens/:sym would say with the same live mark.
    const fromRest = frame.mcBase * 4000;
    expect(fromFrame).toBeCloseTo(fromRest, 9);
    expect(fromFrame).not.toBeCloseTo(frame.mc, 0);
  });

  it('nudges the base cap by the same ratio as the USD cap, floor included', () => {
    const c = { mc: 5000, mcBase: 1.25 };
    const up = nudgedCap(c, 1.1);
    expect(up.mc).toBeCloseTo(5500, 9);
    expect(up.mcBase).toBeCloseTo(1.375, 9);
    // The $900 floor clamps USD; base follows the clamped ratio so a later
    // re-mark at the same price reproduces the same dollar figure.
    const floored = nudgedCap({ mc: 1000, mcBase: 0.25 }, 0.5);
    expect(floored.mc).toBe(900);
    expect(floored.mcBase).toBeCloseTo(0.225, 9);
    expect((floored.mcBase as number) * 4000).toBeCloseTo(900, 9);
    // A sim coin (no base cap) only moves in USD.
    expect(nudgedCap({ mc: 5000 }, 1.1)).toEqual({ mc: 5500 });
  });

  it('re-marks every coin with a base cap on a native price tick and leaves the rest', () => {
    const coins = [
      { net: 'BASE' as const, base: 'WETH', mc: 4413, mcBase: 1.5 },
      { net: 'SOL' as const, base: 'SOL', mc: 1000, mcBase: 5 },
      { net: 'BASE' as const, base: 'USDC', baseUsd: 1, mc: 2500, mcBase: 2500 },
      { net: 'SOL' as const, mc: 777 }, // sim / fixture coin: no base figure
    ];
    // The SOL coin (5 × $200) and the USDC coin already sit at their mark.
    expect(remarkCaps(coins, mark)).toBe(1);
    expect(coins[0]?.mc).toBe(6000);
    expect(coins[1]?.mc).toBe(1000);
    expect(coins[2]?.mc).toBe(2500);
    expect(coins[3]?.mc).toBe(777);
    // Same marks again: nothing moves.
    expect(remarkCaps(coins, mark)).toBe(0);
    // ETH doubles: only the ETH-paired coin moves.
    expect(remarkCaps(coins, (u) => (u === 'ETH' ? 8000 : mark(u)))).toBe(1);
    expect(coins[0]?.mc).toBe(12_000);
  });

  it('the 1m series takes the re-marked cap like any other fill', () => {
    const h: number[] = [];
    const hv: number[] = [];
    const anchor = { lastBucket: null };
    const usd = capUsd(1.5, 4000, 0);
    applyFillToSeries(h, hv, anchor, { t: T0, mc: usd, volUsd: 10 }, true);
    expect(h).toEqual([6000]);
    expect(anchor.lastBucket).toBe(bucketOf(T0, BUCKET_MS));
  });
});
