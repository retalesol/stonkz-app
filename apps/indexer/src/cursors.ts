import { eq } from 'drizzle-orm';
import type { Net } from '@stonkz/shared';
import type { Db } from '@stonkz/api/db/client';
import { indexerCursors } from '@stonkz/api/db/schema';

export interface CursorState {
  net: Net;
  /** Last committed slot (Solana) or block (EVM). */
  position: number;
  /** Chain head as last observed. */
  chainHead: number;
  lastEventAt: number | null;
  updatedAt: number;
}

/**
 * The indexer's two replay cursors (plan step 45).
 *
 * They are deliberately independent rows, not one shared checkpoint: Solana
 * slots and EVM blocks advance at different rates, and one chain's RPC going
 * dark must not stall or rewind the other. Both are seeded by migration 0001,
 * so `indexer_cursors` always holds exactly `SOL` and `RH`.
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
      lastEventAt: row.lastEventAt?.getTime() ?? null,
      updatedAt: row.updatedAt.getTime(),
    };
  }

  async readAll(): Promise<Record<Net, CursorState>> {
    const [sol, rh] = await Promise.all([this.read('SOL'), this.read('RH')]);
    return { SOL: sol, RH: rh };
  }

  /**
   * Commits progress. The position only ever moves forward: a re-delivered
   * batch from an RPC that rewound must not un-commit work that is already
   * durable in the read tables.
   */
  async advance(net: Net, position: number, opts: { chainHead?: number; sawEvent?: boolean } = {}): Promise<void> {
    const nowDate = new Date(this.now());
    const current = await this.read(net);
    await this.db
      .update(indexerCursors)
      .set({
        position: Math.max(current.position, position),
        chainHead: Math.max(current.chainHead, opts.chainHead ?? position),
        ...(opts.sawEvent ? { lastEventAt: nowDate } : {}),
        updatedAt: nowDate,
      })
      .where(eq(indexerCursors.net, net));
  }

  /** Explicit operator action for a replay — the only way a cursor goes back. */
  async rewind(net: Net, position: number): Promise<void> {
    await this.db
      .update(indexerCursors)
      .set({ position, updatedAt: new Date(this.now()) })
      .where(eq(indexerCursors.net, net));
  }

  async observeHead(net: Net, chainHead: number): Promise<void> {
    const current = await this.read(net);
    await this.db
      .update(indexerCursors)
      .set({ chainHead: Math.max(current.chainHead, chainHead), updatedAt: new Date(this.now()) })
      .where(eq(indexerCursors.net, net));
  }
}
