import { NET_INFO, nativeUnit, type Net } from '@stonkz/shared';
import { MaxTradeUsdExceededError } from './errors.js';

/**
 * `NET_INFO[net].maxTradeUsd`, enforced on the quote and prepare paths.
 *
 * `nativeAmount` is the trade's native leg in whole units — what the trader
 * pays on a buy, or what the curve returns on a sell. `usdPrice` is the
 * oracle's native price; when it is unavailable a USDC-gas net (Arc) still
 * has a price of exactly 1, and every other capped net refuses rather than
 * guessing, since an unknown price cannot prove the cap holds.
 */
export function assertUnderMaxTradeUsd(
  net: Net,
  nativeAmount: number,
  usdPrice: number | null,
): void {
  const cap = NET_INFO[net]?.maxTradeUsd;
  if (cap === undefined) return;
  const price = usdPrice ?? (nativeUnit(net) === 'USDC' ? 1 : null);
  if (price === null) {
    throw new MaxTradeUsdExceededError(net, Number.POSITIVE_INFINITY, cap);
  }
  const tradeUsd = nativeAmount * price;
  if (tradeUsd > cap) throw new MaxTradeUsdExceededError(net, round2(tradeUsd), cap);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
