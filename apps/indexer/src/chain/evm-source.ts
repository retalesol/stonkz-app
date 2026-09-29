import type { BaseMintRegistry } from '@stonkz/api/router/base-mints';
import type { Logger } from '@stonkz/api/observability/logger';
import { isEvmNet, type EvmNet, type Net } from '@stonkz/shared';
import type { ChainEvent } from '../events.js';
import { compareEvents } from '../events.js';
import type { EventSource, PollResult } from '../source.js';
import { decodeStonkzLog, type RawEvmLog } from './evm-events.js';
import { mapEvmTransaction, type EvmTxLog } from './evm-map.js';
import type { EvmIndexRpc } from './evm-rpc.js';
import type { TokenRegistry } from './registry.js';

/**
 * The real Robinhood Chain event source: an `eth_getLogs` poller over the
 * launchpad and router contracts.
 *
 * **Why `getLogs` and not a subscription.** `eth_subscribe("logs")` is a push
 * with the same blind spot a Helius webhook has — a dropped socket loses logs
 * with no independent signal that anything was missed, so a reconciling
 * `getLogs` poller is needed regardless. Rather than run both, this runs the
 * poller alone; a subscription could later shorten the latency but could not
 * replace it. Same reasoning as `solana-source.ts`.
 *
 * **Confirmation depth is real work here, unlike on Solana.** There is no
 * `finalized` commitment to lean on, so `confirmedHead()` is
 * `eth_blockNumber - INDEXER_RH_CONFIRMATIONS` and nothing at or above the raw
 * tip is ever materialised. `blockIdentity()` returns the block hash at the
 * cursor so the runner can detect that history changed underneath it.
 *
 * **Window capping.** Providers cap `eth_getLogs` spans (and separately cap
 * result counts). A pass therefore asks for at most `logWindow` blocks and
 * reports how far it actually covered via `PollResult.coveredTo`, so the
 * cursor advances by what was really read rather than by what was requested.
 */
export interface EvmChainSourceOptions {
  net?: EvmNet;
  rpc: EvmIndexRpc;
  launchpadAddress: string;
  routerAddress: string;
  /**
   * Every `StonkzRouter` whose `AtomicBuy`/`AtomicSell` count on this chain —
   * the current one and any predecessor still trading (a router is immutable,
   * so a redeploy leaves the old one live). Unioned with `routerAddress`.
   */
  routerAddresses?: readonly string[];
  /** Deployment block. A fresh cursor starts here, never at 0. */
  startBlock: number;
  registry: TokenRegistry;
  baseMints: BaseMintRegistry;
  /** Spot ETH/USD, for fills whose base asset is not wrapped ETH. */
  nativeUsd: () => Promise<number>;
  logger: Logger;
  confirmations?: number;
  /** Blocks per `eth_getLogs` call. */
  logWindow?: number;
}

export class EvmChainSource implements EventSource {
  readonly net: Net;

  private readonly addresses: readonly string[];
  private readonly emitters: LogEmitters;
  private readonly confirmations: number;
  private readonly logWindow: number;

  constructor(private readonly opts: EvmChainSourceOptions) {
    this.net = opts.net ?? 'RH';
    this.confirmations = Math.max(0, opts.confirmations ?? 12);
    this.logWindow = Math.max(1, opts.logWindow ?? 2_000);
    // Routers are optional: on a deployment without one every fill is a
    // direct curve call, and filtering on the zero address would make the
    // provider return the (many) logs of accounts that burn to it.
    const routers = [
      ...new Set(
        [opts.routerAddress, ...(opts.routerAddresses ?? [])]
          .map((a) => a.trim().toLowerCase())
          .filter((a) => a !== '' && !/^0x0{40}$/.test(a)),
      ),
    ];
    this.addresses = [opts.launchpadAddress.toLowerCase(), ...routers];
    this.emitters = {
      launchpad: opts.launchpadAddress.toLowerCase(),
      routers,
    };
  }

  async head(): Promise<number> {
    return this.opts.rpc.blockNumber();
  }

  async confirmedHead(): Promise<number> {
    return Math.max(0, (await this.head()) - this.confirmations);
  }

  async startPosition(): Promise<number> {
    return this.opts.startBlock;
  }

