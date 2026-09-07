import type { Net } from '@stonkz/shared';
import type { Logger } from '@stonkz/api/observability/logger';
import type { PriceOracle } from '@stonkz/api/chain/types';
import { nativeUnit } from '@stonkz/shared';
import type { ReplayCursors } from './cursors.js';
import type { DeadLetters } from './deadletter.js';
import type { Ingestor, IngestReport } from './ingest.js';
import type { LagMonitor } from './lag.js';
import type { ReorgRollback, RollbackReport } from './rollback.js';
import { confirmedHeadOf, pollSource, type EventSource } from './source.js';

export interface RunnerOptions {
  cursors: ReplayCursors;
  ingestor: Ingestor;
  lag: LagMonitor;
  logger: Logger;
  oracle: PriceOracle;
  sources: Record<Net, EventSource>;
  /** Positions consumed per pass; keeps one pass bounded after a long outage. */
  batchSize?: number;
  /** Absent in fixture mode: there is nothing to roll back and no hashes to compare. */
  rollback?: ReorgRollback;
  deadLetters?: DeadLetters;
  /**
   * Consecutive failed passes at the same position before the batch is
   * dead-lettered and skipped. Only meaningful with `deadLetters` set.
   */
  maxBatchAttempts?: number;
  /** How far back to rewind on a detected reorg, per chain. */
  reorgDepth?: Record<Net, number>;
  /** Called when a rollback removed rows, so caches keyed on chain data can be dropped. */
  onRollback?: (net: Net, report: RollbackReport) => void;
}

export interface PassResult {
  net: Net;
  from: number;
  to: number;
  report: IngestReport;
  caughtUp: boolean;
  /** Set when this pass detected a reorg and rolled back instead of ingesting. */
  rolledBack?: RollbackReport;
  /** Set when this pass gave up on the range and dead-lettered it. */
  skipped?: { from: number; to: number; attempts: number; error: string };
}

function emptyReport(): IngestReport {
  return { accepted: 0, duplicates: 0, rejected: [], xpAwarded: 0, achievementsUnlocked: [], positions: {} };
}

/**
 * One pass of the indexer loop, per chain.
 *
 * The cursor advances only after `apply()` returns, so a crash mid-batch
 * replays that batch — which is safe because ingest is idempotent on
 * `(net, tx_sig, log_index, kind)`. Nothing is committed optimistically.
 *
 * Three things this loop does that the fixtures-only version did not:
 *
 * 1. **It never materialises past the confirmation depth.** `to` is clamped to
 *    `source.confirmedHead()`, not to the raw head. On Solana that is the
 *    finalized slot; on the EVM it is `head - INDEXER_RH_CONFIRMATIONS`. A
 *    fixture source has no `confirmedHead`, so it keeps using the raw head and
 *    behaves exactly as before.
 * 2. **It checks that history has not moved before extending it.** The hash at
 *    the cursor is re-read every pass and compared with the one recorded when
 *    the cursor arrived there. A mismatch triggers a rollback and a rewind
 *    instead of an ingest.
 * 3. **It gives up.** A range that fails `maxBatchAttempts` consecutive passes
 *    is dead-lettered and skipped, so a poison batch cannot hold a chain still
 *    forever.
 */
export class IndexerRunner {
  private readonly batchSize: number;
  private readonly maxBatchAttempts: number;

  constructor(private readonly opts: RunnerOptions) {
    this.batchSize = opts.batchSize ?? 5_000;
    this.maxBatchAttempts = Math.max(1, opts.maxBatchAttempts ?? 5);
  }

