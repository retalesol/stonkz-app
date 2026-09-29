import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  type Address,
  type Hex,
} from 'viem';
import type { PriceOracle } from '../chain/types.js';
import { JsonRpcError } from '../chain/jsonrpc.js';
import type { Logger } from '../observability/logger.js';
import { basePriceFor } from './base-price.js';
import { stockDefiLlamaCoins, type UsdPriceSource } from './defillama.js';
import {
  PYTH_EQUITY_FEED_IDS,
  PYTH_ETH_USD_FEED_ID,
  type HermesMultiUpdate,
  type HermesSource,
} from './evm-pyth.js';
import {
  STOCK_PRICE_CACHE_MS,
  resetStockPriceCaches,
  stockPriceCacheFor,
  stockPriceFor,
  type StockPriceContext,
} from './stock-price.js';
import { V3_POOL_ABI, tickToPrice, twapTickFromCumulatives } from './v3-pool-reads.js';

/**
 * Stock-base pricing with a fake RPC (factory + pool `observe`), a fake
 * Hermes and a fake DefiLlama: Pyth equity while fresh → DefiLlama → V3 TWAP
 * × ETH/USD → the static table, cached ~10 s.
 */

const WETH = '0x7943e237c7F95DA44E0301572D358911207852Fa';
const TSLA = '0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E';
const FACTORY = '0xdf9e3D6ffaC4513dD7b053212bbECcbCD15ec932';
const POOL = '0x00000000000000000000000000000000000b001e';
const TSLA_FEED = PYTH_EQUITY_FEED_IDS['TSLA']!;
const NOW_MS = 1_790_000_000_000;
const NOW_S = NOW_MS / 1000;
/** WETH (0x79…) is token0: 16 TSLA per WETH ⇒ tick ≈ ln 16 / ln 1.0001. */
const TICK = 27_726;

function spyLogger(): Logger & { warns: string[] } {
  const warns: string[] = [];
  const l: Logger & { warns: string[] } = {
    warns,
    debug: () => {},
    info: () => {},
    warn: (msg) => {
      warns.push(msg);
    },
    error: () => {},
    child: () => l,
  };
  return l;
}

interface FakeChain {
  ethCall(to: string, data: string): Promise<string>;
  calls: number;
}

function fakeChain(
  opts: { observe?: 'revert'; pool?: boolean; liquidity?: bigint } = {},
): FakeChain {
  const chain: FakeChain = {
    calls: 0,
    ethCall: async (to, data) => {
      chain.calls++;
      if (to.toLowerCase() === FACTORY.toLowerCase()) {
        return encodeAbiParameters(
          [{ type: 'address' }],
          [(opts.pool === false ? `0x${'0'.repeat(40)}` : POOL) as Address],
        );
      }
      if (to.toLowerCase() === POOL.toLowerCase()) {
        const call = decodeFunctionData({ abi: V3_POOL_ABI, data: data as Hex });
        if (call.functionName === 'liquidity') {
          return encodeFunctionResult({
            abi: V3_POOL_ABI,
            functionName: 'liquidity',
            result: opts.liquidity ?? 10n ** 20n,
          });
        }
        if (call.functionName === 'observe') {
          expect(call.args[0]).toEqual([1800, 0]);
          if (opts.observe === 'revert') throw new JsonRpcError(3, 'execution reverted: OLD');
          return encodeFunctionResult({
            abi: V3_POOL_ABI,
            functionName: 'observe',
            result: [
              [1_000_000n, 1_000_000n + BigInt(TICK) * 1800n],
              [0n, 0n],
            ],
          });
        }
      }
      throw new Error(`unexpected ${to} ${data.slice(0, 10)}`);
    },
  };
  return chain;
}

function fakeHermes(
  opts: { equityPublish?: number; down?: boolean } = {},
): HermesSource & { asked: Hex[][] } {
  const asked: Hex[][] = [];
  return {
    asked,
    latest: async () => null,
    latestMany: async (ids): Promise<HermesMultiUpdate | null> => {
      asked.push([...ids]);
      if (opts.down) return null;
      return {
        updateData: ['0x504e4155'],
        prices: [
          { feedId: PYTH_ETH_USD_FEED_ID, price1e6: 4_000_000_000n, publishTime: NOW_S - 2 },
          {
            feedId: TSLA_FEED,
            price1e6: 251_500_000n,
            publishTime: opts.equityPublish ?? NOW_S - 30,
          },
        ],
      };
    },
  };
}

