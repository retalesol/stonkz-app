import type { Net } from '@stonkz/shared';
import type { RedisLike } from './types.js';

export interface QuoteCacheKey {
  net: Net;
  side: 'buy' | 'sell';
  /** Always the native unit — SOL on Solana, ETH on Robinhood. */
  nativeAmount: number;
  baseMint: string;
  sym: string;
  /**
   * Curve reserve fingerprint (`realBase:realToken`). Required so a post-buy
   * sync cannot serve an 8s-cached quote sized against empty reserves.
   */
  reserves: string;
}

/**
 * Plan step 59: TTL is 8 seconds and the key includes net + side + native
 * amount + base mint. The UI's `qdrain` bar is the same 8 seconds, so a cached
 * quote is never shown as fresher than the bar claims.
 */
export const QUOTE_CACHE_TTL_SECONDS = 8;

/**
 * The native amount is quantised before it reaches the key. Without this the
 * cache never hits: the trade box emits amounts like 0.5000000001 and every
 * keystroke would mint a new entry. Nine decimals is lamport precision, which
 * is finer than any amount a human types.
 */
export function quantiseNativeAmount(amount: number): string {
  return amount.toFixed(9);
}

export function quoteCacheKey(k: QuoteCacheKey): string {
  return [
    'quote',
    k.net,
    k.sym.toUpperCase(),
    k.side,
    quantiseNativeAmount(k.nativeAmount),
    k.baseMint,
    k.reserves,
  ].join(':');
}

export interface CachedQuote<T> {
  value: T;
  /** Epoch ms the quote goes stale — drives the 8s bar client-side. */
  expiresAt: number;
}

export class QuoteCache {
  constructor(
    private readonly redis: RedisLike,
    private readonly ttlSeconds: number = QUOTE_CACHE_TTL_SECONDS,
    private readonly now: () => number = Date.now,
  ) {}

  async get<T>(key: QuoteCacheKey): Promise<CachedQuote<T> | null> {
    const raw = await this.redis.get(quoteCacheKey(key));
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as CachedQuote<T>;
    } catch {
      return null;
    }
  }

  async set<T>(key: QuoteCacheKey, value: T): Promise<CachedQuote<T>> {
    const entry: CachedQuote<T> = { value, expiresAt: this.now() + this.ttlSeconds * 1000 };
    await this.redis.set(quoteCacheKey(key), JSON.stringify(entry), {
      ttlSeconds: this.ttlSeconds,
    });
    return entry;
  }

  /**
   * Read-through. `produce` runs only on a miss, which is what keeps the
   * aggregator call rate off the keystroke rate.
   */
  async wrap<T>(key: QuoteCacheKey, produce: () => Promise<T>): Promise<CachedQuote<T>> {
    const hit = await this.get<T>(key);
    if (hit && hit.expiresAt > this.now()) return hit;
    return this.set(key, await produce());
  }
}
