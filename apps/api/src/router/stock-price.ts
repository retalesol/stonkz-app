/**
 * USD prices for stock-token launch bases (RH TSLA/AMZN/PLTR/NFLX/AMD, and
 * whatever `BASE_STOCKS` lists later), from the same inputs the contracts'
 * `StockPriceSource` uses — so the curve `/launch/prepare` sizes and previews
 * is the curve the chain will build, 24/7:
 *
 * 1. **Pyth equity** (Hermes), while it is fresh — `publish_time` within
 *    {@link EQUITY_FRESH_SECONDS}. US market hours only.
 * 2. Otherwise **DefiLlama** (`router/defillama.ts`): the token on its own
 *    chain where DefiLlama indexes it, else the underlying's xStock — priced
 *    24/7.
 * 3. Otherwise the WETH/stock **Uniswap V3 30-minute TWAP**
 *    (`observe([1800, 0])`) × **ETH/USD** from the same Hermes call (the
 *    API's own ETH oracle if Hermes has none).
 * 4. Otherwise the static indicative table — a last resort, logged at `warn`
 *    every time it is used, since it drifts from the market.
 *
 * The TWAP is read whenever it can be, even when a better source wins, so
 * `divergenceBps` can compare DefiLlama with the price the chain will
 * actually use (`/launch/prepare` refuses `stock_price_diverged` past
 * `STOCK_PRICE_MAX_DIVERGENCE_BPS`).
 *
 * One Hermes request carries both feeds (and is the very update
 * `planRouterLaunch` then submits — the Hermes client caches it). Answers are
 * cached ~10 s per net + symbol.
 */
import type { Address, Hex } from 'viem';
import type { EvmNet } from '@stonkz/shared';
import type { Logger } from '../observability/logger.js';
import {
  PYTH_ETH_USD_FEED_ID,
  hermesPriceOf,
  hermesUpdateFor,
  pythEquityFeedFor,
  type HermesSource,
} from './evm-pyth.js';
import { firstUsdPrice, type UsdPriceSource } from './defillama.js';
import {
  DEFAULT_STOCK_POOL_FEE,
  STOCK_TWAP_SECONDS,
  tickToPrice,
  v3GetPool,
  v3Liquidity,
  v3TwapTick,
  type V3EthCaller,
} from './v3-pool-reads.js';

/** A Pyth equity update older than this is market-closed / stale. */
export const EQUITY_FRESH_SECONDS = 120;
/** How long one stock price answer is reused. */
export const STOCK_PRICE_CACHE_MS = 10_000;

/**
 * Indicative whole-USD prices, used **only** when neither Pyth nor the pool
 * can price a stock base (and to answer its decimals). Matches what
 * `PushPriceSource` was seeded with on testnet (`script/PushBasePrices.s.sol`),
 * the contract's own last resort.
 */
export const STOCK_STATIC_USD: Readonly<Record<string, number>> = {
  TSLA: 250,
  AMZN: 200,
  PLTR: 40,
  NFLX: 700,
  AMD: 160,
  AAPL: 220,
  NVDA: 120,
  MSFT: 420,
  GOOGL: 180,
  META: 550,
  COIN: 220,
  HOOD: 40,
  SPY: 560,
  QQQ: 480,
  MSTR: 350,
  CRCL: 100,
  GLD: 240,
  INTC: 25,
  KO: 65,
  GME: 25,
};

/** Every EVM stock token is an 18-decimal ERC-20 (RH testnet pins, `BASE_STOCKS`). */
export const STOCK_DECIMALS = 18;
const WETH_DECIMALS = 18;

/** Mirrors StockPriceSource's testnet `minLiquidity` (1e17). */
export const STOCK_POOL_MIN_LIQUIDITY = 10n ** 17n;

export type StockPriceSourceKind = 'pyth-equity' | 'defillama' | 'v3-twap' | 'static';

export interface StockPrice {
  price1e6: bigint;
  source: StockPriceSourceKind;
  /** Pyth `publish_time` (equity) or the read time, unix seconds; `null` for static. */
  asOf: number | null;
  /** DefiLlama's price, when it had one. */
  defiLlama1e6?: bigint | null;
  /** The on-chain TWAP × ETH/USD, when the pool answered. */
  twap1e6?: bigint | null;
  /** `|DefiLlama − TWAP| / DefiLlama`, bps, when both are known. */
  divergenceBps?: number | null;
}