function llama(usd: number | null): UsdPriceSource & { asked: string[][] } {
  const asked: string[][] = [];
  return {
    asked,
    prices: async (coins) => {
      asked.push([...coins]);
      return new Map(usd === null ? [] : [[coins[coins.length - 1]!, usd]]);
    },
  };
}

function ctx(over: Partial<StockPriceContext> = {}): StockPriceContext {
  return {
    net: 'RH',
    token: TSLA,
    weth: WETH,
    factory: FACTORY,
    hermes: fakeHermes({ equityPublish: NOW_S - 600 }),
    defiLlama: null,
    eth: fakeChain(),
    logger: spyLogger(),
    nowMs: NOW_MS,
    ...over,
  };
}

beforeEach(() => {
  resetStockPriceCaches();
});

describe('stockPriceFor', () => {
  it('uses the Pyth equity price while it is fresh (≤ 120 s), asked with ETH/USD in one call', async () => {
    const hermes = fakeHermes({ equityPublish: NOW_S - 120 });
    const p = await stockPriceFor(
      'TSLA',
      ctx({ hermes, defiLlama: { source: llama(260), coins: ['x:y'] } }),
    );
    expect(p).toMatchObject({ price1e6: 251_500_000n, source: 'pyth-equity', asOf: NOW_S - 120 });
    expect(hermes.asked).toEqual([[PYTH_ETH_USD_FEED_ID, TSLA_FEED]]);
  });

  it('falls to DefiLlama outside market hours, and reports how far it is from the pool TWAP', async () => {
    const source = llama(260);
    const p = await stockPriceFor(
      'TSLA',
      ctx({ defiLlama: { source, coins: ['coingecko:tesla-xstock'] } }),
    );
    expect(p?.source).toBe('defillama');
    expect(p?.price1e6).toBe(260_000_000n);
    expect(source.asked).toEqual([['coingecko:tesla-xstock']]);
    // TWAP ≈ $250: |260 − 250| / 260 ≈ 385 bps.
    expect(Number(p!.twap1e6!) / 1e6).toBeCloseTo(250, 1);
    expect(p?.divergenceBps).toBeGreaterThan(370);
    expect(p?.divergenceBps).toBeLessThan(400);
  });

  it('prices off the 30-min V3 TWAP × Hermes ETH/USD when neither Pyth nor DefiLlama answer', async () => {
    const p = await stockPriceFor(
      'TSLA',
      ctx({ defiLlama: { source: llama(null), coins: ['x:y'] } }),
    );
    expect(p?.source).toBe('v3-twap');
    expect(Number(p!.price1e6) / 1e6).toBeCloseTo(250, 1);
    expect(p?.divergenceBps).toBeNull();
  });

  it('uses the API ETH oracle for the TWAP leg when Hermes is down', async () => {
    const p = await stockPriceFor(
      'TSLA',
      ctx({ hermes: fakeHermes({ down: true }), ethUsdFallback: async () => 3_200 }),
    );
    expect(p?.source).toBe('v3-twap');
    expect(Number(p!.price1e6) / 1e6).toBeCloseTo(200, 1);
  });

  it.each([
    ['the pool cannot answer observe (OLD)', { observe: 'revert' as const }],
    ['there is no pool', { pool: false }],
  ])('falls to the static table, loudly, when %s', async (_, chainOpts) => {
    const logger = spyLogger();
    const p = await stockPriceFor('TSLA', ctx({ eth: fakeChain(chainOpts), logger }));
    expect(p).toMatchObject({ price1e6: 250_000_000n, source: 'static', asOf: null });
    expect(logger.warns.some((w) => /STATIC table/.test(w))).toBe(true);
  });

  it('caches an answer for ~10 s per net and symbol', async () => {
    const eth = fakeChain();
    const cache = stockPriceCacheFor(eth);
    const base = ctx({ eth, cache });
    await stockPriceFor('TSLA', base);
    const calls = eth.calls;
    await stockPriceFor('TSLA', { ...base, nowMs: NOW_MS + STOCK_PRICE_CACHE_MS - 1 });
    expect(eth.calls).toBe(calls);
    await stockPriceFor('TSLA', { ...base, nowMs: NOW_MS + STOCK_PRICE_CACHE_MS });
    expect(eth.calls).toBeGreaterThan(calls);
  });
});

