/**
 * Gap-fill candle closes so the chart's time axis does not compress quiet
 * periods. Each missing 1m (or other) bucket inherits the previous close with
 * zero volume.
 */

export interface CandlePoint {
  t: number;
  c: number;
  v: number;
}

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
