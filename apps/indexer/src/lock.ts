import { sql } from 'drizzle-orm';
import type { Db } from '@stonkz/api/db/client';
import type { Logger } from '@stonkz/api/observability/logger';

/**
 * Single-writer enforcement, via a Postgres session-level advisory lock.
 *
 * ## Why this is needed at all
 *
 * Ingest is idempotent on `(net, tx_sig, log_index, kind)`, which stops a
 * *replay* from double-counting. It does not stop two replicas running
 * concurrently, because the accumulators are read-modify-write:
 * `creator_vaults.unclaimed_native = unclaimed_native + delta` is only safe
 * once per event, and two replicas that both lose the `chain_events` insert
 * race would still each have applied their own arithmetic. The same goes for
 * `treasuries`, `holders_snapshot` and `candles`. Reorg rollback is worse
 * still: one replica recomputing `candles` from surviving `trades` while
 * another is inserting new ones produces a series that matches neither chain.
 *
 * ## Why an advisory lock and not a Redis leader key
 *
 * The lock lives in the same connection that does the writing. If the indexer
 * process dies, is paused, or is network-partitioned from Postgres, its session
 * ends and the lock is released by the database — there is no lease to expire
 * and no clock to trust. A Redis key needs a TTL, and a TTL is a bet that a
 * stalled process will not wake up and resume writing after its lease lapsed.
 *
 * `pg_try_advisory_lock` is non-blocking on purpose: a second replica should
 * report that it is standing by and exit or idle, not queue behind the first
 * one and silently take over mid-batch.
 *
 * ## The caveat an operator needs to know
 *
 * The lock is held on **one session**. `createDb` opens a pool, and
 * postgres-js does not pin a pooled query to a connection, so the lock is
 * taken on a dedicated single-connection handle — see `worker.ts`, which
 * builds one for exactly this. Sharing the pool would take the lock on a
 * connection that is then returned to the pool and reused, and the lock would
 * be released the moment postgres-js decided to recycle it.
 */
export interface ReplicaLockOptions {
  /** Must be a single-connection handle; see the class comment. */
  db: Db;
  key: number;
  logger: Logger;
}

export class ReplicaLock {
  private held = false;

  constructor(private readonly opts: ReplicaLockOptions) {}

  /** True if this process now owns the lock. False means another replica does. */
  async acquire(): Promise<boolean> {
    const rows = await this.opts.db.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_lock(${this.opts.key}) as locked`,
    );
    // postgres-js returns an array-like of rows; drizzle's `execute` passes it
    // through unchanged rather than normalising it.
    const first = (rows as unknown as { locked: boolean }[])[0];
    this.held = first?.locked === true;

    if (this.held) {
      this.opts.logger.info('acquired the single-writer lock', { key: this.opts.key });
    } else {
      this.opts.logger.error('another indexer replica holds the single-writer lock', {
        key: this.opts.key,
        hint: 'scale this deployment to one replica, or set INDEXER_LOCK_KEY for a separate environment sharing this database',
      });
    }
    return this.held;
  }

  async release(): Promise<void> {
    if (!this.held) return;
    this.held = false;
    try {
      await this.opts.db.execute(sql`select pg_advisory_unlock(${this.opts.key})`);
      this.opts.logger.info('released the single-writer lock', { key: this.opts.key });
    } catch (err) {
      // Not worth failing a shutdown over: ending the session releases it
      // anyway, which is the entire reason this is a session lock.
      this.opts.logger.warn('advisory unlock failed; the session close will release it', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  get isHeld(): boolean {
    return this.held;
  }
}
