import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { rowsOf } from './rows.js';

/**
 * The migration applier.
 *
 * The SQL lives in `apps/api/drizzle` in drizzle-kit's on-disk format —
 * numbered `.sql` files split by `--> statement-breakpoint`, indexed by
 * `meta/_journal.json` — so `drizzle-kit generate` can keep appending to the
 * same history later. Applying them here rather than through drizzle's own
 * per-driver migrators keeps one code path across postgres-js and PGlite, and
 * gives `listAppliedMigrations()` for the health endpoint.
 */

export interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
  breakpoints: boolean;
}

export interface MigrationFile {
  idx: number;
  tag: string;
  statements: string[];
}

const BREAKPOINT = '--> statement-breakpoint';

export function migrationsFolder(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');
}

export function readMigrations(folder: string = migrationsFolder()): MigrationFile[] {
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: JournalEntry[] };

  const onDisk = new Set(readdirSync(folder).filter((f) => f.endsWith('.sql')));
  const out: MigrationFile[] = [];

  for (const entry of [...journal.entries].sort((a, b) => a.idx - b.idx)) {
    const file = `${entry.tag}.sql`;
    if (!onDisk.has(file)) throw new Error(`migration ${file} is in the journal but not on disk`);
    onDisk.delete(file);
    const body = readFileSync(join(folder, file), 'utf8');
    const statements = body
      .split(BREAKPOINT)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (statements.length === 0) throw new Error(`migration ${file} is empty`);
    out.push({ idx: entry.idx, tag: entry.tag, statements });
  }

  if (onDisk.size > 0) {
    throw new Error(`migration file(s) not in the journal: ${[...onDisk].sort().join(', ')}`);
  }
  return out;
}

async function ensureTrackingTable(db: Db): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "__stonkz_migrations" (
      "idx" integer PRIMARY KEY,
      "tag" text NOT NULL UNIQUE,
      "applied_at" timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export async function listAppliedMigrations(db: Db): Promise<string[]> {
  await ensureTrackingTable(db);
  const result = await db.execute(sql`SELECT "tag" FROM "__stonkz_migrations" ORDER BY "idx"`);
  return rowsOf<{ tag: string }>(result).map((r) => r.tag);
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

/** Idempotent. Each migration runs inside its own transaction. */
export async function runMigrations(
  db: Db,
  folder: string = migrationsFolder(),
): Promise<MigrateResult> {
  await ensureTrackingTable(db);
  const already = new Set(await listAppliedMigrations(db));
  const result: MigrateResult = { applied: [], skipped: [] };

  for (const migration of readMigrations(folder)) {
    if (already.has(migration.tag)) {
      result.skipped.push(migration.tag);
      continue;
    }
    await db.transaction(async (tx) => {
      for (const statement of migration.statements) {
        await tx.execute(sql.raw(statement));
      }
      await tx.execute(
        sql`INSERT INTO "__stonkz_migrations" ("idx", "tag") VALUES (${migration.idx}, ${migration.tag})`,
      );
    });
    result.applied.push(migration.tag);
  }
  return result;
}
