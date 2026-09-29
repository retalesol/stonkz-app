import {
  type Stake,
  type StakePoolSummary,
  chainLockMult,
  circ,
  poolFrac as poolFracOf,
  rng,
  stakeMult,
  stakedFrac as stakedFracOf,
  yourShare as yourShareOf,
} from '@stonkz/shared';
import { type SimCoin, bySym } from './coins.js';
import { USER } from './user.js';

/**
 * Per-memecoin staking.
 *
 * The pool is funded exclusively from the creator's 69% bucket — platform 15%,
 * `$STONKZ` buyback 10% and the RWA crate fund 6% never enter it. Phase 4.B moves escrow, weights and
 * `poolFrac` on-chain; the shapes here are what `GET /stake/:sym` will fill.
 * `index.html:1574`
 */

export function stakeOf(sym: string): Stake | null {
  return USER.stake?.[sym] ?? null;
}

export function ensureStake(sym: string): Stake {
  if (!USER.stake) USER.stake = {};
  const existing = USER.stake[sym];
  if (existing) return existing;
  const fresh: Stake = { amt: 0, mult: 1, days: 0, until: 0, rewTok: 0, rewSol: 0 };
  USER.stake[sym] = fresh;
  return fresh;
}

/**
 * Everyone else's stake. Sim invents a pool so the fee pie looks lived-in.
 * Live mode returns 0 until the indexer fills real pool weight — inventing
 * a random fraction here would look like on-chain stake that does not exist.
 */
export function otherStake(c: SimCoin): number {
  if ((import.meta.env['VITE_API_MODE'] as string) === 'live') return 0;
  if (c._oth === undefined) c._oth = circ(c) * (0.05 + rng(c.seed + 404)() * 0.28);
  return c._oth;
}

/**
 * Live pool totals per coin, from `GET /tokens/:sym/staking` (indexer, or a
 * chain read while the pool is fresh). When present they replace the sandbox
 * arithmetic below: FLEX stake is parked (no weight, not in the pool
 * fraction), which `poolFrac` over `totalStaked` cannot express.
 */
const POOLS: Record<string, StakePoolSummary> = {};

export function setStakePool(sym: string, pool: StakePoolSummary): void {
  POOLS[sym] = pool;
}

export function stakePoolOf(sym: string): StakePoolSummary | null {
  return POOLS[sym] ?? null;
}

/** The position's pool weight: the chain's own figure when we have it. */
function weightOf(st: Stake | null): number {
  if (!st || !st.amt) return 0;
  if (st.weight !== undefined) return st.weight;
  return st.source ? st.amt * chainLockMult(st.days) : st.amt * stakeMult(st);
}

export function totalStaked(c: SimCoin): number {
  const pool = stakePoolOf(c.sym);
  if (pool) return pool.totalStaked;
  const st = stakeOf(c.sym);
  return otherStake(c) + (st ? st.amt : 0);
}

export function totalWeight(c: SimCoin): number {
  const pool = stakePoolOf(c.sym);
  if (pool) return pool.totalWeight;
  const st = stakeOf(c.sym);
  return otherStake(c) + weightOf(st);
}

export function stakedFrac(c: SimCoin): number {
  const pool = stakePoolOf(c.sym);
  if (pool) return pool.stakedFrac;
  return stakedFracOf(c, totalStaked(c));
}

/** Share of the 69% creator bucket that goes to stakers. Caps at 0.5. */
export function poolFrac(c: SimCoin): number {
  const pool = stakePoolOf(c.sym);
  if (pool) return pool.bucketShare;
  return poolFracOf(c, totalStaked(c));
}

export function yourShare(c: SimCoin): number {
  const st = stakeOf(c.sym);
  if (!st || !st.amt) return 0;
  return yourShareOf(weightOf(st), totalWeight(c));
}

export interface StakedPosition {
  c: SimCoin;
  st: Stake;
}

/** Positions worth rendering: staked, or with rewards not yet claimed. `index.html:1593` */
export function stakedList(): StakedPosition[] {
  const out: StakedPosition[] = [];
  if (!USER.stake) return out;
  for (const sym of Object.keys(USER.stake)) {
    const st = USER.stake[sym];
    if (!st) continue;
    if (st.amt > 0 || st.rewTok > 0.0001 || st.rewSol > 0.000001 || (st.rewBase ?? 0) > 0) {
      const c = bySym(sym);
      if (c) out.push({ c, st });
    }
  }
  return out;
}
