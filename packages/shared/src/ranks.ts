import { ACH, RANKS, type Achievement } from './constants.js';
import type { AchievementKey } from './types.js';

export interface RankInfo {
  /** Zero-based rank index. The UI shows `LV i + 1`. */
  i: number;
  name: string;
  /** XP at which this rank starts. */
  cur: number;
  /** XP at which the next rank starts, `null` at max rank. */
  next: number | null;
  /** Progress into the current rank, 0–100. */
  pct: number;
  /** XP remaining to the next rank, 0 at max rank. */
  toNext: number;
}

/** Resolve an XP total to a rank. `index.html:2112` */
export function rankOf(xp: number): RankInfo {
  let i = 0;
  RANKS.forEach((rank, k) => {
    if (xp >= rank[1]) i = k;
  });
  const row = RANKS[i] as (typeof RANKS)[number];
  const cur = row[1];
  const nextRow = RANKS[i + 1] as (typeof RANKS)[number] | undefined;
  const next = nextRow ? nextRow[1] : null;
  return {
    i,
    name: row[0],
    cur,
    next,
    pct: next === null ? 100 : Math.max(0, Math.min(100, ((xp - cur) / (next - cur)) * 100)),
    toNext: next === null ? 0 : next - xp,
  };
}

/**
 * Local calendar day key, `YYYY-M-D` with no zero padding — kept byte-identical
 * to the sim so persisted streaks survive the port. The Phase 3 ledger switches
 * to server UTC days. `index.html:2155`
 */
export function dayKey(d: Date = new Date()): string {
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

/** Streak multiplier: day 1 = 1.00x, day 7 and beyond = 1.30x. `index.html:2156` */
export function xpMult(streak: number | null | undefined): number {
  return 1 + Math.min(6, Math.max(0, (streak || 1) - 1)) * 0.05;
}

/** XP awarded is the base amount scaled by the streak, rounded. `index.html:2144` */
export function applyXpMult(baseXp: number, streak: number | null | undefined): number {
  return Math.round(baseXp * xpMult(streak));
}

/** Confirmed trade, weighted by native notional. `index.html:1974` */
export function xpForTrade(nativeNotional: number): number {
  return Math.max(5, Math.round(nativeNotional * 40));
}

/** Launching a coin. `index.html:3967` */
export const XP_LAUNCH = 150;

/** Launching with cashback instead of a dev buy pays the launch amount again. */
export const XP_CASHBACK_LAUNCH = 150;

/** Claiming creator fees, weighted by the native total. `index.html:3047` */
export function xpForFeeClaim(nativeTotal: number): number {
  return Math.max(10, Math.round(nativeTotal * 30));
}

/** Staking, weighted against circulating supply. `index.html:3177` */
export function xpForStake(amount: number, circulating: number): number {
  return Math.max(5, Math.round((amount / Math.max(1, circulating)) * 400));
}

/** Claiming staking rewards. `index.html:3203` */
export const XP_STAKE_CLAIM = 12;

/** Following someone. `index.html:3270` */
export const XP_FOLLOW = 6;

/** Posting on a wall. `index.html:3332` */
export const XP_WALL_POST = 8;

/** Holding a coin the moment it graduates. */
export const XP_GRADUATE = 250;

/** Holding a position through minus 25%. */
export const XP_DIAMOND_HANDS = 200;

/** Look up an achievement by key. `index.html:2178` */
export function achOf(k: AchievementKey): Achievement | null {
  for (const a of ACH) if (a.k === k) return a;
  return null;
}
