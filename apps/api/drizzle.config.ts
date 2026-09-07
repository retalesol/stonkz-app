import { defineConfig } from 'drizzle-kit';

/**
 * `pnpm --filter @stonkz/api db:generate` appends to the existing history in
 * `./drizzle`. Applying is done by `src/db/migrate.ts`, not by drizzle-kit, so
 * that tests and production share one applier.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgres://stonkz:stonkz@localhost:5432/stonkz',
  },
  strict: true,
  verbose: true,
});
