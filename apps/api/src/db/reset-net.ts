import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

/**
 * Wipe everything the chain wrote for one or more nets, so a freshly deployed
 * launchpad starts from an empty board. Off-chain state keyed by `(net,
 * wallet)` (users, sessions, XP, crates, chat, follows, referrals) is kept: a
 * tester's rank does not depend on which proxy address the curve lives at.
 *
 * The indexer cursor row is deleted rather than rewound: on its next start the
 * indexer opens a fresh cursor one position before `INDEXER_<NET>_START_*`, so
 * that env var must point at the new deployment block before the roll.
 *
 * Treasuries keep their rows (the API lists them) with balances zeroed.
 */
export const CHAIN_DERIVED_TABLES = [
  'tokens',
  'launch_intents',
  'trades',
  'candles',
  'holders_snapshot',
  'koth',
  'tape',
  'treasury_credits',
  'creator_vaults',
  'stake_positions',
  'chain_events',
  'indexer_dead_letters',
  'indexer_cursors',
] as const;

/**
 * The production driver (postgres.js) hands `execute` results back as an array
 * with `.count`; the PGlite driver the tests run on returns `{ rows, rowCount }`.
 */
export function rowsOf(r: unknown): unknown[] {
  if (Array.isArray(r)) return r;
  return ((r as { rows?: unknown[] }).rows ?? []) as unknown[];
}

export function affected(r: unknown): number {
  const x = r as { rowCount?: number | null; count?: number };
  return Number(x.rowCount ?? x.count ?? 0);
}

export interface ResetNetResult {
  deleted: Record<string, number>;
  treasuriesZeroed: number;
}

export async function resetNets(db: Db, nets: readonly string[]): Promise<ResetNetResult> {
  if (nets.length === 0) throw new Error('resetNets: no nets given');
  const list = sql.join(
    nets.map((n) => sql`${n}`),
    sql`, `,
  );
  return db.transaction(async (tx) => {
    const deleted: Record<string, number> = {};
    for (const table of CHAIN_DERIVED_TABLES) {
      // Only tables that exist and carry a `net` column; a table this list
      // names that a later migration dropped is skipped, not fatal.
      const exists = await tx.execute(sql`
        select 1 from information_schema.columns
        where table_schema = current_schema() and table_name = ${table} and column_name = 'net'`);
      if (rowsOf(exists).length === 0) continue;
      const r = await tx.execute(sql`delete from ${sql.identifier(table)} where net in (${list})`);
      deleted[table] = affected(r);
    }
    const t = await tx.execute(sql`
      update treasuries set native_balance = 0, lifetime_credited = 0, updated_at = now()
      where net in (${list})`);
    return { deleted, treasuriesZeroed: affected(t) };
  });
}
