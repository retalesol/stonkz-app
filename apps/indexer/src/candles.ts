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

/**
 * Start of the bucket containing `atMs`.
 *
 * Every timeframe divides a UTC day exactly, and the epoch is UTC midnight, so
 * flooring against the interval lands on real UTC boundaries — no timezone
 * handling needed, and `1d` candles are true UTC days.
 */
export function bucketStart(tf: Timeframe, atMs: number): number {
  const size = TF_MS[tf];
  return Math.floor(atMs / size) * size;
}

export interface CandleUpdate {
  tf: Timeframe;
  bucketStart: number;
  /** USD per token at the launch snapshot price. */
  price: number;
  /** Base per token — the series of record (0027); `null` for a fill without a base figure. */
  priceBase: number | null;
  usdVolume: number;
  nativeVolume: number;
}

/** One trade fans out into one update per timeframe. */
export function candleUpdatesFor(
  atMs: number,
  price: number,
  usdVolume: number,
  nativeVolume: number,
  priceBase: number | null = null,
): CandleUpdate[] {
  return TIMEFRAMES.map((tf) => ({
    tf,
    bucketStart: bucketStart(tf, atMs),
    price,
    priceBase,
    usdVolume,
    nativeVolume,
  }));
}
