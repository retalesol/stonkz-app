import type { CrateTier } from './types.js';

/**
 * SP level → crate inventory grants.
 *
 * SP mirrors XP 1:1 from most awards. Rhodium (L20) sits at **250,000 SP** —
 * roughly 5,000 SOL of curve volume at `xpForTrade` (`native × 50`), which at
 * a 1% curve fee yields ~50 SOL gross fees and ~10 SOL to protocol (20%).
 * Opening any crate starts a **global** cooldown equal to that tier's `cd`.
 */
export type CrateGrant = Partial<Record<CrateTier, number>>;

export interface SpLevelDef {
  readonly level: number;
  /** Lifetime SP required (inclusive). */
  readonly sp: number;
  readonly grants: CrateGrant;
}

/**
 * Twenty levels stretched to a long-horizon Rhodium unlock.
 * Early levels still drip Bronze/Iron so new traders feel progress.
 */
export const SP_LEVELS = [
  { level: 1, sp: 0, grants: { BRONZE: 2 } },
  { level: 2, sp: 250, grants: { BRONZE: 2 } },
  { level: 3, sp: 750, grants: { BRONZE: 1, IRON: 1 } },
  { level: 4, sp: 1_800, grants: { IRON: 2 } },
  { level: 5, sp: 3_500, grants: { IRON: 1, SILVER: 1 } },
  { level: 6, sp: 6_500, grants: { SILVER: 2 } },
  { level: 7, sp: 11_000, grants: { SILVER: 1, GOLD: 1 } },
  { level: 8, sp: 18_000, grants: { GOLD: 1, BRONZE: 2 } },
  { level: 9, sp: 28_000, grants: { GOLD: 2 } },
  { level: 10, sp: 42_000, grants: { GOLD: 1, PLATINUM: 1 } },
  { level: 11, sp: 60_000, grants: { PLATINUM: 1, IRON: 2 } },
  { level: 12, sp: 85_000, grants: { PLATINUM: 1, GOLD: 1 } },
  { level: 13, sp: 115_000, grants: { PLATINUM: 2 } },
  { level: 14, sp: 145_000, grants: { IRIDIUM: 1, SILVER: 2 } },
  { level: 15, sp: 175_000, grants: { IRIDIUM: 1, GOLD: 1 } },
  { level: 16, sp: 200_000, grants: { IRIDIUM: 1, PLATINUM: 1 } },
  { level: 17, sp: 220_000, grants: { PALLADIUM: 1, GOLD: 2 } },
  { level: 18, sp: 235_000, grants: { PALLADIUM: 1, PLATINUM: 1 } },
  { level: 19, sp: 245_000, grants: { PALLADIUM: 1, IRIDIUM: 1 } },
  { level: 20, sp: 250_000, grants: { RHODIUM: 1, GOLD: 2 } },
] as const satisfies readonly SpLevelDef[];

export interface SpLevelInfo {
  level: number;
  sp: number;
  /** SP at which this level started. */
  cur: number;
  /** SP required for the next level, or null at max. */
  next: number | null;
  pct: number;
  toNext: number;
  /** Grants awarded when this level was (or will be) claimed. */
  grants: CrateGrant;
}

/** Highest level whose `sp` threshold is ≤ `totalSp`. */
export function spLevelOf(totalSp: number): SpLevelInfo {
  let i = 0;
  for (let k = 0; k < SP_LEVELS.length; k++) {
    if (totalSp >= SP_LEVELS[k]!.sp) i = k;
  }
  const row = SP_LEVELS[i]!;
  const nextRow = SP_LEVELS[i + 1];
  const next = nextRow ? nextRow.sp : null;
  return {
    level: row.level,
    sp: totalSp,
    cur: row.sp,
    next,
    pct: next === null ? 100 : Math.max(0, Math.min(100, ((totalSp - row.sp) / (next - row.sp)) * 100)),
    toNext: next === null ? 0 : Math.max(0, next - totalSp),
    grants: { ...row.grants },
  };
}

/** Every level definition with `sp <= totalSp` (for catch-up grants). */
export function spLevelsReached(totalSp: number): readonly SpLevelDef[] {
  return SP_LEVELS.filter((l) => totalSp >= l.sp);
}

/** Preview of the next unclaimed level's grants, or null at max. */
export function nextSpLevelGrants(totalSp: number): SpLevelDef | null {
  const info = spLevelOf(totalSp);
  if (info.next === null) return null;
  return SP_LEVELS.find((l) => l.sp === info.next) ?? null;
}
