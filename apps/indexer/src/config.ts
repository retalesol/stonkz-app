import type { ApiEnv } from '@stonkz/api/env';
import { ZERO_EVM_ADDRESS } from '@stonkz/api/env';
import type { Net } from '@stonkz/shared';

/**
 * The indexer's own knobs.
 *
 * Deliberately read here rather than added to `ApiEnv`: none of these mean
 * anything to `apps/api`, and Phase C's scope keeps `apps/api` to the schema
 * changes reorg rollback and dead-lettering actually require. Everything the
 * two processes must agree on (RPC URLs, program addresses, chain tick, lag
 * threshold) still comes from `ApiEnv`.
 */
export type IndexerSourceMode = 'fixtures' | 'chain';

export interface IndexerConfig {
  mode: IndexerSourceMode;
  pollMs: number;
  sweepMs: number;
  /** Positions consumed per pass, per chain. */
  batchSize: number;
  /**
   * Consecutive failed passes at the same position before the batch is
   * dead-lettered and skipped. `1` would skip on the first transient RPC
   * blip; the default gives a dependency ~10s (5 × `pollMs`) to recover.
   */
  maxBatchAttempts: number;
  /**
   * How far behind the raw tip ingest is allowed to materialise, per chain.
   *
   * Solana is `0` because the source reads at `finalized` commitment, which is
   * already the post-reorg view — a finalized slot is what the cluster agreed
   * cannot be rolled back, so subtracting slots on top of it only adds lag.
   * Robinhood Chain has no equivalent, so it gets a real block buffer.
   */
  confirmations: Record<Net, number>;
  /**
   * How far back the cursor rewinds when a reorg is detected at it. The
   * rollback itself is exact (it deletes by position), so this only has to be
   * deep enough to land on a block whose hash still matches.
   */
  reorgDepth: Record<Net, number>;
  /** `0` disables the HTTP surface entirely. */
  httpPort: number;
  httpHost: string;
  /** Postgres advisory lock guarding single-replica operation. */
  singleReplicaLock: boolean;
  lockKey: number;

  /* ------------------------------------------------------------- Solana */
  solanaProgramId: string;
  /** Slot the program was deployed at. A fresh cursor starts here, not at 0. */
  solanaStartSlot: number;
  /** `getSignaturesForAddress` page size; the RPC caps this at 1000. */
  solanaSignaturePageSize: number;
  /** Upper bound on transactions fetched per pass, so one pass stays bounded. */
  solanaMaxTxPerPass: number;
  /** Whether to spend a `getBlock` call per pass to fetch the cursor slot's blockhash. */
  solanaTrackBlockhash: boolean;

  /* ----------------------------------------------------------------- RH */
  rhLaunchpadAddress: string;
  rhRouterAddress: string;
  rhStartBlock: number;
  /** `eth_getLogs` window; providers commonly cap this well below `batchSize`. */
  rhLogWindow: number;
}

export type ConfigSource = Record<string, string | undefined>;

