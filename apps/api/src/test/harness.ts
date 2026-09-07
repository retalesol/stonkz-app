import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { Db } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
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

export async function createTestDb(): Promise<TestDb> {
  const pg = new PGlite();
  // The cast is the same one documented on `Db`: PGlite and postgres-js expose
  // the same drizzle query surface, and only the driver HKT differs.
  const db = drizzle(pg, { schema }) as unknown as Db;
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
      // The seed rows in 0001 are part of the schema contract, not test data.
      await pg.exec(`INSERT INTO "indexer_cursors" ("net") VALUES ('SOL'), ('RH')`);
      await pg.exec(
        `INSERT INTO "treasuries" ("net", "kind") VALUES
           ('SOL','protocol'), ('SOL','stonkz_ops'), ('RH','protocol'), ('RH','stonkz_ops')`,
      );
    },
  };
}
