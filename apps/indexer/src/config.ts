import type { ApiEnv } from '@stonkz/api/env';
import { ZERO_EVM_ADDRESS } from '@stonkz/api/env';
import { ALL_NETS, parseNet, type Net } from '@stonkz/shared';

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
  /** Which nets ingest from chain when `mode === 'chain'`. Fixtures still cover the rest. */
  chainNets: Net[];
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
  /**
   * Every router whose `AtomicBuy`/`AtomicSell` are ingested on RH (current +
   * predecessors) — see {@link routerAddressList}.
   */
  rhRouterAddresses: string[];
  rhStartBlock: number;
  /** `eth_getLogs` window; providers commonly cap this well below `batchSize`. */
  rhLogWindow: number;

  /* --------------------------------------------------------------- Base */
  baseLaunchpadAddress: string;
  baseRouterAddress: string;
  baseRouterAddresses: string[];
  baseStartBlock: number;
  baseLogWindow: number;

  /* ---------------------------------------------------------------- Arc */
  arcLaunchpadAddress: string;
  arcRouterAddress: string;
  arcRouterAddresses: string[];
  arcStartBlock: number;
  arcLogWindow: number;
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
  if (!Number.isFinite(n))
    throw new Error(`env ${key} must be an integer, got ${JSON.stringify(raw)}`);
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

/**
 * Routers that were live before the current one, by chain id. `StonkzRouter`
 * is immutable, so the atomic-launch redeploy (`UpgradeAtomicLaunch.s.sol`)
 * leaves the previous router trading: its `AtomicBuy`/`AtomicSell` must still
 * be attributed to the wallet (and carry the exact ETH leg) until nobody
 * routes through it. Pinned per chain id so a mainnet indexer never trusts a
 * testnet address.
 */
export const LEGACY_ROUTERS: Readonly<Record<number, readonly string[]>> = {
  // Robinhood Chain testnet — deployments/46630.json, 2026-09-27 redeploy.
  46630: ['0xC98F8214999220CE06E04ca8739A34Cb8AF5779c'],
  // Base Sepolia — deployments/84532.json, 2026-09-27 redeploy.
  84532: ['0x05B245FBDF5ACbfFc3cEEFFFB1648E1dCbF5413d'],
};

/**
 * `<NET>_ROUTER_ADDRESSES` (comma list) when set, else the chain's
 * {@link LEGACY_ROUTERS}; always plus `<NET>_ROUTER_ADDRESS`, the router the
 * API sends trades to. Lowercased, de-duplicated, zero address dropped. The
 * emitter check stays strict: only these addresses' router events count.
 */
export function routerAddressList(
  src: ConfigSource,
  listKey: string,
  current: string,
  chainId: number,
): string[] {
  const raw = src[listKey];
  const listed =
    raw !== undefined && raw.trim() !== '' ? raw.split(',') : [...(LEGACY_ROUTERS[chainId] ?? [])];
  const out: string[] = [];
  for (const [i, a] of [current, ...listed].entries()) {
    const v = a.trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(v)) {
      // A typo in the list must not silently drop a router's fills.
      if (i > 0 && v !== '') {
        throw new Error(`env ${listKey}: ${JSON.stringify(a.trim())} is not an address`);
      }
      continue;
    }
    if (v === ZERO_EVM_ADDRESS || out.includes(v)) continue;
    out.push(v);
  }
  return out;
}

