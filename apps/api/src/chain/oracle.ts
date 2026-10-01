import type { Hex } from 'viem';
import type { NativeUnit } from '@stonkz/shared';
import type { Alert, AlertHook } from '../observability/metrics.js';
import type { Logger } from '../observability/logger.js';
import type { RedisLike } from '../redis/types.js';
import type { FetchLike, PriceOracle } from './types.js';

/**
 * The footer's native USD price.
 *
 * `index.html` hardcodes `$214.08`; the plan's step 53 replaces it with a real
 * SOLUSD / ETHUSD read. The HTTP shape below matches Coinbase's public spot
 * endpoint because it needs no key, and `PRICE_ORACLE_URL` can be repointed at
 * Pyth or an internal aggregator without touching call sites.
 */
export interface HttpPriceOracleOptions {
  baseUrl: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/**
 * Coinbase spot product per native unit. `null` means "no feed": USDC is the
 * unit of account itself, so Arc's native price is 1 USD by definition and is
 * never fetched (a depeg would be a product decision, not an oracle read).
 */
const PRODUCT: Record<NativeUnit, string | null> = { SOL: 'SOL-USD', ETH: 'ETH-USD', USDC: null };

export class HttpPriceOracle implements PriceOracle {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: HttpPriceOracleOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.timeoutMs = opts.timeoutMs ?? 4000;
  }

