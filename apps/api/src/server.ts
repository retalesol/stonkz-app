import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { createApp } from './app/create.js';
import { buildDeps } from './app/deps.js';
import { runMigrations } from './db/migrate.js';
import { readEnv } from './env.js';
import { WsHub } from './ws/hub.js';

/** The runnable API. `pnpm --filter @stonkz/api dev`. */
const env = readEnv();
const { deps, close } = await buildDeps(env);

// Local dev runs migrations on boot; in production this is a deploy step so two
// instances starting at once cannot race the same DDL. `DB_MIGRATE_ON_BOOT=1`
// is the explicit, single-replica exception for environments with no shell
// into the database (first boot of a fresh environment): set it, deploy once,
// unset it.
if (env.nodeEnv !== 'production' || env.dbMigrateOnBoot) {
  if (env.nodeEnv === 'production')
    deps.logger.warn('DB_MIGRATE_ON_BOOT=1: migrating on boot in production');
  const { applied } = await runMigrations(deps.db);
  if (applied.length > 0) deps.logger.info('migrations applied', { applied });
}

const app = createApp(deps);
const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
  deps.logger.info('api listening', { port: info.port, env: env.nodeEnv });
});

const hub = new WsHub({
  redis: deps.redis,
  jwt: deps.jwt,
  logger: deps.logger,
  metrics: deps.metrics,
  chat: deps.chat,
  publisher: deps.publisher,
  db: deps.db,
});
await hub.attach(server as unknown as Server);

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  deps.logger.info('shutting down', { signal });
  await hub.close();
  await new Promise<void>((resolve) => (server as unknown as Server).close(() => resolve()));
  await close();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