  async blockIdentity(position: number): Promise<string | null> {
    const block = await this.opts.rpc.getBlock(position);
    return block?.hash ?? null;
  }

  /** Kept for interface compatibility; `pollRange` is what the runner uses. */
  async poll(fromExclusive: number, toInclusive: number): Promise<ChainEvent[]> {
    return (await this.pollRange(fromExclusive, toInclusive)).events;
  }

  async pollRange(fromExclusive: number, toInclusive: number): Promise<PollResult> {
    if (toInclusive <= fromExclusive) {
      return { events: [], coveredTo: fromExclusive };
    }

    const from = fromExclusive + 1;
    const { raw, to } = await this.getLogsAdaptive(
      from,
      Math.min(toInclusive, from + this.logWindow - 1),
    );
    const groups = groupByTransaction(raw, this.opts.logger, this.emitters, this.net);
    if (groups.length === 0) return { events: [], coveredTo: to };

    const nativeUsdPrice = await this.readNativeUsd();
    const blockTimes = new Map<number, number>();

    const events: ChainEvent[] = [];
    for (const group of groups) {
      events.push(
        ...(await mapEvmTransaction(group.logs, {
          net: isEvmNet(this.net) ? this.net : 'RH',
          txHash: group.txHash,
          blockNumber: group.blockNumber,
          blockTimeMs: await this.blockTimeMs(group.blockNumber, blockTimes),
          registry: this.opts.registry,
          baseMints: this.opts.baseMints,
          nativeUsdPrice,
        })),
      );
    }

    events.sort(compareEvents);
    return { events, coveredTo: to };
  }

  /**
   * `eth_getLogs` for `[from, to]`, halving the window when the provider
   * refuses it for size.
   *
   * Providers cap both the block span and the result count of one call, and
   * the result cap is data-dependent: a window that is fine today fails the
   * day a launch goes viral. Retrying the *same* window then fails
   * deterministically until the runner dead-letters it — skipping every event
   * in it, launches included. Halving until it fits turns that into a slower
   * pass that still makes progress; `coveredTo` reports the narrower window,
   * so the cursor only moves over what was read. Errors that are not about
   * size (timeouts, 5xx) are rethrown unchanged for the runner's retry path.
   */
  private async getLogsAdaptive(
    from: number,
    initialTo: number,
  ): Promise<{ raw: RawEvmLog[]; to: number }> {
    let to = initialTo;
    for (;;) {
      try {
        const raw = await this.opts.rpc.getLogs({
          fromBlock: from,
          toBlock: to,
          addresses: this.addresses,
        });
        return { raw, to };
      } catch (err) {
        if (to <= from || !isLogWindowTooLarge(err)) throw err;
        const narrower = from + Math.floor((to - from) / 2);
        this.opts.logger.warn('getLogs window refused; narrowing', {
          net: this.net,
          from,
          to,
          narrower,
          err: err instanceof Error ? err.message : String(err),
        });
        to = narrower;
      }
    }
  }

  /**
   * `eth_getLogs` results carry no timestamp, so a block header is fetched per
   * distinct block in the pass and cached for its duration.
   *
   * A block that has logs but no header is an RPC inconsistency (a
   * load-balanced provider answering from a node that is behind), not a fact
   * about the chain — the block is already `confirmations` deep. It fails the
   * pass so it is retried: materialising the events with a zero timestamp
   * stamps the launch, its trades and their candles at 1970.
   */
  private async blockTimeMs(blockNumber: number, cache: Map<number, number>): Promise<number> {
    const hit = cache.get(blockNumber);
    if (hit !== undefined) return hit;
    const block = await this.opts.rpc.getBlock(blockNumber);
    const ts = block?.timestampMs ?? 0;
    if (!(ts > 0)) {
      this.opts.logger.warn('evm block header missing for a block with logs', {
        net: this.net,
        blockNumber,
      });
      throw new Error(`${this.net} block ${blockNumber} has logs but no header timestamp`);
    }
    cache.set(blockNumber, ts);
    return ts;
  }

