import {
  type Stake,
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
 * The pool is funded exclusively from the creator's 70% bucket — protocol 20%
 * and `$STONKZ` ops 10% never enter it. Phase 4.B moves escrow, weights and
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

export function totalStaked(c: SimCoin): number {
  const st = stakeOf(c.sym);
  return otherStake(c) + (st ? st.amt : 0);
}

export function totalWeight(c: SimCoin): number {
  const st = stakeOf(c.sym);
  return otherStake(c) + (st ? st.amt * stakeMult(st) : 0);
}

export function stakedFrac(c: SimCoin): number {
  return stakedFracOf(c, totalStaked(c));
}

/** Share of the 70% creator bucket that goes to stakers. Caps at 0.5. */
export function poolFrac(c: SimCoin): number {
  return poolFracOf(c, totalStaked(c));
}

export function yourShare(c: SimCoin): number {
  const st = stakeOf(c.sym);
  if (!st || !st.amt) return 0;
  return yourShareOf(st.amt * stakeMult(st), totalWeight(c));
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
    if (st.amt > 0 || st.rewTok > 0.0001 || st.rewSol > 0.000001) {
      const c = bySym(sym);
      if (c) out.push({ c, st });
    }
  }
  return out;
}
