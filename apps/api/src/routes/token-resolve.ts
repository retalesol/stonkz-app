import { and, desc, eq, gt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { tokens } from '../db/schema.js';
import type { TokenRow } from './serialise.js';
import { nameSkeleton } from './launch-validate.js';

/** Soft squat window for reused tickers / display names on the same net. */
export const LAUNCH_NAME_TICKER_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Resolve a token row by canonical mint, or by ticker (newest `launched_at`
 * wins when duplicates exist).
 */
export async function resolveTokenRow(
  db: Db,
  net: string,
  opts: { mint?: string | null | undefined; sym?: string | null | undefined },
): Promise<TokenRow | null> {
  const mint = opts.mint?.trim();
  if (mint) {
    const [row] = await db
      .select()
      .from(tokens)
      .where(and(eq(tokens.net, net), eq(tokens.mint, mint)))
      .limit(1);
    return (row as TokenRow | undefined) ?? null;
  }
  const sym = opts.sym?.trim().toUpperCase();
  if (!sym) return null;
  const [row] = await db
    .select()
    .from(tokens)
    .where(and(eq(tokens.net, net), eq(tokens.sym, sym)))
    .orderBy(desc(tokens.launchedAt))
    .limit(1);
  return (row as TokenRow | undefined) ?? null;
}

export type LaunchCooldownHit = {
  kind: 'ticker' | 'name';
  launchedAt: Date;
  retryAfterMs: number;
};

/**
 * Returns a cooldown hit when the same net already has this ticker or
 * display name launched inside the last {@link LAUNCH_NAME_TICKER_COOLDOWN_MS}.
 *
 * Names are compared on their {@link nameSkeleton} — case, accents,
 * separators, zero-width characters and common Cyrillic/Greek look-alikes
 * folded away — so `Pepe` cannot be re-squatted as `PEPE!`, `Pe\u200Bpe` or
 * `Реpe` inside the window. The window is minutes long, so the candidate set
 * is small enough to compare in process rather than in SQL.
 */
export async function findLaunchCooldown(
  db: Db,
  net: string,
  ticker: string,
  name: string,
  nowMs: number,
): Promise<LaunchCooldownHit | null> {
  const sym = ticker.trim().toUpperCase();
  const skeleton = nameSkeleton(name);
  if (!sym && !skeleton) return null;

  const cutoff = new Date(nowMs - LAUNCH_NAME_TICKER_COOLDOWN_MS);
  const rows = await db
    .select({
      sym: tokens.sym,
      name: tokens.name,
      launchedAt: tokens.launchedAt,
    })
    .from(tokens)
    // `gt` maps the Date through the column's driver encoder; a raw `${cutoff}`
    // reaches postgres.js as Date#toString() and Postgres rejects it.
    .where(and(eq(tokens.net, net), gt(tokens.launchedAt, cutoff)))
    .orderBy(desc(tokens.launchedAt))
    .limit(500);

  for (const row of rows) {
    if (!row.launchedAt) continue;
    const tickerHit = !!sym && row.sym.toUpperCase() === sym;
    const nameHit = !!skeleton && nameSkeleton(row.name) === skeleton;
    if (!tickerHit && !nameHit) continue;
    const launchedAt = row.launchedAt instanceof Date ? row.launchedAt : new Date(row.launchedAt);
    const elapsed = nowMs - launchedAt.getTime();
    if (elapsed >= LAUNCH_NAME_TICKER_COOLDOWN_MS) continue;
    return {
      kind: tickerHit ? 'ticker' : 'name',
      launchedAt,
      retryAfterMs: Math.max(0, LAUNCH_NAME_TICKER_COOLDOWN_MS - elapsed),
    };
  }
  return null;
}
