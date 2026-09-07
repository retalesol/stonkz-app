import { readEnv } from '../env.js';
import { createDb } from './client.js';
import { runMigrations } from './migrate.js';

/** `pnpm --filter @stonkz/api migrate` — run against docker-compose Postgres. */
const env = readEnv();
const handle = createDb({ url: env.databaseUrl, singleConnection: true });

try {
  const { applied, skipped } = await runMigrations(handle.db);
  for (const tag of skipped) console.log(`= ${tag}`);
  for (const tag of applied) console.log(`+ ${tag}`);
  console.log(`${applied.length} applied, ${skipped.length} already present.`);
} finally {
  await handle.close();
}
