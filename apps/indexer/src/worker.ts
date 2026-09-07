import { buildDeps } from '@stonkz/api/app/deps';
import { runMigrations } from '@stonkz/api/db/migrate';
import { readEnv } from '@stonkz/api/env';
import { ReplayCursors } from './cursors.js';
import { canonicalScenario } from './fixtures/producer.js';
import { Ingestor } from './ingest.js';
import { LagMonitor } from './lag.js';
import { IndexerRunner } from './runner.js';
import { FixtureEventSource, type EventSource } from './source.js';
import type { Net } from '@stonkz/shared';

/**
 * The runnable indexer. `pnpm --filter @stonkz/indexer dev`.
 *
 * Until the programs are deployed the event source is the fixture producer,
 * which is stated in the logs rather than hidden — an operator must never be
 * unsure whether they are looking at chain data. Set `INDEXER_SOURCE=chain`
 * once the decoders land.
 */
const env = readEnv();
const { deps, close } = await buildDeps(env);
const logger = deps.logger.child({ svc: 'indexer' });

if (env.nodeEnv !== 'production') await runMigrations(deps.db);

const cursors = new ReplayCursors(deps.db, deps.now);
const ingestor = new Ingestor({
  db: deps.db,
  ledger: deps.ledger,
  awards: deps.awards,
  publisher: deps.publisher,
  logger,
  now: deps.now,
});
const lag = new LagMonitor({
  cursors,
  rpcs: deps.rpcs,
  metrics: deps.metrics,
  logger,
  tickMs: env.chainTickMs,
});

const sourceMode = process.env['INDEXER_SOURCE'] ?? 'fixtures';
if (sourceMode !== 'fixtures') {
  logger.error('chain event decoders are not implemented yet', { sourceMode });
  throw new Error('INDEXER_SOURCE=chain requires the Phase 2 programs; only "fixtures" works today');
}

const scenario = canonicalScenario();
logger.warn('running on FIXTURE events, not chain data', {
  events: scenario.events.length,
  heads: scenario.heads,
});

const sources: Record<Net, EventSource> = {
  SOL: new FixtureEventSource('SOL', scenario.events),
  RH: new FixtureEventSource('RH', scenario.events),
};

const runner = new IndexerRunner({ cursors, ingestor, lag, logger, oracle: deps.oracle, sources });

// Rewind so a restart replays the fixtures rather than sitting idle; this is
// safe precisely because ingest is idempotent.
for (const net of ['SOL', 'RH'] as const) await cursors.rewind(net, 0);

let stopping = false;
const POLL_MS = 2_000;
const SWEEP_MS = 60_000;

const sweep = setInterval(() => {
  void runner.sweepAchievements().catch((err: unknown) => logger.error('sweep failed', { err: String(err) }));
}, SWEEP_MS);
sweep.unref?.();

const shutdown = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  logger.info('shutting down', { signal });
  clearInterval(sweep);
  await close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

logger.info('indexer started', { pollMs: POLL_MS });
while (!stopping) {
  try {
    await runner.drain();
  } catch (err) {
    logger.error('indexer pass failed', { err: err instanceof Error ? err.message : String(err) });
  }
  await new Promise((resolve) => setTimeout(resolve, POLL_MS));
}
