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
 * Circulating supply.
 *
 * TODO(Phase 4): this becomes curve-reserve-derived. The hard-coded 80% is a
 * simulation artifact and must not survive into production — see the plan's
 * "what must never ship" list (`circ = 80%` after Phase 4).
 * `index.html:1566`
 */
export function circ(c: Pick<CurveCoin, 'supply'>): number {
  return (c.supply || SUPPLY) * CIRC_FRACTION;
}
