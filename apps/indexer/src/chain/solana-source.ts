import type { BaseMintRegistry } from '@stonkz/api/router/base-mints';
import type { Logger } from '@stonkz/api/observability/logger';
import type { Net } from '@stonkz/shared';
import type { ChainEvent } from '../events.js';
import { compareEvents } from '../events.js';
import type { EventSource, PollResult } from '../source.js';
import { cpiEventPayloads, programDataPayloads } from './anchor.js';
import { mapSolanaTransaction } from './solana-map.js';
import { launchpadEventCoder, type SolanaLaunchpadEvent } from './solana-events.js';
import type { SignatureInfo, SolanaIndexRpc, SolanaTransaction } from './solana-rpc.js';
import type { TokenRegistry } from './registry.js';

/**
 * The real Solana event source: a `getSignaturesForAddress` +
 * `getTransaction` poller keyed off the launchpad program id.
 *
 * **Why polling and not webhooks.** A Helius webhook is a push with no
 * independent "what did I miss" signal — the only way to detect a dropped
 * delivery is to compare the cursor against the chain's own head, which is a
 * poll. Every webhook design therefore needs a reconciling poller anyway, so
 * the poller is the primary here and a webhook can only ever be latency
 * acceleration on top of it. `docs/indexer-runbooks.md` §8 records that
 * reasoning; the design follows it rather than contradicting it.
 *
 * **Commitment.** Everything reads at `finalized`. That *is* this chain's
 * reorg policy: a finalized slot is one the cluster has agreed cannot be
 * rolled back, so ingesting only finalized transactions removes the class of
 * problem a confirmation-depth buffer exists to solve. The buffer is still
 * configurable (`INDEXER_SOL_CONFIRMATIONS`) and still enforced, it just
 * defaults to 0 because subtracting slots from a finalized head only adds lag.
 *
 * **Ordering.** `getSignaturesForAddress` returns newest-first and pages
 * backwards via `before`, stopping at `until`. The cursor bookmark is the last
 * committed signature, passed as `until`, so a steady-state pass walks only
 * what is new instead of re-scanning from the tip. The collected page set is
 * then reversed into chain order before any transaction is fetched.
 */
export interface SolanaChainSourceOptions {
  rpc: SolanaIndexRpc;
  programId: string;
  /** Deployment slot. A fresh cursor starts here, never at 0. */
  startSlot: number;
  registry: TokenRegistry;
  baseMints: BaseMintRegistry;
  /** Spot SOL/USD, for fills whose base asset is not wrapped SOL. */
  nativeUsd: () => Promise<number>;
  logger: Logger;
  confirmations?: number;
  signaturePageSize?: number;
  maxTxPerPass?: number;
  /** Spend a `getBlock` per reorg check. Off by default — finalized slots do not fork. */
  trackBlockhash?: boolean;
  /**
   * Hard cap on signature pages per pass. Hitting it is an operator problem
   * (the batch spans more program activity than one pass can hold), so it
   * raises rather than silently truncating the older end of the range — which
   * is exactly the end the cursor is about to advance past.
   */
  maxSignaturePages?: number;
}

export class SolanaRangeTooBusyError extends Error {
  constructor(
    readonly fromExclusive: number,
    readonly toInclusive: number,
    readonly pages: number,
  ) {
    super(
      `SOL slots (${fromExclusive}, ${toInclusive}] hold more than ${pages} pages of program activity; lower INDEXER_BATCH_SIZE`,
    );
    this.name = 'SolanaRangeTooBusyError';
  }
}

export class SolanaChainSource implements EventSource {
  readonly net: Net = 'SOL';

  private readonly confirmations: number;
  private readonly pageSize: number;
  private readonly maxTxPerPass: number;
  private readonly maxSignaturePages: number;
  private readonly trackBlockhash: boolean;
  private bookmarkSignature: string | null = null;

  constructor(private readonly opts: SolanaChainSourceOptions) {
    this.confirmations = Math.max(0, opts.confirmations ?? 0);
    this.pageSize = Math.min(1_000, Math.max(1, opts.signaturePageSize ?? 1_000));
    this.maxTxPerPass = Math.max(1, opts.maxTxPerPass ?? 200);
    this.maxSignaturePages = Math.max(1, opts.maxSignaturePages ?? 20);
    this.trackBlockhash = opts.trackBlockhash ?? false;
  }

  async head(): Promise<number> {
    return this.opts.rpc.getSlot('finalized');
  }

  async confirmedHead(): Promise<number> {
    return Math.max(0, (await this.head()) - this.confirmations);
  }

  async startPosition(): Promise<number> {
    return this.opts.startSlot;
  }

  restoreBookmark(bookmark: string | null): void {
    this.bookmarkSignature = bookmark;
  }

  async blockIdentity(position: number): Promise<string | null> {
    if (!this.trackBlockhash) return null;
    return this.opts.rpc.getBlockhash(position);
  }

  /** Kept for interface compatibility; `pollRange` is what the runner uses. */
  async poll(fromExclusive: number, toInclusive: number): Promise<ChainEvent[]> {
    return (await this.pollRange(fromExclusive, toInclusive)).events;
  }

