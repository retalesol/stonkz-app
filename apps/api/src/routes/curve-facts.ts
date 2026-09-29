import { mcapBase } from '@stonkz/curve-sim';
import type { tokens } from '../db/schema.js';
import { hasCurveState, liveCurveState } from '../router/curve-state.js';

type TokenRow = typeof tokens.$inferSelect;

/** Atoms (as the text columns store them) to whole units, integer and fraction split so 6182e18 reads back as exactly 6182. */
export function whole(atoms: bigint, decimals: number): number {
  const scale = 10n ** BigInt(Math.max(0, decimals));
  return Number(atoms / scale) + Number(atoms % scale) / Number(scale);
}

/**
 * What the curve holds right now, in whole units, from the row's CPMM
 * columns. `null` for fixture rows that never got curve state.
 *
 * Everything here is in the **base asset**: that is what the chain graduates
 * on (`gradMcapBase`, fixed in base units), so `fillPct` never drifts with
 * the ETH/SOL price. USD is a presentation layer on top — `mcBase × the live
 * base price` (`routes/live-base-usd.ts`), Pump.fun style — and `baseUsd`
 * here is only the launch-time snapshot the legacy `mc` columns were priced
 * at, kept for the fallback conversion of rows the indexer wrote before 0027.
 */
export interface CurveFacts {
  /** Market cap in the base asset (ETH / SOL / USDC …). */
  mcBase: number;
  /** Base the curve really holds — what sells can drain. */
  realBase: number;
  /** Tokens still in the curve. */
  realToken: number;
  tokensForSale: number;
  /** Tokens bought out of the curve so far. */
  circulating: number;
  /** Tokens parked for the graduation pool (supply less the curve's allotment). */
  lpReserve: number;
  /** USD per whole base unit at launch (the oracle snapshot). */
  baseUsd: number;
  /** Graduation cap in base units. */
  gradBase: number;
  /** Fill toward graduation, 0–100, measured the way the chain does (base terms). */
  fillPct: number;
  /** `mcBase >= gradBase`: the oracle-trigger graduation condition, in base terms. */
  atGraduation: boolean;
}

export function curveFacts(row: TokenRow): CurveFacts | null {
  if (!hasCurveState(row)) return null;
  try {
    const state = liveCurveState(row);
    const supplyAtoms = BigInt(Math.round(row.supply)) * 10n ** BigInt(row.tokenDecimals);
    const tokensForSale = BigInt(row.curveTokensForSale);
    const gradBaseAtoms = BigInt(row.curveGradMcapBase);
    const mcBaseAtoms = mcapBase(state, supplyAtoms);
    const startBaseAtoms =
      (BigInt(row.curveVirtualBase0) * supplyAtoms) / BigInt(row.curveVirtualToken0 || '1');
    const span = gradBaseAtoms > startBaseAtoms ? gradBaseAtoms - startBaseAtoms : 0n;
    const fill =
      span > 0n
        ? Number(((mcBaseAtoms - startBaseAtoms) * 1_000_000n) / span) / 10_000
        : mcBaseAtoms >= gradBaseAtoms
          ? 100
          : 0;
    const lpAtoms = supplyAtoms > tokensForSale ? supplyAtoms - tokensForSale : 0n;
    const soldAtoms = tokensForSale > state.realToken ? tokensForSale - state.realToken : 0n;
    return {
      mcBase: whole(mcBaseAtoms, row.baseDecimals),
      realBase: whole(state.realBase, row.baseDecimals),
      realToken: whole(state.realToken, row.tokenDecimals),
      tokensForSale: whole(tokensForSale, row.tokenDecimals),
      circulating: whole(soldAtoms, row.tokenDecimals),
      lpReserve: whole(lpAtoms, row.tokenDecimals),
      baseUsd: Number(BigInt(row.basePriceUsd1e6 || '0')) / 1e6,
      gradBase: whole(gradBaseAtoms, row.baseDecimals),
      fillPct: Math.max(0, Math.min(100, fill)),
      atGraduation: gradBaseAtoms > 0n && mcBaseAtoms >= gradBaseAtoms,
    };
  } catch {
    return null;
  }
}

/** USD per whole base unit the row's legacy USD columns were priced at; 0 when the row has no snapshot. */
export function snapshotBaseUsd(row: Pick<TokenRow, 'basePriceUsd1e6'>): number {
  const raw = row.basePriceUsd1e6;
  if (!raw || raw === '0' || !/^[0-9]+$/.test(raw)) return 0;
  return Number(BigInt(raw)) / 1e6;
}

/**
 * The row's cap in base units: the persisted column (written per fill by the
 * indexer, backfilled by 0027), else the live curve reserves, else — for a
 * row whose USD cap predates the column — the snapshot conversion. `0` for a
 * fixture row without any price, which keeps its `mc` as plain USD.
 */
export function rowMcBase(row: TokenRow): number {
  if (typeof row.mcBase === 'number' && row.mcBase > 0) return row.mcBase;
  const facts = curveFacts(row);
  if (facts && facts.mcBase > 0) return facts.mcBase;
  const snap = snapshotBaseUsd(row);
  return snap > 0 && row.mc > 0 ? row.mc / snap : 0;
}
