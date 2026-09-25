import type { NativeUnit } from '@stonkz/shared';
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

const PRODUCT: Record<NativeUnit, string> = { SOL: 'SOL-USD', ETH: 'ETH-USD' };

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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/${PRODUCT[unit]}/spot`, {
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

/**
 * Caches spot prices in Redis so a board full of USD figures does not fan out
 * into one oracle call per request, and so an oracle outage degrades to a
 * slightly stale price instead of a blank footer.
 */
export class CachedPriceOracle implements PriceOracle {
  private readonly lastGood = new Map<NativeUnit, number>();

  constructor(
    private readonly inner: PriceOracle,
    private readonly redis: RedisLike,
    private readonly ttlSeconds: number = 30,
  ) {}

  async nativeUsd(unit: NativeUnit): Promise<number> {
    const key = `oracle:native:${unit}`;
    const cached = await this.redis.get(key);
    if (cached !== null) {
      const parsed = Number.parseFloat(cached);
      if (Number.isFinite(parsed)) return parsed;
    }
    try {
      const price = await this.inner.nativeUsd(unit);
      this.lastGood.set(unit, price);
      await this.redis.set(key, String(price), { ttlSeconds: this.ttlSeconds });
      return price;
    } catch (err) {
      const fallback = this.lastGood.get(unit);
      if (fallback !== undefined) return fallback;
      throw err;
    }
  }
}
