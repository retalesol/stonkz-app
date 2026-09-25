import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Net } from '@stonkz/shared';
import type { Db } from '@stonkz/api/db/client';
import { indexerDeadLetters } from '@stonkz/api/db/schema';
import type { Logger } from '@stonkz/api/observability/logger';
import type { ChainEvent } from './events.js';

/**
 * Where an event or a batch goes when ingest cannot make progress on it.
 *
 * Before this existed there were exactly two outcomes for a bad event, both
 * documented as gaps in `docs/indexer-runbooks.md` §5:
 *
 * - An event that failed `assertEventIntegrity` was counted in
 *   `IngestReport.rejected`, logged, and then *forgotten* — the cursor
 *   advanced past it and nothing recorded what was lost.
 * - An event that threw anywhere else (an unhandled RPC error, a constraint
 *   violation, a decode failure) propagated out of `apply()`, so the cursor
 *   never advanced and the identical batch was re-polled every `POLL_MS`
 *   forever. On one chain that is a stall; before the drain loops were
 *   isolated it stalled the other chain too.
 *
 * Both now land here with the payload and the error attached, and the cursor
 * is allowed past them. The distinction the table keeps is `scope`:
 *
 * - `event` — one event was individually unprocessable. The rest of its batch
 *   was ingested normally.
 * - `batch` — a whole position range could not be processed at all, after
 *   `INDEXER_MAX_BATCH_ATTEMPTS` passes. Skipping it loses whatever it
 *   contained, which is why the row records the range: replaying it with the
 *   backfill CLI once the cause is fixed is the documented recovery.
 *
 * Nothing here retries automatically. A dead letter is an operator's problem
 * by definition — it is the state ingest reached after retrying.
 */
export interface DeadLetterOptions {
  db: Db;
  logger: Logger;
  now?: () => number;
}

export interface DeadLetterRow {
  id: number;
  net: Net;
  scope: 'event' | 'batch';
  kind: string;
  txSig: string;
  chainPosition: number;
  fromPosition: number;
  toPosition: number;
  error: string;
  attempts: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

export class DeadLetters {
  private readonly now: () => number;

  constructor(private readonly opts: DeadLetterOptions) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * Records one unprocessable event.
   *
   * Re-recording the same event bumps `attempts` and `last_seen_at` rather
   * than inserting a second row, so a batch that is replayed (by the backfill
   * CLI, or after a reorg) does not turn one bad event into a growing pile of
   * identical rows.
   */
  async recordEvent(event: ChainEvent, error: string): Promise<void> {
    const { net, kind, txSig, logIndex, chainPosition, ...payload } = event;
    await this.opts.db
      .insert(indexerDeadLetters)
      .values({
        net,
        scope: 'event',
        kind,
        txSig,
        logIndex,
        chainPosition,
        fromPosition: chainPosition,
        toPosition: chainPosition,
        payload: payload as Record<string, unknown>,
        error: error.slice(0, 4_000),
      })
      .onConflictDoUpdate({
        target: [
          indexerDeadLetters.net,
          indexerDeadLetters.txSig,
          indexerDeadLetters.logIndex,
          indexerDeadLetters.kind,
        ],
        set: {
          attempts: sql`${indexerDeadLetters.attempts} + 1`,
          error: error.slice(0, 4_000),
          lastSeenAt: new Date(this.now()),
        },
      });

    this.opts.logger.error('event dead-lettered', {
      net,
      kind,
      txSig,
      logIndex,
      chainPosition,
      error,
    });
  }

  /**
   * Records a position range that could not be ingested at all.
   *
   * `txSig` is synthesised from the range because the unique index is on
   * `(net, tx_sig, log_index, kind)` and a poison batch has no single
   * signature to blame — the failure was the pass, not one event. Using the
   * range as the key means repeated failures on the same range collapse onto
   * one row.
   */
  async recordBatch(
    net: Net,
    fromExclusive: number,
    toInclusive: number,
    error: string,
    attempts: number,
  ): Promise<void> {
    await this.opts.db
      .insert(indexerDeadLetters)
      .values({
        net,
        scope: 'batch',
        kind: 'batch',
        txSig: `batch:${fromExclusive}-${toInclusive}`,
        logIndex: 0,
        chainPosition: toInclusive,
        fromPosition: fromExclusive,
        toPosition: toInclusive,
        payload: { fromExclusive, toInclusive },
        error: error.slice(0, 4_000),
        attempts,
      })
      .onConflictDoUpdate({
        target: [
          indexerDeadLetters.net,
          indexerDeadLetters.txSig,
          indexerDeadLetters.logIndex,
          indexerDeadLetters.kind,
        ],
        set: {
          attempts,
          error: error.slice(0, 4_000),
          lastSeenAt: new Date(this.now()),
        },
      });

    this.opts.logger.error('batch dead-lettered and skipped', {
      net,
      fromExclusive,
      toInclusive,
      attempts,
      error,
    });
  }

  /** Open (unresolved) dead letters, oldest first. Backs the HTTP surface. */
  async open(net?: Net, limit = 100): Promise<DeadLetterRow[]> {
    const rows = await this.opts.db
      .select()
      .from(indexerDeadLetters)
      .where(
        net
          ? and(eq(indexerDeadLetters.net, net), isNull(indexerDeadLetters.resolvedAt))
          : isNull(indexerDeadLetters.resolvedAt),
      )
      .orderBy(asc(indexerDeadLetters.id))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      net: r.net as Net,
      scope: r.scope === 'batch' ? 'batch' : 'event',
      kind: r.kind,
      txSig: r.txSig,
      chainPosition: r.chainPosition,
      fromPosition: r.fromPosition,
      toPosition: r.toPosition,
      error: r.error,
      attempts: r.attempts,
      firstSeenAt: r.firstSeenAt.getTime(),
      lastSeenAt: r.lastSeenAt.getTime(),
    }));
  }

  async countOpen(net: Net): Promise<number> {
    const [row] = await this.opts.db
      .select({ n: sql<number>`count(*)::int` })
      .from(indexerDeadLetters)
      .where(and(eq(indexerDeadLetters.net, net), isNull(indexerDeadLetters.resolvedAt)));
    return row?.n ?? 0;
  }

  /**
   * Marks a range's dead letters resolved. Called by the backfill CLI after a
   * successful replay, so a fixed poison batch stops showing up as an open
   * incident.
   */
  async resolveRange(net: Net, fromPosition: number, toPosition: number): Promise<number> {
    const resolved = await this.opts.db
      .update(indexerDeadLetters)
      .set({ resolvedAt: new Date(this.now()) })
      .where(
        and(
          eq(indexerDeadLetters.net, net),
          isNull(indexerDeadLetters.resolvedAt),
          sql`${indexerDeadLetters.chainPosition} >= ${fromPosition}`,
          sql`${indexerDeadLetters.chainPosition} <= ${toPosition}`,
        ),
      )
      .returning({ id: indexerDeadLetters.id });
    return resolved.length;
  }
}
