/**
 * DefiLlama's coins API — free, keyless, and it prices tokenized stocks
 * around the clock — as an off-chain USD source for stock-token launch bases
 * (`router/stock-price.ts`) and RWA crate rewards (`rwaUsdValue`).
 *
 * `GET {DEFILLAMA_COINS_URL}/prices/current/{coin,coin,…}?searchWidth=4h`,
 * each coin `chain:address` or `coingecko:<id>`; the answer is
 * `{ coins: { [id]: { price, symbol, timestamp, confidence, decimals? } } }`.
 * A price with `confidence < 0.9` or a `timestamp` older than 4 h is ignored.
 * Answers are cached 30 s per coin; a request is abandoned after 3 s (the
 * caller falls through to its next source — this never fails a request).
 */
import type { EvmNet } from '@stonkz/shared';
import type { Logger } from '../observability/logger.js';

export const DEFILLAMA_DEFAULT_URL = 'https://coins.llama.fi';
export const DEFILLAMA_MIN_CONFIDENCE = 0.9;
export const DEFILLAMA_MAX_AGE_SECONDS = 4 * 3600;
export const DEFILLAMA_CACHE_MS = 30_000;
export const DEFILLAMA_TIMEOUT_MS = 3_000;

/**
 * CoinGecko ids of each stock's Solana xStock, which DefiLlama prices 24/7 —
 * the fallback for any net whose own token DefiLlama does not list (every
 * testnet). Verified against the live API on 2026-09-29; `netflix-xstock`
 * returned nothing there, so NFLX has no off-chain source (Pyth / TWAP only).
 */
export const STOCK_COINGECKO_IDS: Readonly<Record<string, string>> = {
  TSLA: 'tesla-xstock',
  AMZN: 'amazon-xstock',
  PLTR: 'palantir-xstock',
  AMD: 'amd-xstock',
};

/**
 * DefiLlama's chain key for a net, when that deployment is one DefiLlama
 * indexes (mainnets only: `robinhood:` answers for RH 4663). `null` on a
 * testnet, whose tokens it cannot know.
 */
export function defiLlamaChainFor(net: EvmNet, chainId: number): string | null {
  if (net === 'RH' && chainId === 4663) return 'robinhood';
  if (net === 'BASE' && chainId === 8453) return 'base';
  return null;
}

/**
 * The coins to ask for a stock base, best first: the token itself on its own
 * chain (where DefiLlama indexes it), then the underlying's xStock.
 */
export function stockDefiLlamaCoins(
  net: EvmNet,
  chainId: number,
  symbol: string,
  token: string | null,
): string[] {
  const out: string[] = [];
  const chain = defiLlamaChainFor(net, chainId);
  if (chain && token) out.push(`${chain}:${token.toLowerCase()}`);
  const gecko = STOCK_COINGECKO_IDS[symbol.trim().toUpperCase()];
  if (gecko) out.push(`coingecko:${gecko}`);
  return out;
}

/** RWA crate catalog (`RWA_ASSETS`) → DefiLlama coin. NFLX: none (see above). */
export const RWA_DEFILLAMA_COINS: Readonly<Record<string, string>> = {
  PAXG: 'coingecko:pax-gold',
  ...Object.fromEntries(
    Object.entries(STOCK_COINGECKO_IDS).map(([sym, id]) => [sym, `coingecko:${id}`]),
  ),
};

export interface UsdPriceSource {
  /** USD price per coin id that answered with a usable price; others are absent. */
  prices(coins: readonly string[]): Promise<Map<string, number>>;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface DefiLlamaClientOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  cacheTtlMs?: number;
  timeoutMs?: number;
  logger?: Logger;
}

/** `chain:0xaddr` or `coingecko:<id>` — nothing that needs URL escaping. */
const COIN_ID = /^[a-z0-9-]+:[A-Za-z0-9-]+$/;

interface LlamaCoin {
  price?: unknown;
  timestamp?: unknown;
  confidence?: unknown;
}

