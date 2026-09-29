import { CRATES } from './constants.js';
import type { CrateTier } from './types.js';

/**
 * SP level → crate inventory grants.
 *
 * SP mirrors XP 1:1 from most awards. Rhodium (L20) sits at **250,000 SP** —
 * roughly 5,000 SOL of curve volume at `xpForTrade` (`native × 50`), which at
 * a 1% curve fee yields ~50 SOL gross fees and ~10 SOL to protocol (20%).
 * Opening any crate starts a **global** cooldown equal to that tier's `cd`.
 *
 * Every function here takes the level table as an optional last argument so
 * the API can serve an operator override (`getLevelTable()`) without the
 * arithmetic drifting from the shipped default.
 */
export type CrateGrant = Partial<Record<CrateTier, number>>;

export interface SpLevelDef {
  readonly level: number;
  /** Lifetime SP required (inclusive). */
  readonly sp: number;
  readonly grants: CrateGrant;
}

export type SpLevelTable = readonly SpLevelDef[];

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
export function spLevelOf(totalSp: number, levels: SpLevelTable = SP_LEVELS): SpLevelInfo {
  let i = 0;
  for (let k = 0; k < levels.length; k++) {
    if (totalSp >= levels[k]!.sp) i = k;
  }
  const row = levels[i]!;
  const nextRow = levels[i + 1];
  const next = nextRow ? nextRow.sp : null;
  return {
    level: row.level,
    sp: totalSp,
    cur: row.sp,
    next,
    pct:
      next === null
        ? 100
        : Math.max(0, Math.min(100, ((totalSp - row.sp) / (next - row.sp)) * 100)),
    toNext: next === null ? 0 : Math.max(0, next - totalSp),
    grants: { ...row.grants },
  };
}

/** Every level definition with `sp <= totalSp` (for catch-up grants). */
export function spLevelsReached(
  totalSp: number,
  levels: SpLevelTable = SP_LEVELS,
): readonly SpLevelDef[] {
  return levels.filter((l) => totalSp >= l.sp);
}

/** Preview of the next unclaimed level's grants, or null at max. */
export function nextSpLevelGrants(
  totalSp: number,
  levels: SpLevelTable = SP_LEVELS,
): SpLevelDef | null {
  const info = spLevelOf(totalSp, levels);
  if (info.next === null) return null;
  // `next` is read off the table, so the lookup cannot miss.
  /* v8 ignore next */
  return levels.find((l) => l.sp === info.next) ?? null;
}

/** Total crates a level table hands out, by tier — the "what does the ladder pay" summary. */
export function levelGrantTotals(levels: SpLevelTable = SP_LEVELS): CrateGrant {
  const out: CrateGrant = {};
  for (const l of levels) {
    for (const [tier, n] of Object.entries(l.grants) as [CrateTier, number][]) {
      out[tier] = (out[tier] ?? 0) + (n ?? 0);
    }
  }
  return out;
}

/**
 * Structural check for a level table, shipped or operator-supplied. Returns
 * a list of human-readable problems; empty means the table is safe to serve.
 * Every rule here is one the ledger or the UI silently depends on.
 */
export function validateLevelTable(
  levels: readonly SpLevelDef[],
  tiers: readonly CrateTier[] = CRATES.map((c) => c.k),
): string[] {
  const errors: string[] = [];
  if (levels.length === 0) return ['level table is empty'];
  if (levels[0]!.sp !== 0) errors.push('level 1 must start at 0 SP (every wallet has a level)');
  if (levels[0]!.level !== 1) errors.push('first level must be numbered 1');
  const tierSet = new Set<string>(tiers);
  for (let i = 0; i < levels.length; i++) {
    const l = levels[i]!;
    if (!Number.isInteger(l.level) || l.level < 1)
      errors.push(`level ${l.level} is not a positive integer`);
    if (!Number.isFinite(l.sp) || l.sp < 0)
      errors.push(`level ${l.level} has an invalid SP threshold`);
    if (i > 0) {
      const prev = levels[i - 1]!;
      if (l.level !== prev.level + 1) errors.push(`level ${l.level} does not follow ${prev.level}`);
      if (l.sp <= prev.sp)
        errors.push(
          `level ${l.level} threshold ${l.sp} is not above level ${prev.level} (${prev.sp})`,
        );
    }
    let any = false;
    for (const [tier, n] of Object.entries(l.grants)) {
      if (!tierSet.has(tier)) errors.push(`level ${l.level} grants unknown tier ${tier}`);
      if (!Number.isInteger(n) || (n as number) < 0)
        errors.push(`level ${l.level} grant for ${tier} must be a non-negative integer`);
      if ((n as number) > 0) any = true;
    }
    if (!any) errors.push(`level ${l.level} grants nothing`);
  }
  return errors;
}
