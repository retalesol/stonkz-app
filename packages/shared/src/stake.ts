import { circ, type CurveCoin } from './curve.js';
import type { Stake } from './types.js';

/** Lock weight, but only while the lock is still running. `index.html:1575` */
export function stakeMult(st: Stake | null | undefined, now: number = Date.now()): number {
  return st && st.until && st.until > now ? st.mult : 1;
}

/**
 * Staked tokens as a fraction of circulating supply, capped at 1.
 * `totalStaked` is supplied by the caller (chain state from Phase 4, the
 * simulated `otherStake` + the user's position today). `index.html:1582`
 */
export function stakedFrac(c: Pick<CurveCoin, 'supply'>, totalStaked: number): number {
  return Math.min(1, totalStaked / Math.max(1, circ(c)));
}

/**
 * Fraction of the 70% creator bucket that goes to memecoin stakers.
 * Half of the staked fraction, so at most 0.5 — stakers can never take more
 * than half the creator bucket (35% of the curve fee). `index.html:1583`
 */
export function poolFrac(c: Pick<CurveCoin, 'supply'>, totalStaked: number): number {
  return 0.5 * stakedFrac(c, totalStaked);
}

/**
 * A staker's share of the pool: their lock-weighted amount over the pool's
 * total weight. `index.html:1584`
 */
export function yourShare(yourWeight: number, totalWeight: number): number {
  if (!yourWeight) return 0;
  return totalWeight ? yourWeight / totalWeight : 0;
}
