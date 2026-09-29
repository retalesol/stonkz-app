/**
 * Candle building for the token chart — DOM-free so it is unit tested
 * (`candles.test.ts`).
 *
 * Prices are USD per token at the curve's spot after each fill (what
 * `/tokens/:sym/candles` serves and what a live `fill` frame's `mc / supply`
 * gives), so REST history and live prints draw on one basis.
 */

export interface CandlePoint {
  t: number;
  c: number;
  v: number;
}

export interface Candle {
  /** Bucket start, epoch ms. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** USD volume. */
  v: number;
  /** Fills in the bucket (0 for a carried gap candle). */
  n: number;
  /** Holds at least one print the indexer has not confirmed yet. */
  pending?: boolean;
}

export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export const TF_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

/** Longest series the chart keeps per timeframe. */
export const MAX_CANDLES = 600;

export function isTimeframe(v: string): v is Timeframe {
  return (TIMEFRAMES as readonly string[]).includes(v);
}

/**
 * The bucket a coin of `ageMinutes` opens on: fine enough that the first
 * hour is not one bar, coarse enough that a week-old coin is not 10,000 flat
 * minutes with its two fills scrolled off the left.
 */
export function defaultTimeframe(ageMinutes: number): Timeframe {
  if (ageMinutes < 120) return '1m';
  if (ageMinutes < 12 * 60) return '5m';
  if (ageMinutes < 3 * 1440) return '15m';
  if (ageMinutes < 14 * 1440) return '1h';
  return '4h';
}

export function bucketOf(t: number, bucketMs: number): number {
  return Math.floor(t / bucketMs) * bucketMs;
}

/**
 * Gap-fill candle closes so the chart's time axis does not compress quiet
 * periods. Each missing 1m (or other) bucket inherits the previous close with
 * zero volume.
 */
export function fillCandleGaps(candles: CandlePoint[], bucketMs: number): CandlePoint[] {
  if (candles.length === 0 || bucketMs <= 0) return candles.slice();
  const sorted = [...candles].sort((a, b) => a.t - b.t);
  const out: CandlePoint[] = [sorted[0]!];
  for (let i = 1; i < sorted.length; i++) {
    const prev = out[out.length - 1]!;
    const next = sorted[i]!;
    let cursor = prev.t + bucketMs;
    // Cap fill so a multi-day gap cannot explode the series.
    let guard = 0;
    while (cursor < next.t && guard < 10_000) {
      out.push({ t: cursor, c: prev.c, v: 0 });
      cursor += bucketMs;
      guard++;
    }
    out.push(next);
  }
  return out;
}

/** Merge a live fill into the last open bucket instead of appending a point. */
export function mergeFillIntoSeries(
  series: number[],
  volume: number[],
  mc: number,
  volUsd: number,
): void {
  if (series.length === 0) {
    series.push(mc);
    volume.push(volUsd);
    return;
  }
  series[series.length - 1] = mc;
  volume[volume.length - 1] = (volume[volume.length - 1] ?? 0) + volUsd;
}

function flat(t: number, price: number): Candle {
  return { t, o: price, h: price, l: price, c: price, v: 0, n: 0 };
}

/**
 * Sorts, carries the close across quiet buckets and, when `untilT` is given,
 * out to the bucket containing it (so the right edge is "now"). Bounded to
 * `maxPoints` by dropping the oldest, which is also what stops a week-old
 * coin on 1m from allocating ten thousand candles.
 */
export function fillOhlcGaps(
  candles: Candle[],
  bucketMs: number,
  untilT?: number,
  maxPoints = MAX_CANDLES,
): Candle[] {
  if (bucketMs <= 0) return candles.slice();
  const sorted = [...candles].sort((a, b) => a.t - b.t);
  if (sorted.length === 0) return [];
  const out: Candle[] = [{ ...sorted[0]! }];
  const carry = (to: number): void => {
    const prev = out[out.length - 1]!;
    let cursor = prev.t + bucketMs;
    let guard = 0;
    while (cursor < to && guard < 20_000) {
      out.push(flat(cursor, prev.c));
      cursor += bucketMs;
      guard++;
    }
  };
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i]!;
    const prev = out[out.length - 1]!;
    if (next.t === prev.t) {
      // Duplicate bucket (a REST candle and its live twin): keep one.
      out[out.length - 1] = mergeCandle(prev, next);
      continue;
    }
    carry(next.t);
    out.push({ ...next });
  }
  if (untilT !== undefined) {
    const end = bucketOf(untilT, bucketMs);
    if (end > out[out.length - 1]!.t) {
      carry(end);
      out.push(flat(end, out[out.length - 1]!.c));
    }
  }
  return out.length > maxPoints ? out.slice(out.length - maxPoints) : out;
}

