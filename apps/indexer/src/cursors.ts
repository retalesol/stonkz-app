import { eq, sql } from 'drizzle-orm';
import type { Net } from '@stonkz/shared';
import type { Db } from '@stonkz/api/db/client';
import { indexerCursors } from '@stonkz/api/db/schema';

export interface CursorState {
  net: Net;
  /** Last committed slot (Solana) or block (EVM). */
  position: number;
  /** Chain head as last observed. */
  chainHead: number;
  /** Head minus this chain's confirmation depth: the ceiling on materialising. */
  confirmedHead: number;
  /** Block/slot hash observed at `position`; the reorg-detection input. */
  positionHash: string | null;
  /** Solana's `until` signature at `position`; the source's resume hint. */
  positionSignature: string | null;
  reorgs: number;
  lastReorgAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  /** Consecutive failed passes at `position`; drives the dead-letter skip. */
  failedAttempts: number;
  lastEventAt: number | null;
  updatedAt: number;
}

export interface AdvanceOptions {
  chainHead?: number;
  confirmedHead?: number;
  sawEvent?: boolean;
  /** The chain's identity at the new position, for the next pass's reorg check. */
  positionHash?: string | null;
  positionSignature?: string | null;
}

/**
 * The indexer's two replay cursors (plan step 45).
 *
 * They are deliberately independent rows, not one shared checkpoint: Solana
 * slots and EVM blocks advance at different rates, and one chain's RPC going
 * dark must not stall or rewind the other. Both are seeded by migration 0001,
 * so `indexer_cursors` always holds exactly `SOL` and `RH`.
 *
 * Migration 0007 added the durability columns: the hash and signature at the
 * cursor (so a reorg is detectable and Solana's signature paging can resume),
 * the confirmed head (so the confirmation buffer is visible to an operator,
 * not just implied), and the failure/reorg counters the metrics endpoint
 * exports.
 */
export class ReplayCursors {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  async read(net: Net): Promise<CursorState> {
    const [row] = await this.db.select().from(indexerCursors).where(eq(indexerCursors.net, net)).limit(1);
    if (!row) throw new Error(`indexer cursor for ${net} is missing — migration 0001 seeds it`);
    return {
      net,
      position: row.position,
      chainHead: row.chainHead,
      confirmedHead: row.confirmedHead,
      positionHash: row.positionHash,
      positionSignature: row.positionSignature,
      reorgs: row.reorgs,
      lastReorgAt: row.lastReorgAt?.getTime() ?? null,
      lastError: row.lastError,
      lastErrorAt: row.lastErrorAt?.getTime() ?? null,
      failedAttempts: row.failedAttempts,
      lastEventAt: row.lastEventAt?.getTime() ?? null,
      updatedAt: row.updatedAt.getTime(),
    };
  }

  async readAll(): Promise<Record<Net, CursorState>> {
    const [sol, rh, base] = await Promise.all([this.read('SOL'), this.read('RH'), this.read('BASE')]);
    return { SOL: sol, RH: rh, BASE: base };
  }

  /**
   * Commits progress. The position only ever moves forward: a re-delivered
   * batch from an RPC that rewound must not un-commit work that is already
   * durable in the read tables. A genuine reorg goes through
   * {@link rewind}, which is the only path that moves a cursor backwards.
   *
   * Advancing also clears `failedAttempts` and `lastError` — the pass that
   * reached this position is the proof that whatever was failing recovered.
   */
  async advance(net: Net, position: number, opts: AdvanceOptions = {}): Promise<void> {
    const nowDate = new Date(this.now());
    const current = await this.read(net);
    await this.db
      .update(indexerCursors)
      .set({
        position: Math.max(current.position, position),
        chainHead: Math.max(current.chainHead, opts.chainHead ?? position),
        ...(opts.confirmedHead === undefined
          ? {}
          : { confirmedHead: Math.max(current.confirmedHead, opts.confirmedHead) }),
        ...(opts.positionHash === undefined ? {} : { positionHash: opts.positionHash }),
        ...(opts.positionSignature === undefined ? {} : { positionSignature: opts.positionSignature }),
        ...(opts.sawEvent ? { lastEventAt: nowDate } : {}),
        failedAttempts: 0,
        lastError: null,
        lastErrorAt: null,
        updatedAt: nowDate,
      })
      .where(eq(indexerCursors.net, net));
  }

  /**
   * Moves a cursor backwards. Two legitimate callers: an operator replaying a
   * range (the backfill CLI), and the reorg handler after it has rolled the
   * materialised rows back.
   *
   * The hash and signature at the old position are cleared, because they
   * described a position this cursor no longer sits at — keeping them would
   * make the next pass compare the chain against the wrong block and either
   * miss a reorg or invent one.
   */
  async rewind(net: Net, position: number, opts: { reorg?: boolean } = {}): Promise<void> {
    const nowDate = new Date(this.now());
    await this.db
      .update(indexerCursors)
      .set({
        position,
        positionHash: null,
        positionSignature: null,
        ...(opts.reorg
          ? { reorgs: sql`${indexerCursors.reorgs} + 1`, lastReorgAt: nowDate }
          : {}),
        updatedAt: nowDate,
      })
      .where(eq(indexerCursors.net, net));
  }

  async observeHead(net: Net, chainHead: number, confirmedHead?: number): Promise<void> {
    const current = await this.read(net);
    await this.db
      .update(indexerCursors)
      .set({
        chainHead: Math.max(current.chainHead, chainHead),
        ...(confirmedHead === undefined
          ? {}
          : { confirmedHead: Math.max(current.confirmedHead, confirmedHead) }),
        updatedAt: new Date(this.now()),
      })
      .where(eq(indexerCursors.net, net));
  }

  /**
   * Records a failed pass and returns how many have now failed consecutively
   * at this position. The runner dead-letters the batch once that count
   * reaches `INDEXER_MAX_BATCH_ATTEMPTS`, which is what stops a poison batch
   * from being retried forever.
   */
  async recordFailure(net: Net, error: string): Promise<number> {
    const [row] = await this.db
      .update(indexerCursors)
      .set({
        failedAttempts: sql`${indexerCursors.failedAttempts} + 1`,
        // Truncated because this column is read by the metrics endpoint and a
        // full RPC error body can be kilobytes of provider HTML.
        lastError: error.slice(0, 500),
        lastErrorAt: new Date(this.now()),
        updatedAt: new Date(this.now()),
      })
      .where(eq(indexerCursors.net, net))
      .returning({ failedAttempts: indexerCursors.failedAttempts });
    return row?.failedAttempts ?? 0;
  }

  /** Clears the failure counter without moving the cursor — used after a dead-letter skip. */
  async clearFailures(net: Net): Promise<void> {
    await this.db
      .update(indexerCursors)
      .set({ failedAttempts: 0, updatedAt: new Date(this.now()) })
      .where(eq(indexerCursors.net, net));
  }
}
