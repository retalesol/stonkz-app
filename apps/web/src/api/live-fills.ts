/**
 * Live fills on an open token page: which prints are new, which re-state one
 * already shown, and how a fill moves the 1m market-cap series.
 *
 * A trade reaches the page up to three times:
 *
 * 1. **local** — the trader's own wallet confirmed; `applyConfirmedTrade`
 *    shows it at once from the quote's numbers (no `fid` yet).
 * 2. **provisional** — `POST /trade/confirm` decoded the receipt at one
 *    confirmation and published it (`fid` = `${sig}:${ordinal}`), to the
 *    trader in the response and to everyone else over `token:{sym}`.
 * 3. **authoritative** — the indexer recorded it at its safe depth and
 *    published the same `fid`.
 *
 * Only the first of those may add a trade row, candle volume or a tape print;
 * the later ones replace numbers in place. A provisional fill the indexer
 * never confirms (reorged out) is found by {@link FillLedger.stale} and the
 * page re-reads REST, which only ever holds indexed fills.
 *
 * DOM-free so it can be unit tested (`live-fills.test.ts`).
 */

export const BUCKET_MS = 60_000;
/** Longest series the chart keeps, matching `onTokenEvent`'s old cap. */
export const MAX_POINTS = 240;

export type FillSource = 'local' | 'provisional' | 'authoritative';

export interface LiveFill {
  sig?: string | undefined;
  fid?: string | undefined;
  source: FillSource;
}

interface SigState {
  fids: Set<string>;
  /** Local prints not yet matched to a fid. */
  anon: number;
  final: boolean;
  firstAt: number;
}

/** Same normalisation `pushTrade` compares with: EVM hashes are case-insensitive, base58 is not. */
export function sigKey(sig: string): string {
  return /^0x/i.test(sig) ? sig.toLowerCase() : sig;
}

export class FillLedger {
  private readonly bySig = new Map<string, SigState>();

  /**
   * `'add'` when this fill is new to the page (add a row, add volume);
   * `'update'` when it re-states a fill already shown (replace numbers only).
   */
  admit(fill: LiveFill, now: number): 'add' | 'update' {
    if (!fill.sig) return 'add';
    const key = sigKey(fill.sig);
    let st = this.bySig.get(key);
    const known = st !== undefined;
    if (!st) {
      st = { fids: new Set(), anon: 0, final: false, firstAt: now };
      this.bySig.set(key, st);
    }
    if (fill.source === 'authoritative') st.final = true;

    if (fill.source === 'local') {
      // The provisional print beat the wallet's own confirmation poll.
      if (st.fids.size > 0) return 'update';
      st.anon++;
      return 'add';
    }
    if (!fill.fid) {
      // An indexer payload from before `fid` existed: best effort by sig.
      return known ? 'update' : 'add';
    }
    if (st.fids.has(fill.fid)) return 'update';
    st.fids.add(fill.fid);
    if (st.anon > 0) {
      st.anon--;
      return 'update';
    }
    return 'add';
  }

  /** True once the indexer has published this transaction. */
  isFinal(sig: string): boolean {
    return this.bySig.get(sigKey(sig))?.final === true;
  }

  /** Transactions shown before the indexer confirmed them, older than `ttlMs`. */
  stale(now: number, ttlMs: number): string[] {
    const out: string[] = [];
    for (const [sig, st] of this.bySig) {
      if (!st.final && now - st.firstAt >= ttlMs) out.push(sig);
    }
    return out;
  }

  /** Any fill still waiting on the indexer. */
  hasPending(): boolean {
    for (const st of this.bySig.values()) if (!st.final) return true;
    return false;
  }

  forget(sig: string): void {
    this.bySig.delete(sigKey(sig));
  }

  clear(): void {
    this.bySig.clear();
  }
}

/** Where the series' last point sits in time; `null` until candles or a fill anchor it. */
export interface SeriesAnchor {
  lastBucket: number | null;
}

export function bucketOf(t: number, bucketMs = BUCKET_MS): number {
  return Math.floor(t / bucketMs) * bucketMs;
}

/**
 * Moves the 1m market-cap series by one fill.
 *
 * A fill in the current bucket updates its close; a fill in a later bucket
 * opens a new candle (carrying the last close across any quiet minutes, as
 * `fillCandleGaps` does for REST candles). Only an `add` counts volume, so a
 * provisional print superseded by its authoritative twin is not counted twice.
 */
export function applyFillToSeries(
  h: number[],
  hv: number[],
  anchor: SeriesAnchor,
  fill: { t: number; mc: number; volUsd: number },
  add: boolean,
  bucketMs = BUCKET_MS,
  maxPoints = MAX_POINTS,
): void {
  const bucket = bucketOf(fill.t, bucketMs);
  const vol = add ? Math.max(0, fill.volUsd) : 0;
  if (h.length === 0 || anchor.lastBucket === null) {
    if (h.length === 0) {
      h.push(fill.mc);
      hv.push(vol);
    } else {
      h[h.length - 1] = fill.mc;
      hv[hv.length - 1] = (hv[hv.length - 1] ?? 0) + vol;
    }
    anchor.lastBucket = bucket;
    return;
  }
  if (bucket === anchor.lastBucket) {
    h[h.length - 1] = fill.mc;
    hv[hv.length - 1] = (hv[hv.length - 1] ?? 0) + vol;
    return;
  }
  if (bucket < anchor.lastBucket) {
    // Late print (block time a minute behind the local clock): its volume
    // belongs to that older candle; the close already moved on.
    const back = Math.round((anchor.lastBucket - bucket) / bucketMs);
    const idx = hv.length - 1 - back;
    if (idx >= 0) hv[idx] = (hv[idx] ?? 0) + vol;
    else hv[0] = (hv[0] ?? 0) + vol;
    return;
  }
  const prevClose = h[h.length - 1] as number;
  const gaps = Math.min(maxPoints, Math.round((bucket - anchor.lastBucket) / bucketMs) - 1);
  for (let i = 0; i < gaps; i++) {
    h.push(prevClose);
    hv.push(0);
  }
  h.push(fill.mc);
  hv.push(vol);
  anchor.lastBucket = bucket;
  while (h.length > maxPoints) {
    h.shift();
    hv.shift();
  }
}
