import { and, desc, eq, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { tokens } from '../db/schema.js';
import type { TokenRow } from './serialise.js';

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
 */
export async function findLaunchCooldown(
  db: Db,
  net: string,
  ticker: string,
  name: string,
  nowMs: number,
): Promise<LaunchCooldownHit | null> {
  const sym = ticker.trim().toUpperCase();
  const nameNorm = name.trim().toLowerCase();
  if (!sym && !nameNorm) return null;

  const cutoff = new Date(nowMs - LAUNCH_NAME_TICKER_COOLDOWN_MS);
  const clauses = [];
  if (sym) clauses.push(eq(tokens.sym, sym));
  if (nameNorm) clauses.push(sql`lower(${tokens.name}) = ${nameNorm}`);
  if (!clauses.length) return null;

  const [row] = await db
    .select({
      sym: tokens.sym,
      name: tokens.name,
      launchedAt: tokens.launchedAt,
    })
    .from(tokens)
    .where(and(eq(tokens.net, net), or(...clauses), sql`${tokens.launchedAt} > ${cutoff}`))
    .orderBy(desc(tokens.launchedAt))
    .limit(1);

  if (!row?.launchedAt) return null;
  const launchedAt = row.launchedAt instanceof Date ? row.launchedAt : new Date(row.launchedAt);
  const elapsed = nowMs - launchedAt.getTime();
  if (elapsed >= LAUNCH_NAME_TICKER_COOLDOWN_MS) return null;
  const kind: 'ticker' | 'name' =
    sym && row.sym.toUpperCase() === sym ? 'ticker' : 'name';
  return {
    kind,
    launchedAt,
    retryAfterMs: Math.max(0, LAUNCH_NAME_TICKER_COOLDOWN_MS - elapsed),
  };
}