  async pollRange(fromExclusive: number, toInclusive: number): Promise<PollResult> {
    if (toInclusive <= fromExclusive) {
      return { events: [], coveredTo: fromExclusive, bookmark: this.bookmarkSignature };
    }

    const collected = await this.collectSignatures(fromExclusive, toInclusive);
    if (collected.length === 0) {
      return { events: [], coveredTo: toInclusive, bookmark: this.bookmarkSignature };
    }

    const { batch, coveredTo } = boundToSlotBoundary(collected, this.maxTxPerPass, toInclusive);
    const nativeUsdPrice = await this.readNativeUsd();

    const events: ChainEvent[] = [];
    for (const info of batch) {
      const tx = await this.opts.rpc.getTransaction(info.signature);
      if (!tx) {
        // Finalized signature with no transaction body: only plausible if the
        // node pruned it between the two calls. Louder than a debug line
        // because it is a real (if rare) gap in a range we are about to
        // advance past.
        this.opts.logger.warn('solana transaction vanished between calls', {
          net: 'SOL',
          signature: info.signature,
          slot: info.slot,
        });
        continue;
      }
      // A reverted transaction changed no state, so it materialises nothing.
      if (tx.meta?.err != null || info.err != null) continue;

      const records = this.decodeTransaction(tx);
      if (records.length === 0) continue;

      events.push(
        ...(await mapSolanaTransaction(records, {
          txSig: info.signature,
          slot: info.slot,
          blockTimeMs: (info.blockTime ?? tx.blockTime ?? 0) * 1000,
          registry: this.opts.registry,
          baseMints: this.opts.baseMints,
          nativeUsdPrice,
        })),
      );
    }

    events.sort(compareEvents);
    const last = batch.at(-1);
    return {
      events,
      coveredTo,
      bookmark: last?.signature ?? this.bookmarkSignature,
    };
  }

  /**
   * Every launchpad event in one transaction, in log order.
   *
   * Both Anchor framings are read: `Program data:` lines for `emit!` (what the
   * program uses today) and inner-instruction data for `emit_cpi!`. A provider
   * that truncates `logMessages` is the documented reason to move a critical
   * event to `emit_cpi!`, and handling both here means that would not need a
   * decoder change.
   */
  private decodeTransaction(tx: SolanaTransaction): SolanaLaunchpadEvent[] {
    const out: SolanaLaunchpadEvent[] = [];

    for (const payload of programDataPayloads(tx.meta?.logMessages ?? [])) {
      const decoded = launchpadEventCoder.decode(payload);
      if (decoded) out.push(decoded.data);
    }

    const inner = tx.meta?.innerInstructions;
    if (inner && inner.length > 0) {
      const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
      for (const bytes of cpiEventPayloads(inner, keys, this.opts.programId)) {
        const decoded = launchpadEventCoder.decodeBytes(bytes);
        if (decoded) out.push(decoded.data);
      }
    }

    return out;
  }

  /**
   * Signatures in `(fromExclusive, toInclusive]`, oldest first.
   *
   * Pages walk *down* from the tip because that is the only direction the RPC
   * offers, and stop as soon as a page reaches at or below `fromExclusive`
   * (or hits the `until` bookmark). Anything above `toInclusive` — inside the
   * confirmation buffer, or simply newer than this batch — is skipped and
   * picked up by a later pass.
   */
  private async collectSignatures(fromExclusive: number, toInclusive: number): Promise<SignatureInfo[]> {
    const collected: SignatureInfo[] = [];
    let before: string | undefined;

    for (let page = 0; page < this.maxSignaturePages; page++) {
      const infos = await this.opts.rpc.getSignaturesForAddress(this.opts.programId, {
        limit: this.pageSize,
        ...(before ? { before } : {}),
        ...(this.bookmarkSignature ? { until: this.bookmarkSignature } : {}),
      });
      if (infos.length === 0) return ascending(collected);

      for (const info of infos) {
        if (info.slot > toInclusive) continue;
        if (info.slot <= fromExclusive) return ascending(collected);
        collected.push(info);
      }

      const oldest = infos.at(-1);
      if (!oldest) return ascending(collected);
      if (oldest.slot <= fromExclusive) return ascending(collected);
      if (infos.length < this.pageSize) return ascending(collected);
      before = oldest.signature;
    }

    throw new SolanaRangeTooBusyError(fromExclusive, toInclusive, this.maxSignaturePages);
  }

  private async readNativeUsd(): Promise<number> {
    try {
      return await this.opts.nativeUsd();
    } catch (err) {
      // Only fills whose base asset is not wrapped SOL need this. Reporting 0
      // makes `nativeNotional` return 0 rather than a number derived from a
      // stale or invented price, and the event still records the exact base
      // and USD legs.
      this.opts.logger.warn('native price unavailable; non-native-base fills will record 0 native', {
        net: 'SOL',
        err: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }
}

function ascending(infos: SignatureInfo[]): SignatureInfo[] {
  return [...infos].sort((a, b) => (a.slot !== b.slot ? a.slot - b.slot : a.signature < b.signature ? -1 : 1));
}

/**
 * Trims a pass to `maxTx` transactions **without splitting a slot**.
 *
 * Advancing the cursor into the middle of a slot would drop the rest of that
 * slot's transactions permanently, because the next pass starts strictly
 * after the cursor. So the cut lands on a slot boundary and `coveredTo` is
 * that slot — the remainder is a later pass's work.
 */
export function boundToSlotBoundary(
  ascendingInfos: readonly SignatureInfo[],
  maxTx: number,
  toInclusive: number,
): { batch: SignatureInfo[]; coveredTo: number } {
  if (ascendingInfos.length <= maxTx) {
    return { batch: [...ascendingInfos], coveredTo: toInclusive };
  }
  let cut = maxTx;
  const boundarySlot = ascendingInfos[cut - 1]?.slot ?? toInclusive;
  while (cut < ascendingInfos.length && ascendingInfos[cut]?.slot === boundarySlot) cut++;
  return { batch: ascendingInfos.slice(0, cut), coveredTo: boundarySlot };
}