  async pass(net: Net): Promise<PassResult> {
    const source = this.opts.sources[net];
    const head = await source.head();
    const confirmed = Math.min(head, await confirmedHeadOf(source));
    const cursor = await this.opts.cursors.read(net);

    // A zeroed cursor means "never indexed"; start at the deployment position
    // rather than walking 250 million empty Solana slots.
    const from =
      cursor.position > 0 ? cursor.position : Math.max(0, (await source.startPosition()) - 1);

    // Hand the source its resume hint before it polls. Solana's signature
    // paging needs the last committed signature as `until`; without it every
    // pass re-scans from the tip.
    source.restoreBookmark?.(cursor.positionSignature);

    const reorg = await this.detectReorg(net, source, cursor.position, cursor.positionHash);
    if (reorg) return reorg;

    const to = Math.min(confirmed, from + this.batchSize);
    if (to <= from) {
      // Caught up, or the whole remaining range is inside the confirmation
      // buffer. Either way there is nothing safe to ingest; record the heads
      // so an operator can see the buffer working rather than guess at a stall.
      await this.opts.cursors.observeHead(net, head, confirmed);
      return { net, from, to: from, report: emptyReport(), caughtUp: true };
    }

    try {
      return await this.ingestRange(net, source, from, to, head, confirmed);
    } catch (err) {
      return await this.handleFailure(net, from, to, err);
    }
  }

  /* ----------------------------------------------------------------- ingest */

  private async ingestRange(
    net: Net,
    source: EventSource,
    from: number,
    to: number,
    head: number,
    confirmed: number,
  ): Promise<PassResult> {
    const polled = await pollSource(source, from, to);
    // A bounded pass may have covered less than it was asked for (Solana caps
    // signatures per pass). Advancing to `to` would skip the remainder
    // permanently, so the cursor only ever moves to what was actually scanned.
    const covered = Math.max(from, Math.min(to, polled.coveredTo));
    const report = await this.opts.ingestor.apply(polled.events);

    // An event that failed its integrity check is recorded rather than merely
    // counted; the cursor is about to move past it either way.
    if (this.opts.deadLetters) {
      for (const { event, reason } of report.rejected) {
        await this.opts.deadLetters.recordEvent(event, reason);
      }
    }

    const hash = (await source.blockIdentity?.(covered)) ?? null;
    await this.opts.cursors.advance(net, covered, {
      chainHead: head,
      confirmedHead: confirmed,
      sawEvent: report.accepted > 0,
      positionHash: hash,
      ...(polled.bookmark === undefined ? {} : { positionSignature: polled.bookmark }),
    });
    await this.opts.lag.check(net);

    if (report.rejected.length > 0) {
      this.opts.logger.error('batch had rejected events', {
        net,
        from,
        to: covered,
        rejected: report.rejected.length,
      });
    }
    this.opts.logger.info('batch ingested', {
      net,
      from,
      to: covered,
      accepted: report.accepted,
      duplicates: report.duplicates,
      xpAwarded: report.xpAwarded,
    });

    return { net, from, to: covered, report, caughtUp: covered >= confirmed };
  }

  /* ------------------------------------------------------------------ reorg */

  /**
   * Compares the chain's identity at the cursor against what was recorded when
   * the cursor arrived there.
   *
   * A `null` from either side is not a reorg: the cursor may never have
   * recorded a hash (a fresh cursor, or a source that does not track them), and
   * the chain may legitimately have no block at that position — Solana leaders
   * skip slots routinely. Treating either as a reorg would roll back on every
   * skipped slot, which is both wrong and destructive.
   */
  private async detectReorg(
    net: Net,
    source: EventSource,
    position: number,
    recordedHash: string | null,
  ): Promise<PassResult | null> {
    if (!this.opts.rollback || !source.blockIdentity || recordedHash === null || position <= 0) return null;

    const current = await source.blockIdentity(position);
    if (current === null || current === recordedHash) return null;

    const depth = this.opts.reorgDepth?.[net] ?? 64;
    const startPosition = await source.startPosition();
    // Rewind to `depth` behind the cursor, but never behind the deployment
    // position: there is nothing to re-read before the programs existed.
    const rewindTo = Math.max(startPosition - 1, position - depth);

    this.opts.logger.error('reorg detected at cursor', {
      net,
      position,
      recordedHash,
      chainHash: current,
      rewindTo,
    });

    // Roll the rows back *before* moving the cursor. If the process dies
    // between the two, the cursor still points at the reorged position, the
    // hash still mismatches, and the next boot detects the same reorg and
    // repeats the rollback — which is idempotent, because it deletes by range.
    const report = await this.opts.rollback.rollback(net, rewindTo + 1);
    await this.opts.cursors.rewind(net, rewindTo, { reorg: true });
    source.restoreBookmark?.(null);
    this.opts.onRollback?.(net, report);

    return {
      net,
      from: position,
      to: rewindTo,
      report: emptyReport(),
      caughtUp: false,
      rolledBack: report,
    };
  }

