/**
 * `@stonkz/indexer` — the dual-chain event indexer.
 *
 * Owns the chain event schema, the two replay cursors, the read-table ingest
 * and the fixture producer that drives all of it until the programs exist.
 * Every database definition and every ledger write comes from `@stonkz/api`,
 * so there is one schema and one set of award rules, not two.
 */

export {
  EVENT_KINDS,
  EventIntegrityError,
  assertEventIntegrity,
  assertFeeSplit,
  compareEvents,
  type ChainEvent,
  type ChainEventKind,
  type CashbackWindowEvent,
  type CreatorFeesClaimedEvent,
  type EventBase,
  type FeeAccruedEvent,
  type GraduatedEvent,
  type StakeClaimedEvent,
  type StakedEvent,
  type TokenCreatedEvent,
  type TradeEvent,
  type TreasuryCreditEvent,
  type UnstakedEvent,
} from './events.js';

export { ReplayCursors, type CursorState } from './cursors.js';
export { Ingestor, type IngestOptions, type IngestReport } from './ingest.js';
export { LagMonitor } from './lag.js';
export { IndexerRunner, type PassResult } from './runner.js';
export { FixtureEventSource, type EventSource } from './source.js';
export { TF_MS, TIMEFRAMES, bucketStart, candleUpdatesFor, type Timeframe } from './candles.js';
export { FixtureProducer, canonicalScenario, type ScenarioResult } from './fixtures/producer.js';
