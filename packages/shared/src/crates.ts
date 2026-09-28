import { CRATES, HOUR, type Crate, type CrateDrop } from './constants.js';
import type { Random } from './rng.js';
import type { CrateTier } from './types.js';

/** Look up a crate by tier. `index.html:2210` */
export function crateBy(k: CrateTier): Crate | null {
  for (const c of CRATES) if (c.k === k) return c;
  return null;
}

/**
 * Pick a drop index by weight. Odds are cumulative percentages that sum to 100;
 * the last row absorbs any rounding. The `random` source is injected so tests
 * can pin the table — production RNG is server-side (HMAC, then VRF).
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
