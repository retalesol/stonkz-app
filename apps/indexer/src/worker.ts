import { buildDeps } from '@stonkz/api/app/deps';
import { createDb } from '@stonkz/api/db/client';
import { runMigrations } from '@stonkz/api/db/migrate';
import { readEnv } from '@stonkz/api/env';
import { readIndexerConfig } from './config.js';
import { ReplayCursors } from './cursors.js';
import { DeadLetters } from './deadletter.js';
import { canonicalScenario } from './fixtures/producer.js';
import { startIndexerHttp } from './http.js';
import { Ingestor } from './ingest.js';
import { LagMonitor } from './lag.js';
import { ReplicaLock } from './lock.js';
import { ReorgRollback } from './rollback.js';
import { IndexerRunner } from './runner.js';
import { buildChainSources } from './chain/sources.js';
import { FixtureEventSource, type EventSource } from './source.js';
import type { Net } from '@stonkz/shared';

/**
 * The runnable indexer. `pnpm --filter @stonkz/indexer dev`.
 *
 * `INDEXER_SOURCE` picks the event source and, with it, how much of the
 * durability machinery is switched on:
 *
 * - `fixtures` (the default) replays `canonicalScenario()`. There is no chain,
 *   so there are no block hashes to compare and nothing a reorg could
 *   invalidate; reorg detection and rollback stay off, and the cursors are
 *   rewound on boot so a restart replays the scenario instead of sitting idle.
 * - `chain` runs the real Solana and Robinhood Chain sources with the
 *   confirmation buffer, reorg rollback and dead-lettering all live. The
 *   cursors are **never** rewound here — that was the boot bug in
 *   `docs/indexer-runbooks.md` §3, where a restart re-ingested from position 0
 *   and re-walked every slot the programs had ever touched.
 *
 * Which mode is running is stated in the logs and on `/health`, because an
 * operator must never have to guess whether they are looking at chain data.
 */
const env = readEnv();
const config = readIndexerConfig(env);
const { deps, close } = await buildDeps(env);
const logger = deps.logger.child({ svc: 'indexer' });

if (env.nodeEnv !== 'production') await runMigrations(deps.db);

/**
 * A dedicated single connection for the advisory lock.
 *
 * The lock is session-scoped, and `deps.db` is a pool whose connections
 * postgres-js recycles freely — taking the lock there would release it the
 * moment that connection was reused. See `lock.ts`.
 */
const lockHandle = config.singleReplicaLock
  ? createDb({ url: env.databaseUrl, singleConnection: true })
  : null;
const lock = lockHandle ? new ReplicaLock({ db: lockHandle.db, key: config.lockKey, logger }) : null;

if (lock && !(await lock.acquire())) {
  logger.error('refusing to start: another replica is already indexing', { lockKey: config.lockKey });
  await lockHandle?.close();
  await close();
  process.exit(1);
}

const cursors = new ReplayCursors(deps.db, deps.now);
const deadLetters = new DeadLetters({ db: deps.db, logger, now: deps.now });
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

let sources: Record<Net, EventSource>;
let rollback: ReorgRollback | undefined;
let forgetCaches: (net: Net) => void = () => {};

if (config.mode === 'chain') {
  const built = buildChainSources({ config, env, db: deps.db, oracle: deps.oracle, logger });
  sources = {
    SOL: config.chainNets.includes('SOL')
      ? built.sources.SOL
      : new FixtureEventSource('SOL', []),
    RH: config.chainNets.includes('RH') ? built.sources.RH : new FixtureEventSource('RH', []),
  };
  rollback = new ReorgRollback({ db: deps.db, logger, now: deps.now });
  // A rollback can delete the `tokens` row a launch created, so the registry's
  // mint→ticker cache has to drop that chain's entries or the re-ingest would
  // resolve fills against a token that no longer exists.
  forgetCaches = (net) => built.registry.forget(net);
  logger.info('running on CHAIN events', {
    chainNets: config.chainNets,
    solanaProgramId: config.solanaProgramId,
    solanaStartSlot: config.solanaStartSlot,
    rhLaunchpad: config.rhLaunchpadAddress,
    rhRouter: config.rhRouterAddress,
    rhStartBlock: config.rhStartBlock,
    confirmations: config.confirmations,
    reorgDepth: config.reorgDepth,
  });
  // Idle nets that stay on empty fixtures still need a cursor rewind so they
  // do not pretend to be mid-history from a prior fixtures deploy.
  for (const net of ['SOL', 'RH'] as const) {
    if (!config.chainNets.includes(net)) await cursors.rewind(net, 0);
  }
} else {
  const scenario = canonicalScenario();
  logger.warn('running on FIXTURE events, not chain data', {
    events: scenario.events.length,
    heads: scenario.heads,
  });
  sources = {
    SOL: new FixtureEventSource('SOL', scenario.events),
    RH: new FixtureEventSource('RH', scenario.events),
  };
  // Safe precisely because ingest is idempotent, and only correct because
  // there is no chain: in chain mode this would re-walk history from genesis.
  for (const net of ['SOL', 'RH'] as const) await cursors.rewind(net, 0);
}

const runner = new IndexerRunner({
  cursors,
  ingestor,
  lag,
  logger,
  oracle: deps.oracle,
  sources,
  batchSize: config.batchSize,
  maxBatchAttempts: config.maxBatchAttempts,
  reorgDepth: config.reorgDepth,
  deadLetters,
  ...(rollback ? { rollback } : {}),
  onRollback: (net) => forgetCaches(net),
});

const http = startIndexerHttp({
  cursors,
  deadLetters,
  logger,
  host: config.httpHost,
  port: config.httpPort,
  tickMs: env.chainTickMs,
  maxLagSeconds: env.maxChainLagSeconds,
  mode: config.mode,
  isLeader: () => lock?.isHeld ?? true,
  now: deps.now,
});

let stopping = false;

const sweep = setInterval(() => {
  void runner.sweepAchievements().catch((err: unknown) => logger.error('sweep failed', { err: String(err) }));
}, config.sweepMs);
sweep.unref?.();

const shutdown = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  logger.info('shutting down', { signal });
  clearInterval(sweep);
  http?.close();
  await lock?.release();
  await lockHandle?.close();
  await close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

logger.info('indexer started', { mode: config.mode, pollMs: config.pollMs, httpPort: config.httpPort });
while (!stopping) {
  // `drain` already isolates the two chains from each other and never
  // rejects; this catch is for anything outside them (a lost database
  // connection), where retrying on the next tick is still the right answer.
  try {
    await runner.drain();
  } catch (err) {
    logger.error('indexer pass failed', { err: err instanceof Error ? err.message : String(err) });
  }
  await new Promise((resolve) => setTimeout(resolve, config.pollMs));
}
