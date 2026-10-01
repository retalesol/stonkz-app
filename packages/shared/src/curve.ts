import {
  CIRC_FRACTION,
  CURVE_MC_BASE,
  CURVE_MC_COEFF,
  CURVE_MC_EXP,
  CURVE_START_MC,
  GRAD,
  LANE_GRAD_PCT,
  LANE_SOON_PCT,
  LIQ_FRACTION,
  SUPPLY,
} from './constants.js';
import type { Lane } from './types.js';

/** The subset of a coin the curve math reads. */
export interface CurveCoin {
  mc: number;
  supply?: number | undefined;
  seed?: number | undefined;
}

/**
 * Shared bonding-curve model so the launch preview and the launched coin agree.
 * Preview stand-in until Phase 2 locks CPMM virtual reserves with golden tests.
 * `index.html:3745`
 */
export function curveMc(sol: number): number {
  return CURVE_MC_BASE + CURVE_MC_COEFF * Math.pow(Math.max(0, sol), CURVE_MC_EXP);
}

/**
 * Bonding-curve fill as progress from launch floor → graduation.
 *
 * Virtual reserves imply ~$4.3K mcap at mint (`CURVE_START_MC`). Measuring
 * against `GRAD` alone made every empty launch look ~6% filled. Buys raise
 * mc (and fill); sells lower both.
 */
export function curve(c: Pick<CurveCoin, 'mc'>): number {
  const span = GRAD - CURVE_START_MC;
  // Guard against a misconfigured constants edit; unreachable with the shipped values.
  /* v8 ignore next */
  if (span <= 0) return c.mc >= GRAD ? 100 : 0;
  const raw = ((c.mc - CURVE_START_MC) / span) * 100;
  return Math.max(0, Math.min(100, raw));
}

/** Board lane from curve fill progress. `index.html:1132` */
export function laneOf(c: Pick<CurveCoin, 'mc'>): Lane {
  const v = curve(c);
  return v >= LANE_GRAD_PCT ? 'grad' : v >= LANE_SOON_PCT ? 'soon' : 'new';
}

/** USD price per token. `index.html:1134` */
export function price(c: CurveCoin): number {
  return c.mc / (c.supply || SUPPLY);
}

/** Simulated pool liquidity, USD. `index.html:1135` */
export function liq(c: Pick<CurveCoin, 'mc'>): number {
  return c.mc * LIQ_FRACTION;
}

/** Simulated 24h volume, USD. Deterministic in the coin's seed. `index.html:1136` */
export function vol24(c: { mc: number; seed: number }): number {
  return c.mc * (0.6 + (c.seed % 40) / 100);
}

/**
 * **Simulated** circulating supply: a flat 80% of supply, for sim coins only.
 * A live coin's circulating supply is what the curve has actually sold —
 * {@link circulatingSupply}, from the token detail's reserve figures. No live
 * code path may fall back to this fraction.
 * `index.html:1566`
 */
export function circ(c: Pick<CurveCoin, 'supply'>): number {
  return (c.supply || SUPPLY) * CIRC_FRACTION;
}

/** The reserve figures `GET /tokens/:sym` serves (`curveFacts` in the API). */
export interface CirculatingInputs {
  supply?: number | undefined;
  /** Tokens bought out of the curve so far — the API's own figure when present. */
  circulating?: number | undefined;
  /** Tokens still in the curve. */
  curveTokens?: number | undefined;
  /** Tokens parked for the graduation pool. */
  lpReserve?: number | undefined;
}

/**
 * Reserve-derived circulating supply for a live coin: the API's `circulating`
 * when it sent one, else `supply − lpReserve − curveTokens` when it sent the
 * reserves, else `null` — the caller shows "—". Never the simulation's 80%.
 */
export function circulatingSupply(c: CirculatingInputs): number | null {
  if (c.circulating !== undefined && Number.isFinite(c.circulating) && c.circulating >= 0) {
    return c.circulating;
  }
  if (
    c.supply !== undefined &&
    c.supply > 0 &&
    c.curveTokens !== undefined &&
    c.lpReserve !== undefined
  ) {
    return Math.max(0, c.supply - c.lpReserve - c.curveTokens);
  }
  return null;
}
