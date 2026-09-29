import {
  CRATES,
  SP_LEVELS,
  validateCrateTables,
  validateLevelTable,
  type Crate,
  type CrateTable,
  type CrateTier,
  type SpLevelDef,
  type SpLevelTable,
} from '@stonkz/shared';

/**
 * The one place the API reads the progression tables from.
 *
 * `@stonkz/shared` ships the defaults (`CRATES`, `SP_LEVELS`); the crate
 * service, the SP-level service and the rewards routes read them through
 * these accessors so an operator override — the admin panel's settings
 * service, once it lands — can be injected with `setProgressionOverrides()`
 * without touching game code. Overrides are validated on the way in with the
 * same invariants the shipped tables are tested against, so a bad table is
 * refused rather than served.
 *
 * Deliberately module-level rather than a `Deps` member: the tables are
 * consulted from inside pure helpers (`crateBy`, `spLevelOf`) that have no
 * access to request deps, and one process serves one table set.
 */

export interface ProgressionOverrides {
  crates?: readonly Crate[] | null;
  levels?: readonly SpLevelDef[] | null;
}

let crateOverride: CrateTable | null = null;
let levelOverride: SpLevelTable | null = null;

/** Crate definitions (tiers, cooldowns, drop tables) currently in force. */
export function getCrateTables(): CrateTable {
  return crateOverride ?? CRATES;
}

/** SP level ladder currently in force. */
export function getLevelTable(): SpLevelTable {
  return levelOverride ?? SP_LEVELS;
}

export function crateTiers(): CrateTier[] {
  return getCrateTables().map((c) => c.k);
}

export class InvalidProgressionTableError extends Error {
  constructor(
    readonly table: 'crates' | 'levels',
    readonly problems: string[],
  ) {
    super(`invalid ${table} table: ${problems.join('; ')}`);
    this.name = 'InvalidProgressionTableError';
  }
}

/**
 * Install operator tables. `null` (or an omitted key) restores the shipped
 * default for that table. Throws {@link InvalidProgressionTableError} and
 * leaves the previous tables in force when either candidate fails validation
 * — the level table is checked against the crate tiers it would grant, so the
 * pair is validated together.
 */
export function setProgressionOverrides(overrides: ProgressionOverrides): void {
  const nextCrates = overrides.crates === undefined ? crateOverride : overrides.crates;
  const nextLevels = overrides.levels === undefined ? levelOverride : overrides.levels;

  const crates = nextCrates ?? CRATES;
  const crateProblems = validateCrateTables(crates);
  if (crateProblems.length > 0) throw new InvalidProgressionTableError('crates', crateProblems);

  const levels = nextLevels ?? SP_LEVELS;
  const levelProblems = validateLevelTable(
    levels,
    crates.map((c) => c.k),
  );
  if (levelProblems.length > 0) throw new InvalidProgressionTableError('levels', levelProblems);

  crateOverride = nextCrates ?? null;
  levelOverride = nextLevels ?? null;
}

/** Back to the shipped tables. Tests call this in `afterEach`. */
export function clearProgressionOverrides(): void {
  crateOverride = null;
  levelOverride = null;
}

/** Whether an operator table is in force, for `/health` and the admin panel. */
export function progressionOverrideStatus(): { crates: boolean; levels: boolean } {
  return { crates: crateOverride !== null, levels: levelOverride !== null };
}
