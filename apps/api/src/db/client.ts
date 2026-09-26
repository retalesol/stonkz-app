import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

/**
 * One database type for the whole codebase.
 *
 * Production runs postgres-js against whatever `DATABASE_URL` points at
 * (docker-compose locally, Neon later). Tests run the identical queries and
 * the identical migration history against an in-process PGlite instance —
 * see `test/harness.ts`, which casts its driver to this type. PGlite is real
 * Postgres compiled to WASM, so the SQL is not approximated.
 */
export type Db = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  close(): Promise<void>;
}

export interface CreateDbOptions {
  url: string;
  poolMax?: number;
  /** postgres-js keeps `max` connections warm; migrations want exactly one. */
  singleConnection?: boolean;
}

export function createDb({
  url,
  poolMax = 10,
  singleConnection = false,
}: CreateDbOptions): DbHandle {
  const client = postgres(url, {
    max: singleConnection ? 1 : poolMax,
    // Timestamps come back as Date; drizzle handles the rest.
    onnotice: () => {},
  });
  return {
    db: drizzle(client, { schema }),
    close: () => client.end({ timeout: 5 }),
  };
}

export { schema };