  async nativeUsd(unit: NativeUnit): Promise<number> {
    const product = PRODUCT[unit];
    if (product === null) return 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/${product}/spot`, {
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`price oracle HTTP ${res.status}`);
      const body = (await res.json()) as { data?: { amount?: string } };
      const amount = Number.parseFloat(body.data?.amount ?? '');
      if (!Number.isFinite(amount) || amount <= 0)
        throw new Error('price oracle returned no amount');
      return amount;
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface CachedPriceOracleOptions {
  /**
   * How long the in-memory last-good price may stand in for a failing
   * source (default 5 min). Past it the failure surfaces: a launch sized
   * from an hour-old price is worse than one refused.
   */
  lastGoodMaxAgeMs?: number;
  now?: () => number;
}

/**
 * Caches spot prices in Redis so a board full of USD figures does not fan out
 * into one oracle call per request, and so a short oracle outage degrades to
 * a slightly stale price instead of a blank footer — for at most
 * `lastGoodMaxAgeMs`, after which the inner error is the answer.
 */
export class CachedPriceOracle implements PriceOracle {
  private readonly lastGood = new Map<NativeUnit, { usd: number; at: number }>();
  private readonly lastGoodMaxAgeMs: number;
  private readonly now: () => number;

  constructor(
    private readonly inner: PriceOracle,
    private readonly redis: RedisLike,
    private readonly ttlSeconds: number = 30,
    opts: CachedPriceOracleOptions = {},
  ) {
    this.lastGoodMaxAgeMs = opts.lastGoodMaxAgeMs ?? 5 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  async nativeUsd(unit: NativeUnit): Promise<number> {
    const key = `oracle:native:${unit}`;
    const cached = await this.redis.get(key);
    if (cached !== null) {
      const parsed = Number.parseFloat(cached);
      if (Number.isFinite(parsed)) return parsed;
    }
    try {
      const price = await this.inner.nativeUsd(unit);
      this.lastGood.set(unit, { usd: price, at: this.now() });
      await this.redis.set(key, String(price), { ttlSeconds: this.ttlSeconds });
      return price;
    } catch (err) {
      const fallback = this.lastGood.get(unit);
      if (fallback !== undefined && this.now() - fallback.at <= this.lastGoodMaxAgeMs) {
        return fallback.usd;
      }
      throw err;
    }
  }
}

/* ------------------------------------------------------------ Pyth Hermes */

/** Pyth Core ETH/USD — the same feed `router/evm-pyth.ts` submits with launches. */
export const PYTH_ETH_USD_FEED: Hex =
  '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace';
/** Pyth Core SOL/USD. */
export const PYTH_SOL_USD_FEED: Hex =
  '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';

const PYTH_FEED: Record<NativeUnit, Hex | null> = {
  ETH: PYTH_ETH_USD_FEED,
  SOL: PYTH_SOL_USD_FEED,
  USDC: null,
};

/**
 * The slice of `router/evm-pyth.ts`'s `HermesSource` this oracle needs: one
 * feed's parsed price (`price1e6`, Pyth `publish_time`). `HermesClient`
 * implements it (Bearer `PYTH_HERMES_API_KEY`, ~5 s cache, 4 s timeout), and
 * the unit tests pass a fake.
 */
export interface HermesPriceReader {
  latest(feedId: Hex): Promise<{ price1e6: bigint; publishTime: number } | null>;
}

export interface PythHermesNativeOracleOptions {
  hermes: HermesPriceReader;
  /** A `publish_time` older than this is refused (default 60 s). */
  maxAgeSeconds?: number;
  now?: () => number;
}

/**
 * ETH/USD and SOL/USD from Pyth Hermes (`/v2/updates/price/latest`), the
 * second native price source next to Coinbase spot. Refuses a stale
 * publish time rather than answer yesterday's price: `MedianPriceOracle`
 * then falls through to whoever else answered.
 */
export class PythHermesNativeOracle implements PriceOracle {
  private readonly hermes: HermesPriceReader;
  private readonly maxAgeSeconds: number;
  private readonly now: () => number;

  constructor(opts: PythHermesNativeOracleOptions) {
    this.hermes = opts.hermes;
    this.maxAgeSeconds = opts.maxAgeSeconds ?? 60;
    this.now = opts.now ?? Date.now;
  }

  async nativeUsd(unit: NativeUnit): Promise<number> {
    const feed = PYTH_FEED[unit];
    if (feed === null) return 1;
    const update = await this.hermes.latest(feed);
    if (!update) throw new Error(`pyth hermes returned no ${unit}/USD price`);
    const ageS = Math.floor(this.now() / 1000) - update.publishTime;
    if (ageS > this.maxAgeSeconds) {
      throw new Error(`pyth hermes ${unit}/USD is stale (${ageS}s > ${this.maxAgeSeconds}s)`);
    }
    const usd = Number(update.price1e6) / 1e6;
    if (!Number.isFinite(usd) || usd <= 0)
      throw new Error(`pyth hermes ${unit}/USD is not positive`);
    return usd;
  }
}

/* ------------------------------------------------------------- composite */

export interface PriceSource {
  /** Stable label for logs and alerts (`coinbase`, `pyth`). */
  name: string;
  oracle: PriceOracle;
}

export interface MedianPriceOracleOptions {
  /** Prefer this source's answer when the sources disagree (default: the first). */
  preferred?: string;
  /** Sources disagreeing by more than this (relative to the median) alert and defer to `preferred` (default 2 %). */
  maxDivergenceBps?: number;
  /** Per-source wait before an answer is treated as missing (default 5 s). */
  timeoutMs?: number;
  /** How long a last-good price may be served when every source is down (default 5 min). */
  lastGoodMaxAgeMs?: number;
  onAlert?: AlertHook;
  logger?: Logger;
  now?: () => number;
}

/**
 * Median-of-sources with failover:
 *
 * - two or more sources answer and agree within `maxDivergenceBps` → the
 *   median (with two answers, their mean);
 * - they disagree → the preferred source's answer (Pyth, in `deps.ts`), and
 *   an edge-triggered `oracle-divergence:<unit>` alert;
 * - one answers → that one;
 * - none → the last good answer while it is under `lastGoodMaxAgeMs`, else
 *   the error — never a stale price for real money.
 *
 * Every source is asked concurrently; a slow one is cut at `timeoutMs` so a
 * hung provider degrades to "one answered", not to a slow quote.
 */
export class MedianPriceOracle implements PriceOracle {
  private readonly preferred: string;
  private readonly maxDivergenceBps: number;
  private readonly timeoutMs: number;
  private readonly lastGoodMaxAgeMs: number;
  private readonly onAlert: AlertHook;
  private readonly logger: Logger | undefined;
  private readonly now: () => number;
  private readonly lastGood = new Map<NativeUnit, { usd: number; at: number }>();
  private readonly diverging = new Set<NativeUnit>();

  constructor(
    private readonly sources: readonly PriceSource[],
    opts: MedianPriceOracleOptions = {},
  ) {
    if (sources.length === 0) throw new Error('MedianPriceOracle needs at least one source');
    this.preferred = opts.preferred ?? sources[0]!.name;
    this.maxDivergenceBps = opts.maxDivergenceBps ?? 200;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.lastGoodMaxAgeMs = opts.lastGoodMaxAgeMs ?? 5 * 60_000;
    this.onAlert = opts.onAlert ?? (() => {});
    this.logger = opts.logger;
    this.now = opts.now ?? Date.now;
  }

  async nativeUsd(unit: NativeUnit): Promise<number> {
    const settled = await Promise.all(
      this.sources.map(async (s) => {
        try {
          const usd = await this.withTimeout(s.oracle.nativeUsd(unit), s.name);
          if (!Number.isFinite(usd) || usd <= 0) throw new Error(`${s.name} returned ${usd}`);
          return { name: s.name, usd, err: null as string | null };
        } catch (err) {
          return { name: s.name, usd: NaN, err: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
    const answers = settled.filter((r) => r.err === null);
    const failures = settled.filter((r) => r.err !== null);
    if (failures.length > 0 && answers.length > 0) {
      this.logger?.warn('price oracle: a source did not answer', {
        unit,
        failed: failures.map((f) => `${f.name}: ${f.err}`),
      });
    }

    if (answers.length === 0) {
      const last = this.lastGood.get(unit);
      if (last && this.now() - last.at <= this.lastGoodMaxAgeMs) {
        this.logger?.error('price oracle: every source failed; serving last good', {
          unit,
          ageMs: this.now() - last.at,
          failed: failures.map((f) => `${f.name}: ${f.err}`),
        });
        return last.usd;
      }
      throw new Error(
        `no native price for ${unit}: ${failures.map((f) => `${f.name}: ${f.err}`).join('; ')}`,
      );
    }

    const usd = answers.length === 1 ? answers[0]!.usd : this.combine(unit, answers);
    this.lastGood.set(unit, { usd, at: this.now() });
    return usd;
  }

  private combine(unit: NativeUnit, answers: { name: string; usd: number }[]): number {
    const median = medianOf(answers.map((a) => a.usd));
    const spreadBps = Math.max(
      ...answers.map((a) => Math.round((Math.abs(a.usd - median) / median) * 10_000)),
    );
    const diverged = spreadBps > this.maxDivergenceBps;
    this.edge(unit, diverged, { spreadBps, answers });
    if (!diverged) return median;
    const preferred = answers.find((a) => a.name === this.preferred);
    return preferred ? preferred.usd : median;
  }

  /** One alert per transition, like `Metrics.edge`. */
  private edge(
    unit: NativeUnit,
    active: boolean,
    detail: { spreadBps: number; answers: { name: string; usd: number }[] },
  ): void {
    const was = this.diverging.has(unit);
    const fields = {
      unit,
      spreadBps: detail.spreadBps,
      maxDivergenceBps: this.maxDivergenceBps,
      preferred: this.preferred,
      ...Object.fromEntries(detail.answers.map((a) => [a.name, a.usd])),
    };
    const message = `${unit}/USD price sources disagree`;
    let alert: Alert | null = null;
    if (active && !was) {
      this.diverging.add(unit);
      alert = { key: `oracle-divergence:${unit}`, severity: 'warn', message, fields };
    } else if (!active && was) {
      this.diverging.delete(unit);
      alert = {
        key: `oracle-divergence:${unit}`,
        severity: 'warn',
        message: `RESOLVED: ${message}`,
        fields,
      };
    }
    if (alert) this.onAlert(alert);
  }

  private withTimeout<T>(p: Promise<T>, name: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${name} timed out after ${this.timeoutMs}ms`)),
        this.timeoutMs,
      );
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }
}

/** The median of `values` (the mean of the middle two for an even count). */
export function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
