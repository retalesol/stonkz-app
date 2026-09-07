import { nativeUnit, type Net } from '@stonkz/shared';
import type { PriceOracle } from '../chain/types.js';

/**
 * `POST /launch/prepare` needs a USD price for the chosen base asset to
 * derive the curve (`@stonkz/curve-sim`'s `deriveCurve` sizes the $69K
 * graduation cap off it). `chain/types.ts`'s `PriceOracle` only ever priced
 * the two native gas tokens (`nativeUsd(unit)`) — nothing in Phase 1 needed
 * more — so this phase does not invent a general price feed for every
 * `MAJORS`/`STOCKS` entry `router/base-mints.ts` knows an address for.
 *
 * **Known, documented gap**: only the two native units and the two USD
 * stablecoins below are launch-able base assets in this phase. Every other
 * `MAJORS`/`STOCKS` symbol (`BONK`, `JUP`, tokenized stocks, …) is rejected by
 * `/launch/prepare` with `base_mint_not_allowed` even though
 * `router/base-mints.ts` has an address for several of them — the address is
 * necessary but not sufficient without a price. A real deploy needs a price
 * feed (Pyth/Switchboard on Solana, Chainlink/the RH oracle contract on
 * Robinhood — see `programs/evm/ASSUMPTIONS.md`'s heartbeat note) wired in
 * here before those symbols can launch against.
 */

const USD_STABLES = new Set(['USDC', 'USDT']);

export interface BasePriceInfo {
  price1e6: bigint;
  baseDecimals: number;
}

function nativeDecimals(net: Net): number {
  return net === 'SOL' ? 9 : 18;
}

/** `null` when this phase has no price source for the symbol — callers must reject the launch, not guess. */
export async function basePriceFor(net: Net, baseSymbol: string, oracle: PriceOracle): Promise<BasePriceInfo | null> {
  const sym = baseSymbol.toUpperCase();
  const native = nativeUnit(net);
  const wrapped = net === 'SOL' ? 'WSOL' : 'WETH';

  if (sym === native || sym === wrapped) {
    const usd = await oracle.nativeUsd(native);
    if (!Number.isFinite(usd) || usd <= 0) return null;
    return { price1e6: BigInt(Math.round(usd * 1e6)), baseDecimals: nativeDecimals(net) };
  }
  if (USD_STABLES.has(sym)) {
    return { price1e6: 1_000_000n, baseDecimals: 6 };
  }
  return null;
}