  /* ---------------------------------------------------------------- failure */

  /**
   * Counts a failed pass and decides whether to retry it or abandon it.
   *
   * Retrying is the default and the right answer for the common case — a
   * timed-out RPC, a provider rate limit, a transient connection reset. The
   * cursor is left where it is, so the next pass re-polls the same range.
   *
   * After `maxBatchAttempts` consecutive failures at the same position the
   * range is dead-lettered and the cursor is moved past it. That loses the
   * range's events, which is the lesser of two bad outcomes: the alternative
   * is a chain that never advances again, and the dead letter records exactly
   * what to replay with the backfill CLI once the cause is fixed.
   */
  private async handleFailure(net: Net, from: number, to: number, err: unknown): Promise<PassResult> {
    const message = err instanceof Error ? err.message : String(err);
    const attempts = await this.opts.cursors.recordFailure(net, message);

    if (!this.opts.deadLetters || attempts < this.maxBatchAttempts) {
      this.opts.logger.error('pass failed; will retry', { net, from, to, attempts, err: message });
      // Rethrown so `drain` stops working this chain for the tick. The other
      // chain is unaffected — see `drain`.
      throw err instanceof Error ? err : new Error(message);
    }

    await this.opts.deadLetters.recordBatch(net, from, to, message, attempts);
    await this.opts.cursors.advance(net, to, { chainHead: to });
    await this.opts.cursors.clearFailures(net);

    return {
      net,
      from,
      to,
      report: emptyReport(),
      caughtUp: false,
      skipped: { from, to, attempts, error: message },
    };
  }

  /* ------------------------------------------------------------------ drain */

  /**
   * Drains one chain until it is level with its confirmed head.
   *
   * Per-chain by design. The old `drain()` ran both nets in one sequential
   * loop with no error handling, so an exception on `SOL` propagated before
   * `RH` was touched at all — a stalled Solana RPC stopped Robinhood Chain
   * from indexing, which is the coupling bug in `docs/indexer-runbooks.md` §5.
   */
  async drainNet(net: Net, maxPasses = 100): Promise<PassResult[]> {
    const results: PassResult[] = [];
    for (let i = 0; i < maxPasses; i++) {
      const result = await this.pass(net);
      results.push(result);
      // A rollback or a skip is progress of a sort but not a normal advance;
      // stop the burst and let the next tick re-evaluate from a clean read.
      if (result.caughtUp || result.rolledBack || result.skipped) break;
    }
    return results;
  }

  /**
   * Drains both chains, isolated from each other.
   *
   * `allSettled`, not `all`: the point is that neither chain's outcome can
   * affect the other's. A rejection is logged against its own chain and the
   * other chain's results are still returned.
   */
  async drain(maxPasses = 100): Promise<PassResult[]> {
    const settled = await Promise.allSettled(
      (['SOL', 'RH'] as const).map((net) => this.drainNet(net, maxPasses)),
    );

    const results: PassResult[] = [];
    for (const [i, outcome] of settled.entries()) {
      const net = (['SOL', 'RH'] as const)[i] as Net;
      if (outcome.status === 'fulfilled') {
        results.push(...outcome.value);
      } else {
        const err = outcome.reason;
        this.opts.logger.error('chain drain failed; the other chain is unaffected', {
          net,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return results;
  }

  /**
   * The `diamond` sweep. Separate from ingest because it is a function of
   * current price, not of any single event, so it has to run on a timer.
   */
  async sweepAchievements(): Promise<Record<Net, string[]>> {
    const out: Record<Net, string[]> = { SOL: [], RH: [] };
    for (const net of ['SOL', 'RH'] as const) {
      try {
        const price = await this.opts.oracle.nativeUsd(nativeUnit(net));
        out[net] = await this.opts.ingestor.sweepDiamondHands(net, price);
      } catch (err) {
        this.opts.logger.warn('diamond sweep skipped', {
          net,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return out;
  }
}
