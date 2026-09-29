import { isEvm, isStockBase, nativeUnit, type Net } from '@stonkz/shared';
import type { PriceOracle } from '../chain/types.js';
import { STOCK_DECIMALS, staticStockPrice, type StockPrice } from './stock-price.js';

/**
 * `POST /launch/prepare` needs a USD price for the chosen base asset to
 * derive the $69K graduation curve. Natives come from `PriceOracle`; USD
 * stables are $1; EVM stock-token bases are priced live by
 * `router/stock-price.ts` (Pyth equity → V3 TWAP × ETH/USD → static, the
 * inputs `StockPriceSource` uses on-chain); the remaining RH majors use a
 * static USD table that must match what `PushPriceSource` was seeded with on
 * testnet (see `script/PushBasePrices.s.sol`).
 */

const USD_STABLES = new Set(['USDC', 'USDT', 'USDG']);

/**
 * Indicative whole-USD prices for the RH testnet *major* bases (1e0 dollars).
 * Stock bases are not here: they are priced live (`router/stock-price.ts`).
 */
const RH_MAJOR_USD: Record<string, number> = {
  BTC: 95_000,
  SOL: 180,
  XRP: 0.6,
  DOGE: 0.15,
  ADA: 0.7,
  AVAX: 35,
  LINK: 15,
  LTC: 90,
};

export interface BasePriceInfo {
  price1e6: bigint;
  baseDecimals: number;
  /** For an EVM stock base: where the price came from. */
  source?: StockPrice['source'];
  /** For an EVM stock base: DefiLlama vs on-chain TWAP, bps, when both are known. */
  divergenceBps?: number | null;
  /**
   * For an EVM stock base: the lowest of the prices seen (chosen, DefiLlama,
   * TWAP). A lower base price means fewer tokens per base on a fresh curve,
   * so a dev-buy floor quoted at it holds whichever input the chain uses.
   */
  floorPrice1e6?: bigint;
}

export interface BasePriceOptions {
  /**
   * Live pricer for EVM stock bases (`stockPricer`). Omitted, a stock base
   * answers the static table — fine for its decimals, never for sizing a
   * curve: every sizing caller passes one.
   */
  stock?: ((symbol: string) => Promise<StockPrice | null>) | null;
}

function nativeDecimals(net: Net): number {
  return net === 'SOL' ? 9 : 18;
}

/** `null` when this phase has no price source for the symbol — callers must reject the launch, not guess. */
export async function basePriceFor(
  net: Net,
  baseSymbol: string,
  oracle: PriceOracle,
  opts: BasePriceOptions = {},
): Promise<BasePriceInfo | null> {
  const sym = baseSymbol.toUpperCase();
  const native = nativeUnit(net);
  const wrapped = net === 'SOL' ? 'WSOL' : 'WETH';

  if (sym === native || sym === wrapped) {
    const usd = await oracle.nativeUsd(native);
    if (!Number.isFinite(usd) || usd <= 0) return null;
    return { price1e6: BigInt(Math.round(usd * 1e6)), baseDecimals: nativeDecimals(net) };
  }
  if (USD_STABLES.has(sym)) {
    // USDG is 6 decimals on RH; USDC/USDT treated as 6 for curve sizing.
    return { price1e6: 1_000_000n, baseDecimals: 6 };
  }
  if (isEvm(net) && isStockBase(net, sym)) {
    const price = opts.stock ? await opts.stock(sym) : staticStockPrice(sym);
    return price
      ? {
          price1e6: price.price1e6,
          baseDecimals: STOCK_DECIMALS,
          source: price.source,
          divergenceBps: price.divergenceBps ?? null,
          floorPrice1e6: [price.defiLlama1e6, price.twap1e6].reduce<bigint>(
            (lo, p) => (p != null && p > 0n && p < lo ? p : lo),
            price.price1e6,
          ),
        }
      : null;
  }
  if (net === 'RH' && RH_MAJOR_USD[sym] !== undefined) {
    const usd = RH_MAJOR_USD[sym]!;
    return { price1e6: BigInt(Math.round(usd * 1e6)), baseDecimals: 18 };
  }
  return null;
}
