import {
  deriveCurve,
  freshState,
  type CurveParams,
  type CurveState,
} from '@stonkz/curve-sim';

/**
 * The slice of a `tokens` row the curve math reads. A structural subset
 * (rather than the Drizzle row type) so callers — routes, tests, the launch
 * flow before a row even exists — can pass a plain object.
 */
export interface CurveStateRow {
  tokenDecimals: number;
  baseDecimals: number;
  basePriceUsd1e6: string;
  curveTokensForSale: string;
  curveVirtualBase0: string;
  curveVirtualToken0: string;
  curveK: string;
  curveRealBase: string;
  curveRealToken: string;
  curveGradMcapBase: string;
}

/**
 * A row carries curve state once `/launch/confirm` (this phase) has written
 * it. Fixture-seeded rows from the read-path track (Phase 1.C) — and any row
 * from before this migration — have every curve column at its `'0'` default,
 * which `curveK === '0'` catches. `/quote` falls back to the older indicative
 * mc/supply approximation for those; see `router/compose.ts`.
 */
export function hasCurveState(row: CurveStateRow): boolean {
  return row.curveK !== '0';
}

/**
 * Reconstructs the *live* `CurveState` from the columns written at launch
 * plus the mutable real reserves, rather than storing live virtual reserves
 * redundantly. `virtualBase`/`virtualToken` move in lockstep with
 * `realBase`/`realToken` on every fill (`applyBuy`/`applySell` in
 * `@stonkz/curve-sim`), so the initial virtual reserves plus the current real
 * ones fully determine the current virtual ones:
 *
 *   virtualBase  = virtualBase0 + realBase
 *   virtualToken = virtualToken0 - (tokensForSale - realToken)
 *
 * Staleness caveat (see the phase report): these columns are only as fresh as
 * the last `/launch/confirm` or `/trade/prepare` that wrote them back. Nothing
 * in this phase re-syncs them from a live account read or from the indexer
 * decoding `Trade` events after the fact — that is flagged as follow-up work,
 * not silently assumed away. `minOut` (slippage) is what keeps a stale quote
 * safe to trade against regardless.
 */
export function liveCurveState(row: CurveStateRow): CurveState {
  const virtualBase0 = BigInt(row.curveVirtualBase0);
  const virtualToken0 = BigInt(row.curveVirtualToken0);
  const tokensForSale = BigInt(row.curveTokensForSale);
  const realBase = BigInt(row.curveRealBase);
  const realToken = BigInt(row.curveRealToken);
  const k = BigInt(row.curveK);
  return {
    virtualBase: virtualBase0 + realBase,
    virtualToken: virtualToken0 - (tokensForSale - realToken),
    realBase,
    realToken,
    k,
  };
}

/** The fixed parameters (as opposed to the mutable reserves) from a row. */
export function curveParamsFrom(row: CurveStateRow): CurveParams {
  const tokensForSale = BigInt(row.curveTokensForSale);
  const virtualToken0 = BigInt(row.curveVirtualToken0);
  return {
    tokensForSale,
    lpReserve: 0n, // not read back; not needed by any quote/trade path.
    virtualToken: virtualToken0,
    virtualBase: BigInt(row.curveVirtualBase0),
    k: BigInt(row.curveK),
    gradMcapBase: BigInt(row.curveGradMcapBase),
  };
}

/** Columns to persist for a freshly-derived curve, e.g. on `/launch/confirm`. */
export interface CurveStateColumns {
  tokenDecimals: number;
  baseDecimals: number;
  basePriceUsd1e6: string;
  curveTokensForSale: string;
  curveVirtualBase0: string;
  curveVirtualToken0: string;
  curveK: string;
  curveRealBase: string;
  curveRealToken: string;
  curveGradMcapBase: string;
}

/**
 * Derives a fresh curve for a launch and returns it both as the columns to
 * persist and as the live `CurveState` an immediate dev-buy can quote against.
 * Mirrors `create_token`'s on-chain math exactly (same `@stonkz/curve-sim`).
 */
export function deriveCurveColumns(
  supplyAtoms: bigint,
  basePrice1e6: bigint,
  baseDecimals: number,
  tokenDecimals: number,
): { params: CurveParams; state: CurveState; columns: CurveStateColumns } | null {
  const params = deriveCurve(supplyAtoms, basePrice1e6, baseDecimals);
  if (!params) return null;
  const state = freshState(params);
  return {
    params,
    state,
    columns: {
      tokenDecimals,
      baseDecimals,
      basePriceUsd1e6: basePrice1e6.toString(),
      curveTokensForSale: params.tokensForSale.toString(),
      curveVirtualBase0: params.virtualBase.toString(),
      curveVirtualToken0: params.virtualToken.toString(),
      curveK: params.k.toString(),
      curveRealBase: state.realBase.toString(),
      curveRealToken: state.realToken.toString(),
      curveGradMcapBase: params.gradMcapBase.toString(),
    },
  };
}

/** Columns to persist after a fill mutates the real reserves. */
export function nextStateColumns(next: CurveState): Pick<CurveStateColumns, 'curveRealBase' | 'curveRealToken'> {
  return { curveRealBase: next.realBase.toString(), curveRealToken: next.realToken.toString() };
}
