import { nativeUnit, type Net } from '@stonkz/shared';
import type { PriceOracle } from '../chain/types.js';

/**
 * `POST /launch/prepare` needs a USD price for the chosen base asset to
 * derive the $69K graduation curve. Natives come from `PriceOracle`; USD
 * stables are $1; RH stock / other bases use a static USD table that must
 * match what `PushPriceSource` was seeded with on testnet (see
 * `script/PushBasePrices.s.sol`).
 */

const USD_STABLES = new Set(['USDC', 'USDT', 'USDG']);

/** Indicative whole-USD prices for RH testnet launch bases (1e0 dollars). */
const RH_BASE_USD: Record<string, number> = {
  BTC: 95_000,
  SOL: 180,
  XRP: 0.6,
  DOGE: 0.15,
  ADA: 0.7,
  AVAX: 35,
  LINK: 15,
  LTC: 90,
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

export interface BasePriceInfo {
  price1e6: bigint;
  baseDecimals: number;
}

function nativeDecimals(net: Net): number {
  return net === 'SOL' ? 9 : 18;
}

/** `null` when this phase has no price source for the symbol — callers must reject the launch, not guess. */
export async function basePriceFor(
  net: Net,
  baseSymbol: string,
  oracle: PriceOracle,
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
  if (net === 'RH' && RH_BASE_USD[sym] !== undefined) {
    const usd = RH_BASE_USD[sym]!;
    return { price1e6: BigInt(Math.round(usd * 1e6)), baseDecimals: 18 };
  }
  return null;
}
