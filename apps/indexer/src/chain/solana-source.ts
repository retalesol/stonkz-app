import type { BaseMintRegistry } from '@stonkz/api/router/base-mints';
import type { Logger } from '@stonkz/api/observability/logger';
import type { Net } from '@stonkz/shared';
import type { ChainEvent } from '../events.js';
import { compareEvents } from '../events.js';
import type { CatchupBacklog, EventSource, PollResult } from '../source.js';
import { cpiEventPayloads, programDataPayloads } from './anchor.js';
import { launchMetaFromCreated, mapSolanaTransaction } from './solana-map.js';
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
 * what is new instead of re-scanning from the tip. Signatures are always
 * handed to the decoder oldest-first.
 *
 * **Catch-up.** The RPC only pages *down* from the tip, but ingest has to run
 * *up* from the cursor: a fill cannot be mapped before its launch, and the
 * cursor must never skip a slot. Reconciling the two is a two-phase walk that
 * is bounded per pass and resumes across passes (see {@link locate} and
 * {@link collect}):
 *
 * 1. **Locate.** Page down from the tip with `until = bookmark`, keeping only
 *    one `before` cursor per page (the page's oldest signature) on a stack —
 *    not the signatures themselves, so a million-signature gap costs a
 *    thousand strings of memory, not a million rows. The walk stops at the
 *    bookmark; if the page cap or the time budget runs out first it stops
 *    where it is and the *next pass continues from the same `before`*.
 * 2. **Collect.** Pop pages from the bookmark side of the stack — oldest
 *    first — re-fetching each by its `before` cursor with the current
 *    bookmark as `until`, so a page that was partly ingested shrinks to its
 *    unprocessed remainder. The batch is cut at a slot boundary exactly as
 *    before, and the cursor moves only to what was fully collected.
 *
 * A pass that runs out of budget therefore reports `coveredTo = from` with a
 * backlog estimate and no error. Nothing here throws because more remains;
 * `SolanaRangeTooBusyError` is kept only so a caller can recognise the old
 * failure mode in logs and dead letters that predate this walk.
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
   * Cap on `getSignaturesForAddress` calls per pass, across both the locate
   * and the collect phases. Reaching it ends the pass early with whatever was
   * fully collected; the walk resumes from the same point next pass.
   * `INDEXER_SOL_MAX_SIGNATURE_PAGES`, default 100.
   */
  maxSignaturePages?: number;
  /**
   * Wall-clock budget for the signature paging of one pass. Checked before
   * every page, so a slow provider cannot turn one pass into an hour.
   * `INDEXER_SOL_PASS_BUDGET_MS`, default 15s.
   */
  passBudgetMs?: number;
  now?: () => number;
}

/**
 * The pre-catch-up failure: a range with more signature pages than one pass
 * was allowed to walk. The source no longer throws it — a pass that runs out
 * of pages now reports partial progress instead — but the class stays so the
 * runner can recognise an old dead letter or a replaying log line.
 */
export class SolanaRangeTooBusyError extends Error {
  /** Marks this as "more remains", never as a failed range — see `isPartialProgressError`. */
  readonly partialProgress = true as const;

  constructor(
    readonly fromExclusive: number,
    readonly toInclusive: number,
    readonly pages: number,
  ) {
    super(
      `SOL slots (${fromExclusive}, ${toInclusive}] hold more than ${pages} pages of program activity; the catch-up continues next pass`,
    );
    this.name = 'SolanaRangeTooBusyError';
  }
}

/** One page of the located-but-not-yet-ingested backlog. */
interface PendingPage {
  /** `before` cursor that fetches this page; `undefined` is the tip page. */
  before: string | undefined;
  /** Unprocessed signatures the page held when last seen — the backlog estimate. */
  count: number;
}

/** Per-pass accounting shared by the two phases. */
class PassBudget {
  pages = 0;
  /** Pages fetched this pass, keyed by `before`; `until` is fixed for the pass. */
  readonly cache = new Map<string, SignatureInfo[]>();

  constructor(
    private readonly maxPages: number,
    private readonly deadline: number,
    private readonly now: () => number,
  ) {}

  /** Over the page cap or the deadline — but never before the first page, so every pass moves. */
  get exhausted(): boolean {
    return this.pages >= this.maxPages || (this.pages > 0 && this.now() >= this.deadline);
  }
}

export class SolanaChainSource implements EventSource {
  readonly net: Net = 'SOL';

  private readonly confirmations: number;
  private readonly pageSize: number;
  private readonly maxTxPerPass: number;
  private readonly maxSignaturePages: number;
  private readonly passBudgetMs: number;
  private readonly trackBlockhash: boolean;
  private readonly now: () => number;
  private bookmarkSignature: string | null = null;