  private async readNativeUsd(): Promise<number> {
    try {
      return await this.opts.nativeUsd();
    } catch (err) {
      // See `solana-source.ts`: only non-native-base fills need this, and 0
      // records an honest zero rather than a figure from a stale price.
      this.opts.logger.warn(
        'native price unavailable; non-native-base fills will record 0 native',
        {
          net: this.net,
          err: err instanceof Error ? err.message : String(err),
        },
      );
      return 0;
    }
  }
}

export interface EvmTxGroup {
  txHash: string;
  blockNumber: number;
  blockHash: string;
  logs: EvmTxLog[];
}

/**
 * Decodes a pass's logs and groups them per transaction, in chain order.
 *
 * Grouping is required, not a convenience: a launchpad transaction emits
 * `Trade`, `FeeAccrued` and `TreasuryCredit` together, and the mapper needs
 * all three at once to reconcile the fee split and drop the redundant credit.
 *
 * `removed: true` logs are dropped here. A confirmed pass should never see one
 * — the depth buffer keeps ingest behind the reorg zone — but a provider that
 * ignores `toBlock` and replies from its own head could, and materialising a
 * log the chain has already disowned is exactly the failure the buffer exists
 * to prevent.
 */
export interface LogEmitters {
  /** Lowercased launchpad address. */
  launchpad: string;
  /** Lowercased router addresses (current and predecessors); empty when this deployment has none. */
  routers: readonly string[];
}

const ROUTER_EVENTS = new Set(['AtomicBuy', 'AtomicSell']);

/** A provider's "this `eth_getLogs` is too big" answer, as opposed to an outage. */
export function isLogWindowTooLarge(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  // A rate limit is not a size problem: narrowing would only multiply calls.
  if (/rate.?limit|too many requests|\b429\b/i.test(message)) return false;
  return /more than \d+ results|too many (results|logs)|response size|block range|range (is )?too (large|wide)|exceeds? (the )?(max|maximum|limit)|limit of \d+|result(s)? (limit|cap)/i.test(
    message,
  );
}

export function groupByTransaction(
  raw: readonly RawEvmLog[],
  logger: Logger,
  emitters?: LogEmitters,
  net: Net = 'RH',
): EvmTxGroup[] {
  const groups = new Map<string, EvmTxGroup>();
  let removed = 0;
  let foreign = 0;

  for (const log of raw) {
    if (log.removed === true) {
      removed++;
      continue;
    }
    const decoded = decodeStonkzLog(log);
    // Not an error: a launchpad transaction also emits ERC-20 `Transfer`s, and
    // the address filter cannot exclude them.
    if (!decoded) continue;

    // Only our own contracts' logs count, and each event only from the
    // contract that declares it. The `eth_getLogs` address filter normally
    // guarantees the first half — but the ABI is public, anyone can deploy a
    // contract that emits a byte-identical `TokenCreated` or `Trade`, and a
    // provider that ignores or mangles the filter must not be able to turn
    // that into a listed token or a paid trade.
    if (emitters) {
      const from = log.address.toLowerCase();
      const allowed = ROUTER_EVENTS.has(decoded.name)
        ? emitters.routers.includes(from)
        : from === emitters.launchpad;
      if (!allowed) {
        foreign++;
        continue;
      }
    }

    const txHash = log.transactionHash.toLowerCase();
    const existing = groups.get(txHash);
    const entry: EvmTxLog = { logIndex: Number(BigInt(log.logIndex)), event: decoded };
    if (existing) {
      existing.logs.push(entry);
    } else {
      groups.set(txHash, {
        txHash,
        blockNumber: Number(BigInt(log.blockNumber)),
        blockHash: log.blockHash,
        logs: [entry],
      });
    }
  }

  if (removed > 0) {
    logger.warn('getLogs returned reorg-removed logs inside a confirmed range', {
      net,
      removed,
    });
  }
  if (foreign > 0) {
    logger.warn('getLogs returned Stonkz-shaped logs from an unexpected emitter; ignored', {
      net,
      foreign,
    });
  }

  for (const group of groups.values()) {
    group.logs.sort((a, b) => a.logIndex - b.logIndex);
  }

  return [...groups.values()].sort((a, b) =>
    a.blockNumber !== b.blockNumber
      ? a.blockNumber - b.blockNumber
      : (a.logs[0]?.logIndex ?? 0) - (b.logs[0]?.logIndex ?? 0),
  );
}