export interface StockPriceContext {
  net: EvmNet;
  /** The stock token's address on `net`. */
  token: string;
  weth: string | null;
  factory: string;
  /** WETH/stock pool fee tier (default 3000). */
  poolFee?: number;
  hermes: HermesSource | null;
  /** DefiLlama and the coins to ask it for, best first (`stockDefiLlamaCoins`). */
  defiLlama?: { source: UsdPriceSource; coins: readonly string[] } | null;
  eth: V3EthCaller | undefined;
  /** The API's spot ETH/USD, for the TWAP leg when Hermes has no ETH price. */
  ethUsdFallback?: () => Promise<number>;
  logger: Logger;
  nowMs: number;
  /** Per-deployment cache; see {@link stockPriceCacheFor}. */
  cache?: StockPriceCache;
}

export type StockPriceCache = Map<string, { at: number; value: StockPrice | null }>;

let caches = new WeakMap<object, StockPriceCache>();

/** One cache per owner (the net's RPC client), so tests with fresh fakes never share. */
export function stockPriceCacheFor(owner: object): StockPriceCache {
  let c = caches.get(owner);
  if (!c) {
    c = new Map();
    caches.set(owner, c);
  }
  return c;
}

/** Tests: forget every cached stock price. */
export function resetStockPriceCaches(): void {
  caches = new WeakMap();
}

function toPrice1e6(usd: number): bigint | null {
  if (!Number.isFinite(usd) || usd <= 0) return null;
  const v = BigInt(Math.round(usd * 1e6));
  return v > 0n ? v : null;
}

export function staticStockPrice(symbol: string): StockPrice | null {
  const usd = STOCK_STATIC_USD[symbol.trim().toUpperCase()];
  const price1e6 = usd === undefined ? null : toPrice1e6(usd);
  return price1e6 ? { price1e6, source: 'static', asOf: null } : null;
}

/**
 * The stock base's USD price (see the module comment for the order), or
 * `null` when nothing — not even the static table — can price it.
 */
export async function stockPriceFor(
  symbol: string,
  ctx: StockPriceContext,
): Promise<StockPrice | null> {
  const sym = symbol.trim().toUpperCase();
  const key = `${ctx.net}:${sym}:${ctx.token.toLowerCase()}`;
  const hit = ctx.cache?.get(key);
  if (hit && ctx.nowMs - hit.at < STOCK_PRICE_CACHE_MS) return hit.value;
  const value = await resolveStockPrice(sym, ctx);
  ctx.cache?.set(key, { at: ctx.nowMs, value });
  return value;
}

async function resolveStockPrice(sym: string, ctx: StockPriceContext): Promise<StockPrice | null> {
  const nowSec = Math.floor(ctx.nowMs / 1000);
  const equityFeed = pythEquityFeedFor(sym);
  const feeds: Hex[] = equityFeed ? [PYTH_ETH_USD_FEED_ID, equityFeed] : [PYTH_ETH_USD_FEED_ID];
  const [update, llamaUsd] = await Promise.all([
    ctx.hermes ? hermesUpdateFor(ctx.hermes, feeds) : Promise.resolve(null),
    ctx.defiLlama
      ? firstUsdPrice(ctx.defiLlama.source, ctx.defiLlama.coins).catch(() => null)
      : Promise.resolve(null),
  ]);
  const defiLlama1e6 = llamaUsd === null ? null : toPrice1e6(llamaUsd);
  const twap1e6 = await twapPrice(sym, ctx, hermesPriceOf(update, PYTH_ETH_USD_FEED_ID)?.price1e6);
  const divergenceBps =
    defiLlama1e6 !== null && twap1e6 !== null
      ? Number(
          ((defiLlama1e6 > twap1e6 ? defiLlama1e6 - twap1e6 : twap1e6 - defiLlama1e6) * 10_000n) /
            defiLlama1e6,
        )
      : null;
  const extra = { defiLlama1e6, twap1e6, divergenceBps };

  // 1. Pyth equity, while fresh.
  const equity = equityFeed ? hermesPriceOf(update, equityFeed) : null;
  if (equity && equity.price1e6 > 0n && nowSec - equity.publishTime <= EQUITY_FRESH_SECONDS) {
    return { price1e6: equity.price1e6, source: 'pyth-equity', asOf: equity.publishTime, ...extra };
  }
  // 2. DefiLlama.
  if (defiLlama1e6 !== null) {
    return { price1e6: defiLlama1e6, source: 'defillama', asOf: nowSec, ...extra };
  }
  // 3. V3 TWAP (stock in WETH) × ETH/USD.
  if (twap1e6 !== null) return { price1e6: twap1e6, source: 'v3-twap', asOf: nowSec, ...extra };

  // 4. The static table, loudly.
  const fallback = staticStockPrice(sym);
  ctx.logger.warn(
    'stock-price: no Pyth equity, DefiLlama or pool TWAP; using the STATIC table price',
    {
      net: ctx.net,
      base: sym,
      equityAgeS: equity ? nowSec - equity.publishTime : null,
      staticUsd: STOCK_STATIC_USD[sym] ?? null,
    },
  );
  return fallback ? { ...fallback, ...extra } : null;
}