  /**
   * The catch-up walk. `pending` is the stack of located pages, oldest at the
   * end; `scan` is a locate in progress (the next `before` to fetch), or
   * `null` once the walk has reached the bookmark. Both are in-memory only:
   * a restart re-locates from the tip, which costs one light RPC call per
   * thousand signatures and loses nothing because the committed bookmark is
   * the only durable position.
   */
  private pending: PendingPage[] = [];
  private scan: { before: string | undefined } | null = null;
  /**
   * The bookmark the last `pollRange` handed back. The runner persists it and
   * restores it next pass; seeing it again confirms the batch committed and
   * the walk may carry on. Any *other* bookmark means the cursor moved under
   * the source, and the walk is thrown away.
   */
  private offeredBookmark: string | null = null;
  /**
   * The newest signature the tip page held when it was last walked. The tip
   * page is the one page whose content moves: a different newest signature
   * means the tip advanced, and if it advanced by a whole page there may be
   * signatures between the new tip page and the bookmark that no page on the
   * stack covers. Checked once per tip content, not once per fetch.
   */
  private tipNewest: string | null = null;

  constructor(private readonly opts: SolanaChainSourceOptions) {
    this.confirmations = Math.max(0, opts.confirmations ?? 0);
    this.pageSize = Math.min(1_000, Math.max(1, opts.signaturePageSize ?? 1_000));
    this.maxTxPerPass = Math.max(1, opts.maxTxPerPass ?? 200);
    this.maxSignaturePages = Math.max(1, opts.maxSignaturePages ?? 100);
    this.passBudgetMs = Math.max(1, opts.passBudgetMs ?? 15_000);
    this.trackBlockhash = opts.trackBlockhash ?? false;
    this.now = opts.now ?? Date.now;
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

  /**
   * Restores the committed bookmark. A bookmark the source did not itself hand
   * back last pass (a rewind, a fresh cursor, a backfill) invalidates the
   * in-memory walk, because every pending page was located relative to the
   * old `until`.
   */
  restoreBookmark(bookmark: string | null): void {
    if (bookmark !== this.bookmarkSignature && bookmark !== this.offeredBookmark) this.resetWalk();
    this.bookmarkSignature = bookmark;
    this.offeredBookmark = bookmark;
  }

  /** Estimated unprocessed signatures between the bookmark and the tip. */
  backlogEstimate(): number {
    return this.pending.reduce((sum, page) => sum + page.count, 0);
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

    const budget = new PassBudget(this.maxSignaturePages, this.now() + this.passBudgetMs, this.now);
    const { batch, coveredTo, windowComplete } = await this.collect(
      fromExclusive,
      toInclusive,
      budget,
    );
    this.discount(batch.length);

    if (batch.length === 0) {
      return {
        events: [],
        coveredTo,
        bookmark: this.bookmarkSignature,
        backlog: this.backlog(budget, !windowComplete),
      };
    }

    const nativeUsdPrice = await this.readNativeUsd();

    // Decode every transaction first, then map. The two passes matter: order
    // *within* a slot is not recoverable from `getSignaturesForAddress`, so a
    // third-party buy landing in the launch's own slot can be mapped before
    // the `create_token` transaction. Mapping that fill needs the launch's
    // curve constants, and a miss throws `UnknownMintError` — which used to
    // fail the pass, retry it, and finally dead-letter the whole range,
    // launch included. Learning every launch in the batch up front removes
    // the dependency on intra-slot order.
    const decoded: {
      info: SignatureInfo;
      tx: SolanaTransaction;
      records: SolanaLaunchpadEvent[];
    }[] = [];
    for (const info of batch) {
      const tx = await this.opts.rpc.getTransaction(info.signature);
      if (!tx) {
        // A finalized signature with no transaction body. In practice this is
        // a load-balanced RPC answering the two calls from nodes at different
        // heights, not a real hole — and skipping it would advance the cursor
        // past a launch or fill for good. Fail the pass so it is retried (and,
        // if it never resolves, dead-lettered with a replayable range).
        this.opts.logger.warn('solana transaction vanished between calls', {
          net: 'SOL',
          signature: info.signature,
          slot: info.slot,
        });
        throw new Error(
          `SOL getTransaction(${info.signature}) returned null for a finalized signature at slot ${info.slot}`,
        );
      }
      // A reverted transaction changed no state, so it materialises nothing.
      if (tx.meta?.err != null || info.err != null) continue;

      const records = this.decodeTransaction(tx);
      if (records.length === 0) continue;
      decoded.push({ info, tx, records });
    }

    for (const { records } of decoded) {
      for (const record of records) {
        if (record.kind !== 'TokenCreated') continue;
        const known = this.opts.registry.peek('SOL', record.mint);
        this.opts.registry.remember({
          ...launchMetaFromCreated(record),
          circulatingAtoms: known?.circulatingAtoms ?? 0n,
        });
      }
    }

    const events: ChainEvent[] = [];
    for (const { info, tx, records } of decoded) {
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
    this.offeredBookmark = last?.signature ?? this.bookmarkSignature;
    return {
      events,
      coveredTo,
      bookmark: this.offeredBookmark,
      backlog: this.backlog(budget, !windowComplete),
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

    for (const payload of programDataPayloads(tx.meta?.logMessages ?? [], this.opts.programId)) {
      const decoded = launchpadEventCoder.decode(payload);
      if (decoded) out.push(decoded.data);
    }

    const inner = tx.meta?.innerInstructions;
    if (inner && inner.length > 0) {
      // `programIdIndex` indexes the *full* key list of a versioned message:
      // static keys, then lookup-table writable, then lookup-table readonly.
      const loaded = tx.meta?.loadedAddresses;
      const keys = [
        ...tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey)),
        ...(loaded?.writable ?? []),
        ...(loaded?.readonly ?? []),
      ];
      for (const bytes of cpiEventPayloads(inner, keys, this.opts.programId)) {
        const decoded = launchpadEventCoder.decodeCpiBytes(bytes);
        if (decoded) out.push(decoded.data);
      }
    }

    return out;
  }

  /* ------------------------------------------------------------ the walk */

  private resetWalk(): void {
    this.pending = [];
    this.scan = null;
    this.tipNewest = null;
  }

  private backlog(budget: PassBudget, partial: boolean): CatchupBacklog {
    return {
      remaining: this.backlogEstimate(),
      located: this.scan === null,
      partial,
      pages: budget.pages,
    };
  }

  /** Lowers the backlog estimate by a batch about to be ingested, oldest pages first. */
  private discount(taken: number): void {
    let left = taken;
    for (let i = this.pending.length - 1; i >= 0 && left > 0; i--) {
      const page = this.pending[i];
      if (!page) continue;
      const n = Math.min(page.count, left);
      page.count -= n;
      left -= n;
    }
  }

  /** One `getSignaturesForAddress` page, counted against the pass and cached within it. */
  private async fetchPage(
    before: string | undefined,
    budget: PassBudget,
  ): Promise<SignatureInfo[]> {
    const key = before ?? '';
    const cached = budget.cache.get(key);
    if (cached) return cached;
    budget.pages++;
    const infos = await this.opts.rpc.getSignaturesForAddress(this.opts.programId, {
      limit: this.pageSize,
      ...(before ? { before } : {}),
      ...(this.bookmarkSignature ? { until: this.bookmarkSignature } : {}),
    });
    budget.cache.set(key, infos);
    return infos;
  }

  /**
   * Phase 1: walk down from `scan.before` towards the bookmark, pushing one
   * `PendingPage` per page that holds unprocessed signatures. Returns with
   * `scan === null` when the bookmark (or `fromExclusive`) was reached, or
   * with `scan` pointing at the next page when the budget ran out first.
   */
  private async locate(fromExclusive: number, budget: PassBudget): Promise<void> {
    while (this.scan && !budget.exhausted) {
      const before = this.scan.before;
      const infos = await this.fetchPage(before, budget);
      if (before === undefined) this.tipNewest = infos[0]?.signature ?? null;
      if (infos.length === 0) {
        this.scan = null;
        return;
      }

      const unprocessed = infos.filter((info) => info.slot > fromExclusive).length;
      if (unprocessed > 0) this.pending.push({ before, count: unprocessed });

      const oldest = infos.at(-1);
      // Reached the cursor, or the `until` bookmark cut the page short: the
      // page below is already ingested, so the walk is complete.
      if (!oldest || oldest.slot <= fromExclusive || infos.length < this.pageSize) {
        this.scan = null;
        return;
      }
      this.scan = { before: oldest.signature };
    }
  }

  /**
   * Phase 2: the signatures to ingest this pass, oldest first, cut at a slot
   * boundary, and the position the cursor may safely move to.
   *
   * Pages are fetched from the bookmark end of the stack. A page is dropped
   * once a fetch shows it holds nothing above `fromExclusive` — *lazily*, on
   * the next pass, never on the assumption that this pass's batch will be
   * committed. That costs one light call per finished page and means a pass
   * whose ingest throws is simply re-polled, with nothing skipped.
   */
  private async collect(
    fromExclusive: number,
    toInclusive: number,
    budget: PassBudget,
  ): Promise<{ batch: SignatureInfo[]; coveredTo: number; windowComplete: boolean }> {
    let collected: SignatureInfo[] = [];
    // Pages located at different times may overlap (a re-locate after the tip
    // moved walks back over ranges already on the stack). Across passes the
    // advancing `until` makes that harmless; within a pass it is deduplicated.
    let seen = new Set<string>();
    let windowComplete = false;
    // Index from the top of the stack; a page is only spliced out when empty.
    let depth = 1;

    for (;;) {
      if (this.scan === null && this.pending.length === 0) this.scan = { before: undefined };
      if (this.scan) {
        await this.locate(fromExclusive, budget);
        if (this.scan) break; // budget gone mid-locate: resume next pass
        if (this.pending.length === 0) {
          // Nothing between the bookmark and the tip.
          windowComplete = true;
          break;
        }
      }

      const page = this.pending.at(-depth);
      if (!page) break;

      const safe = this.safeCount(collected, windowComplete);
      // Past the budget: stop once there is something committable. A batch
      // that is only an unfinished slot keeps paging — the slot has to close
      // before any of it can be committed, and a slot is a bounded thing.
      const cached = budget.cache.has(page.before ?? '');
      if (budget.exhausted && !cached && (safe > 0 || collected.length === 0)) break;
      if (safe >= this.maxTxPerPass) break;

      const infos = await this.fetchPage(page.before, budget);
      const unprocessed = infos.filter((info) => info.slot > fromExclusive);
      if (unprocessed.length === 0) {
        this.pending.splice(this.pending.length - depth, 1);
        continue;
      }
      page.count = unprocessed.length;

      const oldest = infos.at(-1);
      const newest = infos[0];
      if (
        page.before === undefined &&
        oldest &&
        newest &&
        infos.length >= this.pageSize &&
        oldest.slot > fromExclusive &&
        newest.signature !== this.tipNewest
      ) {
        // The tip moved since this page was located and the page is full, so
        // there may be signatures between its oldest and the bookmark that no
        // page on the stack covers. Locate from here before ingesting it.
        this.tipNewest = newest.signature;
        this.scan = { before: oldest.signature };
        // Whatever the locate finds is older than this page and newer than
        // anything collected so far, so the collection restarts from the new
        // top of the stack (the re-fetches come from the pass cache).
        collected = [];
        seen = new Set();
        depth = 1;
        continue;
      }

      let beyond = 0;
      for (const info of unprocessed) {
        if (info.slot > toInclusive) beyond++;
        else if (!seen.has(info.signature)) {
          seen.add(info.signature);
          collected.push(info);
        }
      }
      // Anything newer than this page is newer than `toInclusive` too.
      if (beyond > 0) {
        windowComplete = true;
        break;
      }
      // The tip page is, by definition, the newest there is.
      if (page.before === undefined) {
        windowComplete = true;
        break;
      }
      depth++;
    }

    return { ...this.cut(collected, windowComplete, fromExclusive, toInclusive), windowComplete };
  }

  /**
   * Signatures that may be committed now. Until the window is known to be
   * complete, the newest collected slot may continue on a page not yet
   * fetched, so it is held back: committing half a slot would drop the other
   * half for good, because the next pass starts strictly after the cursor.
   */
  private safeCount(collected: SignatureInfo[], windowComplete: boolean): number {
    if (windowComplete || collected.length === 0) return collected.length;
    let newest = 0;
    for (const info of collected) if (info.slot > newest) newest = info.slot;
    let held = 0;
    for (const info of collected) if (info.slot === newest) held++;
    return collected.length - held;
  }

  private cut(
    collected: SignatureInfo[],
    windowComplete: boolean,
    fromExclusive: number,
    toInclusive: number,
  ): { batch: SignatureInfo[]; coveredTo: number } {
    let safe = ascending(collected);
    if (!windowComplete) {
      const newest = safe.at(-1)?.slot;
      safe = safe.filter((info) => info.slot !== newest);
    }
    if (safe.length === 0) {
      return { batch: [], coveredTo: windowComplete ? toInclusive : fromExclusive };
    }
    const bounded = boundToSlotBoundary(safe, this.maxTxPerPass, toInclusive);
    const newestSafe = safe.at(-1)?.slot ?? fromExclusive;
    return {
      batch: bounded.batch,
      coveredTo: windowComplete ? bounded.coveredTo : Math.min(bounded.coveredTo, newestSafe),
    };
  }

  private async readNativeUsd(): Promise<number> {
    try {
      return await this.opts.nativeUsd();
    } catch (err) {
      // Only fills whose base asset is not wrapped SOL need this. Reporting 0
      // makes `nativeNotional` return 0 rather than a number derived from a
      // stale or invented price, and the event still records the exact base
      // and USD legs.
      this.opts.logger.warn(
        'native price unavailable; non-native-base fills will record 0 native',
        {
          net: 'SOL',
          err: err instanceof Error ? err.message : String(err),
        },
      );
      return 0;
    }
  }
}

function ascending(infos: SignatureInfo[]): SignatureInfo[] {
  return [...infos].sort((a, b) =>
    a.slot !== b.slot ? a.slot - b.slot : a.signature < b.signature ? -1 : 1,
  );
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
