import { buildDeps } from '@stonkz/api/app/deps';
import type { AppDeps } from '@stonkz/api/app/context';
import { FakePriceOracle, createFakeRpcs, type FakeChainRpc } from '@stonkz/api/chain/fake';
import { readEnv } from '@stonkz/api/env';
import { createLogger } from '@stonkz/api/observability/logger';
import { MemoryRedis } from '@stonkz/api/redis/memory';
import type { UserEvent } from '@stonkz/api/redis/channels';
import { createTestDb, type TestDb } from '@stonkz/api/test/harness';
import type { Net } from '@stonkz/shared';
import { ReplayCursors } from '../cursors.js';
import { DeadLetters } from '../deadletter.js';
import { Ingestor } from '../ingest.js';
import { LagMonitor } from '../lag.js';
import { ReorgRollback } from '../rollback.js';
import { IndexerRunner } from '../runner.js';
import { FixtureEventSource, type EventSource } from '../source.js';
import type { ChainEvent } from '../events.js';

/**
 * A whole indexer wired to the same fakes the API tests use — PGlite,
 * `MemoryRedis`, fake RPCs and a frozen oracle. `@stonkz/api` owns the schema
 * and the ledger, so a fixture replay here exercises exactly the code paths
 * production would.
 */
export interface IndexerTestRig {
  deps: AppDeps;
  db: TestDb;
  cursors: ReplayCursors;
  ingestor: Ingestor;
  runner: IndexerRunner;
  deadLetters: DeadLetters;
  rollback: ReorgRollback;
  rpcs: { SOL: FakeChainRpc; RH: FakeChainRpc };
  oracle: FakePriceOracle;
  published: { channel: string; data: unknown }[];
  userEvents: UserEvent[];
  setNow(ms: number): void;
  advance(ms: number): void;
  now(): number;
  /** Replaces both event sources, e.g. to replay a fresh scenario. */
  useEvents(events: readonly ChainEvent[]): void;
  close(): Promise<void>;
}

export const FROZEN_NOW = Date.parse('2026-09-06T12:00:00.000Z');

/**
 * Everything the durability tests need to switch on. All off by default, so a
 * plain fixture replay gets the same runner the fixture path gets in
 * production: no reorg detection (there are no hashes to compare) and no
 * dead-lettering.
 */
export interface RigOptions {
  startNow?: number;
  /** Replaces the fixture sources outright, for driving the runner directly. */
  sources?: Record<Net, EventSource>;
  /** Enables reorg detection and rollback, as `INDEXER_SOURCE=chain` does. */
  rollback?: boolean;
  deadLetters?: boolean;
  maxBatchAttempts?: number;
  reorgDepth?: Record<Net, number>;
  batchSize?: number;
}

export async function createIndexerRig(
  events: readonly ChainEvent[] = [],
  options: RigOptions = {},
): Promise<IndexerTestRig> {
  const startNow = options.startNow ?? FROZEN_NOW;
  const db = await createTestDb();
  let clock = startNow;
  const now = (): number => clock;

  const redis = new MemoryRedis(now);
  const rpcs = createFakeRpcs();
  const oracle = new FakePriceOracle({ SOL: 214.08, ETH: 4200 });

  const env = readEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    JWT_SECRET: 'test-secret-that-is-at-least-32-chars-long',
    CRATE_HMAC_SECRET: 'test-crate-secret-at-least-32-chars-long',
  });

  const built = await buildDeps(env, {
    db: db.db,
    redis,
    rpcs,
    oracle,
    logger: createLogger('silent'),
    now,
  });

  const published: { channel: string; data: unknown }[] = [];
  const userEvents: UserEvent[] = [];
  for (const pattern of ['board', 'tape', 'token:*', 'user:*']) {
    const record = (message: string, channel: string): void => {
      const data = JSON.parse(message) as unknown;
      published.push({ channel, data });
      if (channel.startsWith('user:')) userEvents.push(data as UserEvent);
    };
    if (pattern.includes('*')) await redis.psubscribe(pattern, record);
    else await redis.subscribe(pattern, record);
  }

  const logger = createLogger('silent');
  const cursors = new ReplayCursors(db.db, now);
  const ingestor = new Ingestor({
    db: db.db,
    ledger: built.deps.ledger,
    awards: built.deps.awards,
    referrals: built.deps.referrals,
    publisher: built.deps.publisher,
    logger,
    now,
  });
  const lag = new LagMonitor({ cursors, rpcs, metrics: built.deps.metrics, logger, tickMs: env.chainTickMs });

  const sources: Record<Net, EventSource> = options.sources ?? {
    SOL: new FixtureEventSource('SOL', events),
    RH: new FixtureEventSource('RH', events),
    BASE: new FixtureEventSource('BASE', []),
  };
  const deadLetters = new DeadLetters({ db: db.db, logger, now });
  const rollback = new ReorgRollback({ db: db.db, logger, now });
  const runner = new IndexerRunner({
    cursors,
    ingestor,
    lag,
    logger,
    oracle,
    sources,
    ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
    ...(options.maxBatchAttempts === undefined ? {} : { maxBatchAttempts: options.maxBatchAttempts }),
    ...(options.reorgDepth === undefined ? {} : { reorgDepth: options.reorgDepth }),
    ...(options.rollback ? { rollback } : {}),
    ...(options.deadLetters ? { deadLetters } : {}),
  });

  // The lag monitor reads heads off the RPCs, so point them at the fixtures.
  rpcs.SOL.setHead(await sources.SOL.head());
  rpcs.RH.setHead(await sources.RH.head());

  return {
    deps: built.deps,
    db,
    cursors,
    ingestor,
    runner,
    deadLetters,
    rollback,
    rpcs,
    oracle,
    published,
    userEvents,
    now,
    setNow: (ms) => {
      clock = ms;
    },
    advance: (ms) => {
      clock += ms;
    },
    useEvents(next) {
      sources.SOL = new FixtureEventSource('SOL', next);
      sources.RH = new FixtureEventSource('RH', next);
    },
    async close() {
      await built.close();
      await db.close();
    },
  };
}
