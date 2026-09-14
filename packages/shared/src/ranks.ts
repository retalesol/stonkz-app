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

/** Confirmed trade, weighted by native notional — primary path to SP/crates. */
export function xpForTrade(nativeNotional: number): number {
  return Math.max(8, Math.round(nativeNotional * 50));
}

/** Launching a coin — modest; bonding (graduation as creator) is the big win. */
export const XP_LAUNCH = 50;

/** Creator bonus when their token bonds / graduates off the curve. */
export const XP_LAUNCH_BOND = 250;

/** @deprecated Cashback launch no longer doubles XP — use XP_LAUNCH. */
export const XP_CASHBACK_LAUNCH = 0;

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

/** Following someone — no XP (anti-farm); social XP is comments/likes only. */
export const XP_FOLLOW = 0;

/**
 * Wall comment / chat comment. First 5 comments per UTC day pay 1 XP each
 * (together with likes → 10 XP/day social cap).
 */
export const XP_COMMENT = 1;
export const XP_WALL_POST = XP_COMMENT;

/** Like a wall post. First 5 likes per UTC day pay 1 XP each. */
export const XP_LIKE = 1;

/** Max paying comments and likes per UTC day (each). */
export const SOCIAL_DAILY_CAP = 5;

/** Daily check-in SP for returning at least once every 24h (UTC day). */
export const XP_DAILY_CHECKIN = 10;

/** Holding a coin the moment it graduates. */
export const XP_GRADUATE = 250;

/** Holding a position through minus 25%. */
export const XP_DIAMOND_HANDS = 200;

/** Look up an achievement by key. `index.html:2178` */
export function achOf(k: AchievementKey): Achievement | null {
  for (const a of ACH) if (a.k === k) return a;
  return null;
}
