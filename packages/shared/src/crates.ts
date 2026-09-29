import { CRATES, HOUR, RAR, RWA_ASSETS, type Crate, type CrateDrop } from './constants.js';
import type { Random } from './rng.js';
import type { CrateTier } from './types.js';

export type CrateTable = readonly Crate[];

/** Look up a crate by tier. `index.html:2210` */
export function crateBy(k: CrateTier, crates: CrateTable = CRATES): Crate | null {
  for (const c of crates) if (c.k === k) return c;
  return null;
}

/**
 * Pick a drop index by weight. Odds are cumulative percentages that sum to 100;
 * the last row absorbs any rounding. The `random` source is injected so tests
 * can pin the table — production RNG is server-side (committed seed + HMAC).
 * `index.html:2352`
 */
export function rollDrop(c: Pick<Crate, 'drops'>, random: Random = Math.random): number {
  const x = random() * 100;
  let acc = 0;
  for (let i = 0; i < c.drops.length; i++) {
    acc += (c.drops[i] as CrateDrop)[0];
    if (x <= acc) return i;
  }
  return c.drops.length - 1;
}

/**
 * `$STONKZ` payout for an `S` row, rounded to the nearest 10. Zero for the
 * other kinds. `index.html:2361`
 */
export function rollCrateAmount(drop: CrateDrop, random: Random = Math.random): number {
  if (drop[1] !== 'S') return 0;
  return Math.round((drop[2] + random() * (drop[3] - drop[2])) / 10) * 10;
}

/** RWA units for an `R` row, to four decimals (fractional shares / ounces). Zero for the other kinds. */
export function rollRwaUnits(drop: CrateDrop, random: Random = Math.random): number {
  if (drop[1] !== 'R') return 0;
  const units = drop[3] + random() * (drop[4] - drop[3]);
  return Math.round(units * 10_000) / 10_000;
}

/** XP for opening a crate: modest vs trade XP so trading stays the grind. */
export function crateXp(tierIndex: number): number {
  return 10 + tierIndex * 10;
}

/** Epoch ms the crate becomes openable again after an open at `now`. `index.html:2369` */
export function crateReadyAt(c: Pick<Crate, 'cd'>, now: number): number {
  return now + c.cd * HOUR;
}

/** Has the cooldown elapsed. `index.html:2212` */
export function crateReady(readyAt: number | undefined, now: number = Date.now()): boolean {
  return !readyAt || readyAt <= now;
}

/* -------------------------------------------------------------------------- */
/* Commit–reveal roll                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The message the server HMACs with its revealed per-open seed. Published so
 * anyone can recompute a roll from the drop log:
 *
 *   digest = HMAC-SHA256(serverSeed, crateRollMessage(net, wallet, tier, clientSeed))
 *   sha256(serverSeed) === serverSeedHash  (the hash was shown before the open)
 */
export function crateRollMessage(
  net: string,
  wallet: string,
  tier: string,
  clientSeed: string,
): string {
  return `${net}|${wallet}|${tier}|${clientSeed}`;
}

export interface CrateRollDraws {
  /** `[0, 100)` — compared against the cumulative odds column, six decimals. */
  rollValue: number;
  /** `[0, 1)` — positions the payout inside the chosen row's range. */
  amountRoll: number;
}

/**
 * Map the first 16 bytes of an HMAC digest onto the two draws a crate open
 * uses. Big-endian, so the same bytes give the same numbers on the server
 * (`node:crypto`) and in a browser (`crypto.subtle`) audit.
 */
export function crateRollFromDigest(digest: Uint8Array): CrateRollDraws {
  if (digest.length < 16) throw new Error('crate roll digest must be at least 16 bytes');
  let a = 0n;
  let b = 0n;
  for (let i = 0; i < 8; i++) a = (a << 8n) | BigInt(digest[i] as number);
  for (let i = 8; i < 16; i++) b = (b << 8n) | BigInt(digest[i] as number);
  const SCALE = 2n ** 64n;
  return {
    rollValue: Number((a * 100_000_000n) / SCALE) / 1_000_000,
    amountRoll: Number((b * 1_000_000_000n) / SCALE) / 1_000_000_000,
  };
}

/** Client seeds are short, URL-safe and mandatory-format so a proof is copy-pasteable. */
export const CLIENT_SEED_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidClientSeed(seed: unknown): seed is string {
  return typeof seed === 'string' && CLIENT_SEED_RE.test(seed);
}

/* -------------------------------------------------------------------------- */
/* Table validation                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Structural check for a crate table, shipped or operator-supplied. Returns
 * human-readable problems; empty means every invariant the roll, the ledger
 * and the UI rely on holds: unique tiers, one row per rarity, odds summing to
 * 100, payout bands that are real ranges, RWA assets from the catalog.
 */
export function validateCrateTables(
  crates: readonly Crate[],
  rwaAssets: readonly string[] = RWA_ASSETS.map((a) => a[0]),
): string[] {
  const errors: string[] = [];
  if (crates.length === 0) return ['crate table is empty'];
  const seen = new Set<string>();
  const assetSet = new Set(rwaAssets);
  for (const c of crates) {
    if (seen.has(c.k)) errors.push(`tier ${c.k} is listed twice`);
    seen.add(c.k);
    if (!(c.cd > 0)) errors.push(`tier ${c.k} cooldown must be positive`);
    if (c.drops.length !== RAR.length)
      errors.push(`tier ${c.k} has ${c.drops.length} rows; the rarity ladder has ${RAR.length}`);
    let sum = 0;
    c.drops.forEach((d, i) => {
      const where = `tier ${c.k} row ${i}`;
      if (!(d[0] > 0)) errors.push(`${where} odds must be positive`);
      sum += d[0];
      if (d[1] === 'S') {
        if (!(d[2] >= 0) || !(d[3] > d[2])) errors.push(`${where} $STONKZ band must be min < max`);
      } else if (d[1] === 'R') {
        if (!assetSet.has(d[2])) errors.push(`${where} RWA asset ${d[2]} is not in the catalog`);
        if (!(d[3] > 0) || !(d[4] > d[3]))
          errors.push(`${where} RWA unit band must be 0 < min < max`);
      } else if (d[1] === 'I') {
        if (!d[2] || !d[2].trim()) errors.push(`${where} item label is empty`);
      } else {
        errors.push(`${where} has an unknown kind`);
      }
    });
    if (Math.abs(sum - 100) > 1e-9) errors.push(`tier ${c.k} odds sum to ${sum}, not 100`);
  }
  return errors;
}

/**
 * Soft warnings the owner should look at when tuning: not enforced, because
 * the current shipped table trips one of them (Palladium / Rhodium pay the
 * UNCOMMON row more often than COMMON).
 */
export function crateTableWarnings(crates: readonly Crate[] = CRATES): string[] {
  const out: string[] = [];
  for (const c of crates) {
    for (let i = 1; i < c.drops.length; i++) {
      const prev = (c.drops[i - 1] as CrateDrop)[0];
      const cur = (c.drops[i] as CrateDrop)[0];
      if (cur > prev) {
        out.push(
          `tier ${c.k}: ${RAR[i]?.[0] ?? i} (${cur}%) is more likely than ${RAR[i - 1]?.[0] ?? i - 1} (${prev}%)`,
        );
      }
    }
  }
  return out;
}
