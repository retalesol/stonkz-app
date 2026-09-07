/**
 * Server UTC days only (plan step 103).
 *
 * `dayKey()` in `packages/shared` deliberately mirrors the simulation's local
 * calendar so persisted sim streaks survive the port. The ledger must not use
 * it: a client in UTC+14 would otherwise bank a streak day before a client in
 * UTC-11 had finished the previous one. These helpers are the server's own
 * clock and take no input from the request.
 */

/** `YYYY-MM-DD` in UTC — the exact shape Postgres `date` round-trips. */
export function utcDayKey(now: number | Date = Date.now()): string {
  const d = now instanceof Date ? now : new Date(now);
  return d.toISOString().slice(0, 10);
}

export function previousUtcDay(dayKey: string): string {
  const d = new Date(`${dayKey}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return utcDayKey(d);
}

export function nextUtcDay(dayKey: string): string {
  const d = new Date(`${dayKey}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return utcDayKey(d);
}

/** Whole UTC days between two keys; negative when `b` precedes `a`. */
export function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00.000Z`) - Date.parse(`${a}T00:00:00.000Z`);
  return Math.round(ms / 86_400_000);
}