function mergeCandle(a: Candle, b: Candle): Candle {
  return {
    t: a.t,
    o: a.o,
    h: Math.max(a.h, b.h),
    l: Math.min(a.l, b.l),
    c: b.c,
    v: a.v + b.v,
    n: a.n + b.n,
    ...(a.pending || b.pending ? { pending: true } : {}),
  };
}

export interface FoldTrade {
  /** Fill time, epoch ms. */
  t: number;
  /** USD per token after the fill (spot). */
  price: number;
  /** USD notional. */
  usd: number;
  pending?: boolean | undefined;
}

/**
 * Applies one fill to an ascending candle list in place: a fill in the last
 * bucket moves its close, a later bucket opens a new candle (open = previous
 * close, quiet buckets carried), an older bucket only adds its volume and
 * stretches that candle's range — the close already moved on.
 */
export function foldTrade(candles: Candle[], trade: FoldTrade, bucketMs: number): void {
  if (!(trade.price > 0) || !Number.isFinite(trade.t)) return;
  const bucket = bucketOf(trade.t, bucketMs);
  const vol = Math.max(0, trade.usd || 0);
  const last = candles[candles.length - 1];
  if (!last) {
    candles.push({
      t: bucket,
      o: trade.price,
      h: trade.price,
      l: trade.price,
      c: trade.price,
      v: vol,
      n: 1,
      ...(trade.pending ? { pending: true } : {}),
    });
    return;
  }
  if (bucket >= last.t) {
    if (bucket > last.t) {
      let cursor = last.t + bucketMs;
      let guard = 0;
      while (cursor < bucket && guard < 20_000) {
        candles.push(flat(cursor, last.c));
        cursor += bucketMs;
        guard++;
      }
      candles.push({ t: bucket, o: last.c, h: last.c, l: last.c, c: last.c, v: 0, n: 0 });
    }
    const k = candles[candles.length - 1]!;
    k.h = Math.max(k.h, trade.price);
    k.l = Math.min(k.l, trade.price);
    k.c = trade.price;
    k.v += vol;
    k.n += 1;
    if (trade.pending) k.pending = true;
    return;
  }
  // Late print for an older bucket.
  let idx = candles.length - 1;
  while (idx >= 0 && candles[idx]!.t > bucket) idx--;
  const k = idx >= 0 ? candles[idx]! : candles[0]!;
  k.h = Math.max(k.h, trade.price);
  k.l = Math.min(k.l, trade.price);
  k.v += vol;
  k.n += 1;
  if (trade.pending) k.pending = true;
}

/**
 * The sim's market-cap series (one point per minute, newest last, no
 * timestamps) as candles ending at `endBucket`: each point's close is its
 * cap over supply and its open the previous close.
 */
export function seriesToCandles(
  h: readonly number[],
  hv: readonly number[],
  supply: number,
  endBucket: number,
  bucketMs: number,
): Candle[] {
  const out: Candle[] = [];
  const n = h.length;
  for (let i = 0; i < n; i++) {
    const c = (h[i] as number) / (supply || 1);
    const o = i === 0 ? c : (out[i - 1] as Candle).c;
    out.push({
      t: endBucket - (n - 1 - i) * bucketMs,
      o,
      h: Math.max(o, c),
      l: Math.min(o, c),
      c,
      v: hv[i] ?? 0,
      n: 1,
    });
  }
  return out;
}

/** Roll fine candles up into `bucketMs` buckets (5 × 1m -> one 5m, and so on). */
export function aggregateCandles(candles: readonly Candle[], bucketMs: number): Candle[] {
  const out: Candle[] = [];
  for (const k of candles) {
    const t = bucketOf(k.t, bucketMs);
    const last = out[out.length - 1];
    if (last && last.t === t) {
      last.h = Math.max(last.h, k.h);
      last.l = Math.min(last.l, k.l);
      last.c = k.c;
      last.v += k.v;
      last.n += k.n;
      if (k.pending) last.pending = true;
    } else {
      out.push({ ...k, t });
    }
  }
  return out;
}

/** Sum of USD volume over the candles inside the trailing `windowMs`. */
export function volumeSince(candles: readonly Candle[], now: number, windowMs: number): number {
  let v = 0;
  for (const k of candles) if (k.t >= now - windowMs) v += k.v;
  return v;
}