export class DefiLlamaClient implements UsdPriceSource {
  private readonly cache = new Map<string, { at: number; usd: number | null }>();
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly opts: DefiLlamaClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFILLAMA_DEFAULT_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.cacheTtlMs ?? DEFILLAMA_CACHE_MS;
    this.timeoutMs = opts.timeoutMs ?? DEFILLAMA_TIMEOUT_MS;
  }

  async prices(coins: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const missing: string[] = [];
    const at = this.now();
    for (const coin of new Set(coins)) {
      if (!COIN_ID.test(coin)) continue;
      const hit = this.cache.get(coin);
      if (hit && at - hit.at < this.ttlMs) {
        if (hit.usd !== null) out.set(coin, hit.usd);
      } else {
        missing.push(coin);
      }
    }
    if (missing.length === 0) return out;

    const fetched = await this.fetchPrices(missing);
    if (fetched) {
      for (const coin of missing) {
        const usd = fetched.get(coin) ?? null;
        this.cache.set(coin, { at, usd });
        if (usd !== null) out.set(coin, usd);
      }
    }
    return out;
  }

  /** `null` on a transport failure (not cached, so the next call retries). */
  private async fetchPrices(coins: string[]): Promise<Map<string, number> | null> {
    const url = `${this.baseUrl}/prices/current/${coins.join(',')}?searchWidth=4h`;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`defillama timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
    });
    try {
      const res = await Promise.race([
        this.fetchImpl(url, { headers: { accept: 'application/json' }, signal: controller.signal }),
        timeout,
      ]);
      if (!res.ok) throw new Error(`defillama HTTP ${res.status}`);
      const body = (await Promise.race([res.json(), timeout])) as {
        coins?: Record<string, LlamaCoin>;
      };
      const nowSec = Math.floor(this.now() / 1000);
      const out = new Map<string, number>();
      for (const coin of coins) {
        const usd = usablePrice(body.coins?.[coin], nowSec);
        if (usd !== null) out.set(coin, usd);
        else if (body.coins?.[coin]) {
          this.opts.logger?.info('defillama: ignoring a low-confidence or stale price', { coin });
        }
      }
      return out;
    } catch (err) {
      this.opts.logger?.warn('defillama: no prices', {
        coins: coins.join(','),
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

function usablePrice(c: LlamaCoin | undefined, nowSec: number): number | null {
  if (!c) return null;
  const { price, timestamp, confidence } = c;
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return null;
  if (typeof timestamp !== 'number' || nowSec - timestamp > DEFILLAMA_MAX_AGE_SECONDS) return null;
  if (typeof confidence !== 'number' || confidence < DEFILLAMA_MIN_CONFIDENCE) return null;
  return price;
}

/** The first of `coins` (best first) that priced, or `null`. */
export async function firstUsdPrice(
  source: UsdPriceSource,
  coins: readonly string[],
): Promise<number | null> {
  if (coins.length === 0) return null;
  const prices = await source.prices(coins);
  for (const coin of coins) {
    const usd = prices.get(coin);
    if (usd !== undefined) return usd;
  }
  return null;
}

const clients = new Map<string, DefiLlamaClient>();

/** One cached client per `DEFILLAMA_COINS_URL`. */
export function defiLlamaClientFor(
  env: { defillamaCoinsUrl: string },
  logger?: Logger,
): DefiLlamaClient {
  let client = clients.get(env.defillamaCoinsUrl);
  if (!client) {
    client = new DefiLlamaClient({
      baseUrl: env.defillamaCoinsUrl,
      ...(logger ? { logger } : {}),
    });
    clients.set(env.defillamaCoinsUrl, client);
  }
  return client;
}

/** Tests: forget every cached client (and so every cached price). */
export function resetDefiLlamaClients(): void {
  clients.clear();
}

/**
 * USD value of `units` of an RWA crate asset (`RWA_ASSETS` key), from
 * DefiLlama; `null` when the asset has no coin mapping or no usable price.
 */
export async function rwaUsdValue(
  source: UsdPriceSource,
  asset: string,
  units: number,
): Promise<number | null> {
  const coin = RWA_DEFILLAMA_COINS[asset.trim().toUpperCase()];
  if (!coin || !Number.isFinite(units)) return null;
  const usd = await firstUsdPrice(source, [coin]);
  return usd === null ? null : usd * units;
}

export interface RwaUsdValues {
  /** Sum over the positions that priced; `null` when none did. */
  total: number | null;
  positions: { asset: string; units: number; usd: number | null }[];
}

/** {@link rwaUsdValue} for every position, in one DefiLlama request. */
export async function rwaUsdValues(
  source: UsdPriceSource,
  positions: readonly { asset: string; units: number }[],
): Promise<RwaUsdValues> {
  const coins = positions
    .map((p) => RWA_DEFILLAMA_COINS[p.asset.trim().toUpperCase()])
    .filter((c): c is string => !!c);
  const prices = coins.length > 0 ? await source.prices(coins) : new Map<string, number>();
  let total: number | null = null;
  const out = positions.map((p) => {
    const coin = RWA_DEFILLAMA_COINS[p.asset.trim().toUpperCase()];
    const usdEach = coin ? prices.get(coin) : undefined;
    const usd = usdEach !== undefined && Number.isFinite(p.units) ? usdEach * p.units : null;
    if (usd !== null) total = (total ?? 0) + usd;
    return { asset: p.asset, units: p.units, usd };
  });
  return { total, positions: out };
}
