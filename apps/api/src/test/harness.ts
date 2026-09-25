import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { Db } from '../db/client.js';
import { readMigrations, runMigrations } from '../db/migrate.js';
import * as schema from '../db/schema.js';

/**
 * An ephemeral Postgres for tests.
 *
 * PGlite is Postgres 18 compiled to WASM and runs in-process, so `pnpm test`
 * is green with no Docker, no Neon and no network — while still executing the
 * real migration history and real SQL (partial unique indexes, CHECK
 * constraints, `date` arithmetic and all). `docker-compose.yml` remains the
 * path for running the service by hand.
 */
export interface TestDb {
  db: Db;
  close(): Promise<void>;
  /** Truncate every table the migrations created, keeping the schema. */
  reset(): Promise<void>;
}

/**
 * Applying the migration history costs more than booting PGlite does, and
 * every test file pays it in its own worker process. So the first caller
 * migrates and snapshots the result to disk; the rest restore the snapshot.
 *
 * The cache key is a hash of the migration SQL, so editing or adding a
 * migration invalidates it rather than testing a stale schema — the one
 * failure mode that would make this dangerous rather than merely fast.
 */
function cacheKey(): string {
  const hash = createHash('sha256');
  for (const migration of readMigrations()) {
    hash.update(migration.tag);
    for (const statement of migration.statements) hash.update(statement);
  }
  return hash.digest('hex').slice(0, 16);
}

function cachePath(key: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '../../node_modules/.cache/stonkz-pglite', `schema-${key}.tar.gz`);
}

let cachedSnapshot: Buffer | null = null;

async function migratedSnapshot(): Promise<Buffer | null> {
  if (cachedSnapshot) return cachedSnapshot;

  const path = cachePath(cacheKey());
  if (existsSync(path)) {
    try {
      cachedSnapshot = readFileSync(path);
      return cachedSnapshot;
    } catch {
      // Fall through and rebuild; a truncated cache file is not fatal.
    }
  }

  const pg = new PGlite();
  try {
    await runMigrations(drizzle(pg, { schema }) as unknown as Db);
    const dump = await pg.dumpDataDir('gzip');
    const bytes = Buffer.from(await dump.arrayBuffer());

    try {
      mkdirSync(dirname(path), { recursive: true });
      // Parallel workers race here, so write to a private name and rename,
      // which is atomic on the same filesystem. A partial file would be worse
      // than no cache at all.
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, bytes);
      renameSync(tmp, path);
    } catch {
      // A read-only or full disk just means every file migrates for itself.
    }

    cachedSnapshot = bytes;
    return cachedSnapshot;
  } finally {
    await pg.close();
  }
}

export async function createTestDb(): Promise<TestDb> {
  const snapshot = await migratedSnapshot();
  const pg = snapshot ? new PGlite({ loadDataDir: new Blob([snapshot]) }) : new PGlite();
  // The cast is the same one documented on `Db`: PGlite and postgres-js expose
  // the same drizzle query surface, and only the driver HKT differs.
  const db = drizzle(pg, { schema }) as unknown as Db;
  // Idempotent: a restored snapshot reports every migration as skipped, and
  // this is also the fallback path when no snapshot could be produced.
  await runMigrations(db);

  return {
    db,
    close: () => pg.close(),
    async reset() {
      const { rows } = await pg.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '__stonkz_migrations'`,
      );
      const names = rows.map((r) => `"${r.tablename}"`).join(', ');
      if (names) await pg.exec(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);
      // The seed rows in 0001 (SOL, RH), 0013 (BASE cursor) and 0014 (BASE
      // vaults) are part of the schema contract, not test data.
      await pg.exec(`INSERT INTO "indexer_cursors" ("net") VALUES ('SOL'), ('RH'), ('BASE')`);
      await pg.exec(
        `INSERT INTO "treasuries" ("net", "kind") VALUES
           ('SOL','protocol'), ('SOL','stonkz_ops'), ('RH','protocol'), ('RH','stonkz_ops'),
           ('BASE','protocol'), ('BASE','stonkz_ops')`,
      );
    },
  };
}

/** Drops the on-disk schema cache. Only needed when debugging the cache itself. */
export function clearSchemaCache(): void {
  cachedSnapshot = null;
  rmSync(join(dirname(cachePath(cacheKey()))), { recursive: true, force: true });
}