describe('V3 TWAP math', () => {
  it('rounds a negative mean tick toward negative infinity, like OracleLibrary', () => {
    expect(twapTickFromCumulatives(0n, 3600n, 1800)).toBe(2);
    expect(twapTickFromCumulatives(0n, -3601n, 1800)).toBe(-3);
    expect(twapTickFromCumulatives(0n, -3600n, 1800)).toBe(-2);
  });

  it('orients the price by token order', () => {
    // WETH is token0 here: 1.0001^tick is TSLA per WETH.
    expect(tickToPrice(TICK, TSLA, WETH, 18, 18)).toBeCloseTo(1 / 16, 4);
    expect(tickToPrice(TICK, WETH, TSLA, 18, 18)).toBeCloseTo(16, 2);
  });
});

describe('stockDefiLlamaCoins', () => {
  it('asks for the token on an indexed mainnet first, then the xStock', () => {
    expect(stockDefiLlamaCoins('RH', 4663, 'TSLA', TSLA)).toEqual([
      `robinhood:${TSLA.toLowerCase()}`,
      'coingecko:tesla-xstock',
    ]);
  });

  it('uses only the coingecko id on testnet, and nothing for NFLX (unlisted)', () => {
    expect(stockDefiLlamaCoins('RH', 46630, 'amd', TSLA)).toEqual(['coingecko:amd-xstock']);
    expect(stockDefiLlamaCoins('RH', 46630, 'NFLX', TSLA)).toEqual([]);
  });
});

describe('basePriceFor', () => {
  const oracle: PriceOracle = { nativeUsd: vi.fn(async () => 4000) } as unknown as PriceOracle;

  it('sizes an RH stock base with the live pricer, not the static table', async () => {
    const live = await basePriceFor('RH', 'tsla', oracle, {
      stock: async () => ({
        price1e6: 358_400_000n,
        source: 'defillama',
        asOf: NOW_S,
        defiLlama1e6: 358_400_000n,
        twap1e6: 358_000_000n,
        divergenceBps: 12,
      }),
    });
    expect(live).toEqual({
      price1e6: 358_400_000n,
      baseDecimals: 18,
      source: 'defillama',
      divergenceBps: 12,
      // The lowest input: what a dev-buy floor is quoted at.
      floorPrice1e6: 358_000_000n,
    });
    await expect(
      basePriceFor('RH', 'TSLA', oracle, { stock: async () => null }),
    ).resolves.toBeNull();
  });

  it('answers the static table (decimals) without a pricer, and keeps the RH majors static', async () => {
    await expect(basePriceFor('RH', 'TSLA', oracle)).resolves.toMatchObject({
      price1e6: 250_000_000n,
      baseDecimals: 18,
      source: 'static',
    });
    await expect(basePriceFor('RH', 'BTC', oracle)).resolves.toEqual({
      price1e6: 95_000_000_000n,
      baseDecimals: 18,
    });
    // Base lists no stock bases yet.
    await expect(basePriceFor('BASE', 'TSLA', oracle)).resolves.toBeNull();
  });

  it('ignores the TWAP of an empty pool (placeholder price), like StockPriceSource', async () => {
    const p = await stockPriceFor(
      'TSLA',
      ctx({ eth: fakeChain({ liquidity: 0n }), defiLlama: { source: llama(260), coins: ['x:y'] } }),
    );
    expect(p?.source).toBe('defillama');
    expect(p?.twap1e6 ?? null).toBeNull();
    expect(p?.divergenceBps ?? null).toBeNull();
  });
});