export function readIndexerConfig(env: ApiEnv, src: ConfigSource = process.env): IndexerConfig {
  const mode = str(src, 'INDEXER_SOURCE', 'chain');
  if (mode !== 'fixtures' && mode !== 'chain') {
    throw new Error(`INDEXER_SOURCE must be "fixtures" or "chain", got ${JSON.stringify(mode)}`);
  }
  if (mode === 'fixtures') {
    const allowFixtures = bool(src, 'INDEXER_ALLOW_FIXTURES', env.nodeEnv !== 'production');
    if (!allowFixtures) {
      throw new Error(
        'INDEXER_SOURCE=fixtures is disabled in production; set INDEXER_SOURCE=chain (or INDEXER_ALLOW_FIXTURES=1 for explicit test/replay only)',
      );
    }
  }

  // ARC is deliberately not in the default: it joins once a launchpad exists
  // there. `INDEXER_CHAIN_NETS=SOL,RH,BASE,ARC` opts in and then requires
  // ARC_LAUNCHPAD_ADDRESS + INDEXER_ARC_START_BLOCK like every other net.
  const chainNetsRaw = str(src, 'INDEXER_CHAIN_NETS', 'SOL,RH')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const chainNets = [...new Set(chainNetsRaw)]
    .map((n) => parseNet(n))
    .filter((n): n is Net => n !== null);
  if (mode === 'chain' && chainNets.length === 0) {
    throw new Error(
      `INDEXER_CHAIN_NETS must list one or more of ${ALL_NETS.join(', ')} when INDEXER_SOURCE=chain`,
    );
  }

  const config: IndexerConfig = {
    mode,
    chainNets: mode === 'chain' ? chainNets : [],
    pollMs: int(src, 'INDEXER_POLL_MS', 2_000),
    sweepMs: int(src, 'INDEXER_SWEEP_MS', 60_000),
    batchSize: int(src, 'INDEXER_BATCH_SIZE', 5_000),
    maxBatchAttempts: int(src, 'INDEXER_MAX_BATCH_ATTEMPTS', 5),
    confirmations: {
      SOL: int(src, 'INDEXER_SOL_CONFIRMATIONS', 0),
      RH: int(src, 'INDEXER_RH_CONFIRMATIONS', 12),
      BASE: int(src, 'INDEXER_BASE_CONFIRMATIONS', 12),
      // Arc finalises in under a second, so one block is already final.
      ARC: int(src, 'INDEXER_ARC_CONFIRMATIONS', 1),
    },
    reorgDepth: {
      SOL: int(src, 'INDEXER_SOL_REORG_DEPTH', 32),
      RH: int(src, 'INDEXER_RH_REORG_DEPTH', 64),
      BASE: int(src, 'INDEXER_BASE_REORG_DEPTH', 64),
      // Deterministic finality: a finalised Arc block cannot be reorged.
      ARC: int(src, 'INDEXER_ARC_REORG_DEPTH', 0),
    },
    // Railway injects PORT; prefer an explicit INDEXER_HTTP_PORT, then PORT.
    httpPort: int(src, 'INDEXER_HTTP_PORT', int(src, 'PORT', 8788)),
    httpHost: str(src, 'INDEXER_HTTP_HOST', '0.0.0.0'),
    singleReplicaLock: bool(src, 'INDEXER_SINGLE_REPLICA_LOCK', true),
    lockKey: int(src, 'INDEXER_LOCK_KEY', DEFAULT_LOCK_KEY),

    solanaProgramId: str(src, 'SOLANA_LAUNCHPAD_PROGRAM_ID', env.solanaLaunchpadProgramId),
    solanaStartSlot: int(src, 'INDEXER_SOL_START_SLOT', 0),
    solanaSignaturePageSize: Math.min(
      1_000,
      Math.max(1, int(src, 'INDEXER_SOL_SIGNATURE_PAGE', 1_000)),
    ),
    solanaMaxTxPerPass: int(src, 'INDEXER_SOL_MAX_TX_PER_PASS', 200),
    solanaTrackBlockhash: bool(src, 'INDEXER_SOL_TRACK_BLOCKHASH', false),

    rhLaunchpadAddress: str(src, 'RH_LAUNCHPAD_ADDRESS', env.rhLaunchpadAddress),
    rhRouterAddress: str(src, 'RH_ROUTER_ADDRESS', env.rhRouterAddress),
    rhRouterAddresses: routerAddressList(
      src,
      'RH_ROUTER_ADDRESSES',
      str(src, 'RH_ROUTER_ADDRESS', env.rhRouterAddress),
      env.rhChainId,
    ),
    rhStartBlock: int(src, 'INDEXER_RH_START_BLOCK', 0),
    rhLogWindow: int(src, 'INDEXER_RH_LOG_WINDOW', 2_000),

    baseLaunchpadAddress: str(src, 'BASE_LAUNCHPAD_ADDRESS', env.baseLaunchpadAddress),
    baseRouterAddress: str(src, 'BASE_ROUTER_ADDRESS', env.baseRouterAddress),
    baseRouterAddresses: routerAddressList(
      src,
      'BASE_ROUTER_ADDRESSES',
      str(src, 'BASE_ROUTER_ADDRESS', env.baseRouterAddress),
      env.baseChainId,
    ),
    baseStartBlock: int(src, 'INDEXER_BASE_START_BLOCK', 0),
    baseLogWindow: int(src, 'INDEXER_BASE_LOG_WINDOW', 2_000),

    arcLaunchpadAddress: str(src, 'ARC_LAUNCHPAD_ADDRESS', env.arcLaunchpadAddress),
    arcRouterAddress: str(src, 'ARC_ROUTER_ADDRESS', env.arcRouterAddress),
    arcRouterAddresses: routerAddressList(
      src,
      'ARC_ROUTER_ADDRESSES',
      str(src, 'ARC_ROUTER_ADDRESS', env.arcRouterAddress),
      env.arcChainId,
    ),
    arcStartBlock: int(src, 'INDEXER_ARC_START_BLOCK', 0),
    arcLogWindow: int(src, 'INDEXER_ARC_LOG_WINDOW', 2_000),
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
  if (config.chainNets.includes('RH')) {
    if (config.rhLaunchpadAddress.toLowerCase() === ZERO_EVM_ADDRESS) {
      throw new Error(
        'INDEXER_SOURCE=chain needs RH_LAUNCHPAD_ADDRESS; the zero address means "not deployed here"',
      );
    }
    if (config.rhStartBlock <= 0) {
      throw new Error('INDEXER_SOURCE=chain needs INDEXER_RH_START_BLOCK (the deployment block)');
    }
  }
  if (config.chainNets.includes('BASE')) {
    if (config.baseLaunchpadAddress.toLowerCase() === ZERO_EVM_ADDRESS) {
      throw new Error(
        'INDEXER_SOURCE=chain needs BASE_LAUNCHPAD_ADDRESS; the zero address means "not deployed here"',
      );
    }
    if (config.baseStartBlock <= 0) {
      throw new Error('INDEXER_SOURCE=chain needs INDEXER_BASE_START_BLOCK (the deployment block)');
    }
  }
  if (config.chainNets.includes('ARC')) {
    if (config.arcLaunchpadAddress.toLowerCase() === ZERO_EVM_ADDRESS) {
      throw new Error(
        'INDEXER_SOURCE=chain needs ARC_LAUNCHPAD_ADDRESS; the zero address means "not deployed here"',
      );
    }
    if (config.arcStartBlock <= 0) {
      throw new Error('INDEXER_SOURCE=chain needs INDEXER_ARC_START_BLOCK (the deployment block)');
    }
  }
  if (config.chainNets.includes('SOL')) {
    if (config.solanaStartSlot <= 0) {
      throw new Error(
        'INDEXER_SOURCE=chain needs INDEXER_SOL_START_SLOT (the deployment slot); a fresh cursor must not walk Solana from genesis',
      );
    }
  }
  for (const net of config.chainNets) {
    if (config.confirmations[net] < 0)
      throw new Error(`INDEXER_${net}_CONFIRMATIONS must not be negative`);
    // A net with deterministic finality (Arc) may run with reorg depth 0:
    // its cursor never has to rewind. Every probabilistic chain needs >= 1.
    const minReorgDepth = net === 'ARC' ? 0 : 1;
    if (config.reorgDepth[net] < minReorgDepth)
      throw new Error(`INDEXER_${net}_REORG_DEPTH must be at least ${minReorgDepth}`);
  }
  if (config.maxBatchAttempts < 1) throw new Error('INDEXER_MAX_BATCH_ATTEMPTS must be at least 1');
}