function str(src: ConfigSource, key: string, fallback: string): string {
  const v = src[key];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

function int(src: ConfigSource, key: string, fallback: number): number {
  const raw = src[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`env ${key} must be an integer, got ${JSON.stringify(raw)}`);
  return n;
}

function bool(src: ConfigSource, key: string, fallback: boolean): boolean {
  const raw = src[key]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (raw === '1' || raw === 'true' || raw === 'yes') return true;
  if (raw === '0' || raw === 'false' || raw === 'no') return false;
  throw new Error(`env ${key} must be a boolean, got ${JSON.stringify(raw)}`);
}

/**
 * `pg_try_advisory_lock` takes a `bigint`. Derived from a fixed string so two
 * deploys of the same service collide by default without an operator having to
 * pick a magic number, but overridable for a second isolated environment
 * sharing one database.
 */
export const DEFAULT_LOCK_KEY = 0x53_74_6f_6e_6b_7a; // "Stonkz"

export function readIndexerConfig(env: ApiEnv, src: ConfigSource = process.env): IndexerConfig {
  const mode = str(src, 'INDEXER_SOURCE', 'fixtures');
  if (mode !== 'fixtures' && mode !== 'chain') {
    throw new Error(`INDEXER_SOURCE must be "fixtures" or "chain", got ${JSON.stringify(mode)}`);
  }

  const config: IndexerConfig = {
    mode,
    pollMs: int(src, 'INDEXER_POLL_MS', 2_000),
    sweepMs: int(src, 'INDEXER_SWEEP_MS', 60_000),
    batchSize: int(src, 'INDEXER_BATCH_SIZE', 5_000),
    maxBatchAttempts: int(src, 'INDEXER_MAX_BATCH_ATTEMPTS', 5),
    confirmations: {
      SOL: int(src, 'INDEXER_SOL_CONFIRMATIONS', 0),
      RH: int(src, 'INDEXER_RH_CONFIRMATIONS', 12),
    },
    reorgDepth: {
      SOL: int(src, 'INDEXER_SOL_REORG_DEPTH', 32),
      RH: int(src, 'INDEXER_RH_REORG_DEPTH', 64),
    },
    httpPort: int(src, 'INDEXER_HTTP_PORT', 8788),
    httpHost: str(src, 'INDEXER_HTTP_HOST', '0.0.0.0'),
    singleReplicaLock: bool(src, 'INDEXER_SINGLE_REPLICA_LOCK', true),
    lockKey: int(src, 'INDEXER_LOCK_KEY', DEFAULT_LOCK_KEY),

    solanaProgramId: str(src, 'SOLANA_LAUNCHPAD_PROGRAM_ID', env.solanaLaunchpadProgramId),
    solanaStartSlot: int(src, 'INDEXER_SOL_START_SLOT', 0),
    solanaSignaturePageSize: Math.min(1_000, Math.max(1, int(src, 'INDEXER_SOL_SIGNATURE_PAGE', 1_000))),
    solanaMaxTxPerPass: int(src, 'INDEXER_SOL_MAX_TX_PER_PASS', 200),
    solanaTrackBlockhash: bool(src, 'INDEXER_SOL_TRACK_BLOCKHASH', false),

    rhLaunchpadAddress: str(src, 'RH_LAUNCHPAD_ADDRESS', env.rhLaunchpadAddress),
    rhRouterAddress: str(src, 'RH_ROUTER_ADDRESS', env.rhRouterAddress),
    rhStartBlock: int(src, 'INDEXER_RH_START_BLOCK', 0),
    rhLogWindow: int(src, 'INDEXER_RH_LOG_WINDOW', 2_000),
  };

  if (config.mode === 'chain') assertChainModeConfigured(config);
  return config;
}

/**
 * Chain mode has hard prerequisites. Refusing at boot is the whole point: an
 * indexer pointed at the zero address would poll forever, find nothing, and
 * look healthy while the board stayed empty.
 */
export function assertChainModeConfigured(config: IndexerConfig): void {
  if (config.rhLaunchpadAddress.toLowerCase() === ZERO_EVM_ADDRESS) {
    throw new Error(
      'INDEXER_SOURCE=chain needs RH_LAUNCHPAD_ADDRESS; the zero address means "not deployed here"',
    );
  }
  if (config.solanaStartSlot <= 0) {
    throw new Error(
      'INDEXER_SOURCE=chain needs INDEXER_SOL_START_SLOT (the deployment slot); a fresh cursor must not walk Solana from genesis',
    );
  }
  if (config.rhStartBlock <= 0) {
    throw new Error('INDEXER_SOURCE=chain needs INDEXER_RH_START_BLOCK (the deployment block)');
  }
  for (const net of ['SOL', 'RH'] as const) {
    if (config.confirmations[net] < 0) throw new Error(`INDEXER_${net}_CONFIRMATIONS must not be negative`);
    if (config.reorgDepth[net] < 1) throw new Error(`INDEXER_${net}_REORG_DEPTH must be at least 1`);
  }
  if (config.maxBatchAttempts < 1) throw new Error('INDEXER_MAX_BATCH_ATTEMPTS must be at least 1');
}
