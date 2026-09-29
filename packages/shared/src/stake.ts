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
 * Fraction of the 60% creator bucket that goes to memecoin stakers.
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

/**
 * Pool weight per lock term, in basis points of the staked amount — the
 * programs' `CurveMath.lockWeightBps` (EVM) and `LOCK_WEIGHT_BPS` (Solana).
 *
 * FLEX is **zero** on chain: a 0-day position parks tokens but carries no
 * weight and is excluded from the pool fraction, so it earns nothing. `LOCKS`
 * shows 1x for FLEX, which is the sandbox's display chrome, not pool weight.
 */
export const CHAIN_LOCK_WEIGHT_BPS: Readonly<Record<number, number>> = {
  0: 0,
  1: 11_000,
  7: 12_500,
  30: 15_000,
  90: 25_000,
  180: 50_000,
  365: 80_000,
};

/** The on-chain weight multiplier for a lock term; 0 for FLEX or an unknown term. */
export function chainLockMult(days: number): number {
  return (CHAIN_LOCK_WEIGHT_BPS[days] ?? 0) / 10_000;
}

/**
 * The stakers' share of the 69% creator bucket, exactly as both programs'
 * `splitCreatorBucket` computes it: `eligibleStaked / (2 * circulating)`,
 * capped at one half. FLEX stake is not eligible and must not be passed in.
 */
export function stakerBucketShare(eligibleStaked: number, circulating: number): number {
  if (!(eligibleStaked > 0) || !(circulating > 0)) return 0;
  return Math.min(0.5, eligibleStaked / (2 * circulating));
}

/**
 * Tokens the owner may unstake right now. Both programs refuse any unstake
 * while `lockUntil` is in the future, and allow any amount up to the whole
 * position once it has passed (FLEX's lock ends the second it starts).
 */
export function unstakeableAmount(
  st: Pick<Stake, 'amt' | 'until'> | null | undefined,
  now: number = Date.now(),
): number {
  if (!st || !(st.amt > 0)) return 0;
  return st.until > now ? 0 : st.amt;
}