async function twapPrice(
  sym: string,
  ctx: StockPriceContext,
  hermesEthUsd1e6: bigint | undefined,
): Promise<bigint | null> {
  if (!ctx.eth || !ctx.weth) return null;
  let wethPerStock: number;
  try {
    const pool = await v3GetPool(
      ctx.eth,
      ctx.factory,
      ctx.weth,
      ctx.token,
      ctx.poolFee ?? DEFAULT_STOCK_POOL_FEE,
    );
    if (!pool) {
      ctx.logger.warn('stock-price: no WETH pool for the stock base', { net: ctx.net, base: sym });
      return null;
    }
    // Same floor as StockPriceSource's `minLiquidity`: an empty or dust pool
    // sits at its placeholder price and must not be read as a market.
    const liquidity = await v3Liquidity(ctx.eth, pool);
    if (liquidity < STOCK_POOL_MIN_LIQUIDITY) {
      ctx.logger.info('stock-price: pool below the liquidity floor; TWAP ignored', {
        net: ctx.net,
        base: sym,
        liquidity: liquidity.toString(),
      });
      return null;
    }
    const tick = await v3TwapTick(ctx.eth, pool, STOCK_TWAP_SECONDS);
    wethPerStock = tickToPrice(tick, ctx.token, ctx.weth, STOCK_DECIMALS, WETH_DECIMALS);
  } catch (err) {
    ctx.logger.warn('stock-price: pool TWAP unavailable', {
      net: ctx.net,
      base: sym,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  let ethUsd = hermesEthUsd1e6 !== undefined ? Number(hermesEthUsd1e6) / 1e6 : NaN;
  if (!(ethUsd > 0) && ctx.ethUsdFallback) {
    ethUsd = await ctx.ethUsdFallback().catch(() => NaN);
    if (ethUsd > 0) {
      ctx.logger.info('stock-price: Hermes has no ETH/USD; TWAP priced with the API ETH oracle', {
        net: ctx.net,
        base: sym,
      });
    }
  }
  if (!(ethUsd > 0)) return null;
  return toPrice1e6(wethPerStock * ethUsd);
}

/** Convenience: the `StockPriceContext` bits that do not change per call. */
export interface StockPriceDeps {
  hermes: HermesSource | null;
  defiLlama?: UsdPriceSource | null;
  /** DefiLlama coins for a stock (`stockDefiLlamaCoins` bound to the net). */
  defiLlamaCoins?: (symbol: string, token: string) => string[];
  eth: V3EthCaller | undefined;
  weth: string | null;
  factory: string;
  feeTierFor: (symbol: string, token: string) => number;
  ethUsdFallback?: () => Promise<number>;
  logger: Logger;
  now: () => number;
  cache?: StockPriceCache;
}

/** Binds {@link stockPriceFor} to one net's deps; `mintFor` resolves the stock's address. */
export function stockPricer(
  net: EvmNet,
  deps: StockPriceDeps,
  mintFor: (symbol: string) => string | null,
): (symbol: string) => Promise<StockPrice | null> {
  return async (symbol) => {
    const token = mintFor(symbol);
    if (!token) return null;
    return stockPriceFor(symbol, {
      net,
      token: token as Address,
      weth: deps.weth,
      factory: deps.factory,
      poolFee: deps.feeTierFor(symbol, token),
      hermes: deps.hermes,
      defiLlama:
        deps.defiLlama && deps.defiLlamaCoins
          ? { source: deps.defiLlama, coins: deps.defiLlamaCoins(symbol, token) }
          : null,
      eth: deps.eth,
      ...(deps.ethUsdFallback ? { ethUsdFallback: deps.ethUsdFallback } : {}),
      logger: deps.logger,
      nowMs: deps.now(),
      ...(deps.cache ? { cache: deps.cache } : {}),
    });
  };
}
