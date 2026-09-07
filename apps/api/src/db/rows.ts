/**
 * `db.execute()` returns a bare array on postgres-js and `{ rows }` on PGlite.
 * Typed drizzle queries (`db.select()`) are identical across both, so this is
 * only needed for the handful of raw statements — health probes, the migration
 * tracker and the index-advisor plans.
 */
export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result !== null && typeof result === 'object') {
    const maybe = (result as { rows?: unknown }).rows;
    if (Array.isArray(maybe)) return maybe as T[];
  }
  return [];
}
