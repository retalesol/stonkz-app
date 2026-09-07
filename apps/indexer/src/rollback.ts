import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';
import { laneOf, type Net } from '@stonkz/shared';
import type { Db } from '@stonkz/api/db/client';
import {
  achievements,
  balanceLedger,
  balances,
  candles,
  chainEvents,
  creatorVaults,
  holdersSnapshot,
  koth,
  stakePositions,
  tape,
  tokens,
  trades,
  treasuries,
  treasuryCredits,
  xpEvents,
} from '@stonkz/api/db/schema';
import type { Logger } from '@stonkz/api/observability/logger';
import { utcDayKey } from '@stonkz/api/game/day';
import { candleUpdatesFor } from './candles.js';
import type { CurveSnapshot, FeeAccruedEvent, StakedEvent } from './events.js';

/** Matches `Ingestor`'s 24H window, so `chg` means the same thing after a rollback. */
const CHANGE_WINDOW_MS = 86_400_000;

/**
 * The transaction handle Drizzle hands a `db.transaction` callback. Structurally
 * a `Db` for every query this file issues, but not nominally the same type.
 */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Undoing everything a reorged-out range of the chain caused.
 *
 * ## Why this is not just `DELETE FROM chain_events`
 *
 * Ingest writes three different *kinds* of row, and each needs a different
 * kind of undo:
 *
 * 1. **Position-scoped rows** — `chain_events`, `trades`, `tape`,
 *    `treasury_credits` all carry `chain_position`, so they are deleted
 *    exactly by range. Migration 0007 added that column to `tape` and
 *    `treasury_credits` for precisely this reason.
 * 2. **Additive accumulators** — `creator_vaults`, `treasuries`,
 *    `stake_positions` are running sums of per-event deltas, so subtracting
 *    the disowned events' own deltas is exact. The deltas are read back out of
 *    the `chain_events` payloads, which is the reason that table stores the
 *    whole event and not just its identity.
 * 3. **Non-invertible derived state** — `candles` (`greatest`/`least` for the
 *    high and low, last-write-wins for the close) and `holders_snapshot`
 *    (pro-rata cost-basis retirement on sells) cannot be un-applied by
 *    subtraction. These are **recomputed** from the `trades` rows that survive
 *    the rollback, which is the only way to get them right.
 *
 * `tokens.mc`, `holders`, `chg`, `lane` and `koth` fall out of (3).
 *
 * ## The ledger policy
 *
 * `xp_events` rows for a disowned signature are **deleted**, and the
 * corresponding `balances` credit is reversed with a `balance_ledger` debit
 * (`reason: 'reorg_reversal'`).
 *
 * Deleting rather than appending a compensating `xp_events` row is a
 * deliberate choice against that table's usual append-only rule, and the
 * reason is `xp_events_sig_reason_uq`. That index on
 * `(wallet, tx_sig, reason)` is what makes replaying a chain event a no-op.
 * A reorg normally *re-includes* the same transactions in the new canonical
 * chain, so if the awarding row were left in place and merely compensated, the
 * re-ingest would hit the constraint, be treated as a replay, and the wallet
 * would never be paid for a trade that really did happen. Deleting the row
 * restores the pre-award state exactly, so re-ingest pays once — which is what
 * the constraint is there to guarantee.
 *
 * Nothing is lost from the audit trail: `balance_ledger` is untouched and
 * append-only, so the original credit *and* its `reorg_reversal` debit are
 * both still readable, and the deleted `xp_events` row's id is in the credit's
 * `ref_id`.
 *
 * Two things are deliberately **not** rewound:
 *
 * - **Streaks.** A streak records "this wallet showed up on this UTC day",
 *   which is a fact about the wallet's session, not about the transaction. A
 *   reorg does not un-happen the visit.
 * - **Achievements with no signature** (`crate`, `social`, `streak7`). They
 *   were never chain-derived, so no chain event can disown them. Chain-derived
 *   unlocks *are* revoked, identified by the `ach:` prefix on the reason of
 *   the `xp_events` row that paid for them.
 */
export interface RollbackReport {
  net: Net;
  /** Everything at or after this position was disowned. */
  fromPosition: number;
  events: number;
  trades: number;
  tapeRows: number;
  treasuryCredits: number;
  tokensDropped: string[];
  symsRecomputed: string[];
  xpEventsDeleted: number;
  xpReversed: number;
  spReversed: number;
  achievementsRevoked: number;
}

export interface RollbackOptions {
  db: Db;
  logger: Logger;
  now?: () => number;
}

export function emptyRollbackReport(net: Net, fromPosition: number): RollbackReport {
  return {
    net,
    fromPosition,
    events: 0,
    trades: 0,
    tapeRows: 0,
    treasuryCredits: 0,
    tokensDropped: [],
    symsRecomputed: [],
    xpEventsDeleted: 0,
    xpReversed: 0,
    spReversed: 0,
    achievementsRevoked: 0,
  };
}

export class ReorgRollback {
  private readonly now: () => number;

  constructor(private readonly opts: RollbackOptions) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * Removes every trace of `net`'s events at or after `fromPosition`.
   *
   * Runs in one transaction: a partial rollback would leave the read tables
   * describing a chain that never existed, which is strictly worse than either
   * end state.
   */
  async rollback(net: Net, fromPosition: number): Promise<RollbackReport> {
    const report = emptyRollbackReport(net, fromPosition);

    await this.opts.db.transaction(async (tx) => {
      const disowned = await tx
        .select()
        .from(chainEvents)
        .where(and(eq(chainEvents.net, net), gte(chainEvents.chainPosition, fromPosition)))
        .orderBy(asc(chainEvents.chainPosition), asc(chainEvents.id));
      if (disowned.length === 0) return;

      report.events = disowned.length;
      const signatures = [...new Set(disowned.map((e) => e.txSig))];
      const affectedSyms = [...new Set(disowned.map((e) => e.sym).filter((s): s is string => s !== null))];
      const droppedSyms = disowned.filter((e) => e.kind === 'TokenCreated').map((e) => e.sym as string);
      report.tokensDropped = [...new Set(droppedSyms)];

      await this.reverseLedger(tx, net, signatures, report);
      await this.unwindAccumulators(tx, net, disowned);
      await this.deletePositionScoped(tx, net, fromPosition, report);

      // A launch that never happened takes its whole token with it, including
      // rows no `chain_position` can reach (the creator vault, stake
      // positions, the candle series).
      for (const sym of report.tokensDropped) await this.dropToken(tx, net, sym);

      const survivors = affectedSyms.filter((s) => !report.tokensDropped.includes(s));
      for (const sym of survivors) await this.recomputeSym(tx, net, sym);
      report.symsRecomputed = survivors;

      await tx
        .delete(chainEvents)
        .where(and(eq(chainEvents.net, net), gte(chainEvents.chainPosition, fromPosition)));

      await this.recomputeKoth(tx, net);
    });

    this.opts.logger.warn('rolled back reorged range', { ...report });
    return report;
  }

  /* ------------------------------------------------------------- the ledger */

  private async reverseLedger(
    tx: Tx,
    net: Net,
    signatures: readonly string[],
    report: RollbackReport,
  ): Promise<void> {
    if (signatures.length === 0) return;

    const paid = await tx
      .select()
      .from(xpEvents)
      .where(and(eq(xpEvents.net, net), inArray(xpEvents.txSig, [...signatures])));
    if (paid.length === 0) return;

    // SP is mirrored 1:1 off XP but clamped by its own daily cap, so the real
    // SP credited is only knowable from `balance_ledger`, not from
    // `xp_events.amount`. Read it back per awarding row.
    const spRefIds = paid.map((row) => `${row.id}:SP`);
    const spRows = await tx
      .select({ refId: balanceLedger.refId, delta: balanceLedger.delta })
      .from(balanceLedger)
      .where(
        and(
          eq(balanceLedger.net, net),
          eq(balanceLedger.asset, 'SP'),
          eq(balanceLedger.refType, 'xp_event'),
          inArray(balanceLedger.refId, spRefIds),
        ),
      );
    const spByRef = new Map(spRows.map((r) => [r.refId ?? '', r.delta]));

    const perWallet = new Map<string, { xp: number; sp: number }>();
    const revoke: { wallet: string; key: string }[] = [];

    for (const row of paid) {
      const acc = perWallet.get(row.wallet) ?? { xp: 0, sp: 0 };
      acc.xp += row.amount;
      acc.sp += spByRef.get(`${row.id}:SP`) ?? 0;
      perWallet.set(row.wallet, acc);
      // `ach:<key>` is `achievementReason()`'s shape. An unlock paid for by a
      // disowned transaction is an unlock that never happened.
      if (row.reason.startsWith('ach:')) revoke.push({ wallet: row.wallet, key: row.reason.slice(4) });
    }

    await tx.delete(xpEvents).where(
      inArray(
        xpEvents.id,
        paid.map((r) => r.id),
      ),
    );
    report.xpEventsDeleted = paid.length;

    const dayUtc = utcDayKey(this.now());
    for (const [wallet, { xp, sp }] of perWallet) {
      if (xp === 0 && sp === 0) continue;
      const [after] = await tx
        .update(balances)
        .set({
          // `greatest` guards the case where a crate spend already drew the
          // balance below the credit being reversed; the invariant that
          // matters is that no reorged credit is still spendable, not that the
          // arithmetic can go negative.
          xp: sql`greatest(0, ${balances.xp} - ${xp})`,
          sp: sql`greatest(0, ${balances.sp} - ${sp})`,
          updatedAt: new Date(this.now()),
        })
        .where(and(eq(balances.wallet, wallet), eq(balances.net, net)))
        .returning({ xp: balances.xp, sp: balances.sp });

      const debits = [
        { asset: 'XP' as const, delta: -xp, balanceAfter: after?.xp ?? 0 },
        { asset: 'SP' as const, delta: -sp, balanceAfter: after?.sp ?? 0 },
      ].filter((d) => d.delta !== 0);

      if (debits.length > 0) {
        await tx.insert(balanceLedger).values(
          debits.map((d) => ({
            wallet,
            net,
            asset: d.asset,
            delta: d.delta,
            balanceAfter: d.balanceAfter,
            reason: 'reorg_reversal',
            refType: 'reorg',
            refId: `${net}:${report.fromPosition}:${d.asset}`,
            dayUtc,
          })),
        );
      }
      report.xpReversed += xp;
      report.spReversed += sp;
    }

    for (const { wallet, key } of revoke) {
      const deleted = await tx
        .delete(achievements)
        .where(and(eq(achievements.wallet, wallet), eq(achievements.net, net), eq(achievements.key, key)))
        .returning({ key: achievements.key });
      report.achievementsRevoked += deleted.length;
    }
  }

  /* --------------------------------------------------- additive accumulators */

  /**
   * Subtracts the disowned events' own deltas from the running sums.
   *
   * Exact, because every one of these columns is only ever written as
   * `column + delta` and the delta is in the event payload. `greatest(0, …)`
   * is belt-and-braces for a vault that was already drained by a claim.
   */
  private async unwindAccumulators(
    tx: Tx,
    net: Net,
    disowned: readonly { kind: string; sym: string | null; wallet: string | null; payload: unknown }[],
  ): Promise<void> {
    for (const row of disowned) {
      switch (row.kind) {
        case 'FeeAccrued': {
          if (!row.sym) break;
          const fee = row.payload as Pick<
            FeeAccruedEvent,
            'creatorBucket' | 'stakerShare' | 'creatorTokens' | 'protocol' | 'stonkzOps'
          >;
          const creatorNet = fee.creatorBucket - fee.stakerShare;
          await tx
            .update(creatorVaults)
            .set({
              unclaimedNative: sql`greatest(0, ${creatorVaults.unclaimedNative} - ${creatorNet})`,
              unclaimedTokens: sql`greatest(0, ${creatorVaults.unclaimedTokens} - ${fee.creatorTokens})`,
              stakerPoolNative: sql`greatest(0, ${creatorVaults.stakerPoolNative} - ${fee.stakerShare})`,
              lifetimeNative: sql`greatest(0, ${creatorVaults.lifetimeNative} - ${fee.creatorBucket})`,
              updatedAt: new Date(this.now()),
            })
            .where(and(eq(creatorVaults.net, net), eq(creatorVaults.sym, row.sym)));
          break;
        }

        case 'CreatorFeesClaimed': {
          if (!row.sym) break;
          const claim = row.payload as { nativeAmount: number; tokenAmount: number };
          // A claim *reduced* the unclaimed balance, so undoing it puts the
          // money back.
          await tx
            .update(creatorVaults)
            .set({
              unclaimedNative: sql`${creatorVaults.unclaimedNative} + ${claim.nativeAmount}`,
              unclaimedTokens: sql`${creatorVaults.unclaimedTokens} + ${claim.tokenAmount}`,
              claimedNative: sql`greatest(0, ${creatorVaults.claimedNative} - ${claim.nativeAmount})`,
              updatedAt: new Date(this.now()),
            })
            .where(and(eq(creatorVaults.net, net), eq(creatorVaults.sym, row.sym)));
          break;
        }

        case 'Staked': {
          if (!row.sym || !row.wallet) break;
          const stake = row.payload as Pick<StakedEvent, 'amount'>;
          await tx
            .update(stakePositions)
            .set({
              amount: sql`greatest(0, ${stakePositions.amount} - ${stake.amount})`,
              updatedAt: new Date(this.now()),
            })
            .where(
              and(
                eq(stakePositions.net, net),
                eq(stakePositions.sym, row.sym),
                eq(stakePositions.wallet, row.wallet),
              ),
            );
          break;
        }

        case 'Unstaked': {
          if (!row.sym || !row.wallet) break;
          const unstake = row.payload as { amount: number };
          await tx
            .update(stakePositions)
            .set({
              amount: sql`${stakePositions.amount} + ${unstake.amount}`,
              updatedAt: new Date(this.now()),
            })
            .where(
              and(
                eq(stakePositions.net, net),
                eq(stakePositions.sym, row.sym),
                eq(stakePositions.wallet, row.wallet),
              ),
            );
          break;
        }

        case 'StakeClaimed': {
          if (!row.sym || !row.wallet) break;
          const claim = row.payload as { rewardNative: number; rewardTokens: number };
          await tx
            .update(stakePositions)
            .set({
              rewardNative: sql`greatest(0, ${stakePositions.rewardNative} - ${claim.rewardNative})`,
              rewardTokens: sql`greatest(0, ${stakePositions.rewardTokens} - ${claim.rewardTokens})`,
              updatedAt: new Date(this.now()),
            })
            .where(
              and(
                eq(stakePositions.net, net),
                eq(stakePositions.sym, row.sym),
                eq(stakePositions.wallet, row.wallet),
              ),
            );
          break;
        }

        // `Trade`, `TokenCreated`, `Graduated` and `TreasuryCredit` are handled
        // by the position-scoped deletes and the recompute; `CashbackWindow`
        // only sets a flag, which the recompute restores from `tokens`.
        default:
          break;
      }
    }
  }

  /* ------------------------------------------------------ position-scoped rows */

  private async deletePositionScoped(
    tx: Tx,
    net: Net,
    fromPosition: number,
    report: RollbackReport,
  ): Promise<void> {
    // Treasury balances first: the credit rows are the record of how much to
    // take back out, so they have to be read before they are deleted.
    const credits = await tx
      .select({ kind: treasuryCredits.kind, amount: treasuryCredits.amount })
      .from(treasuryCredits)
      .where(and(eq(treasuryCredits.net, net), gte(treasuryCredits.chainPosition, fromPosition)));

    const byKind = new Map<string, number>();
    for (const credit of credits) byKind.set(credit.kind, (byKind.get(credit.kind) ?? 0) + credit.amount);
    for (const [kind, amount] of byKind) {
      await tx
        .update(treasuries)
        .set({
          nativeBalance: sql`greatest(0, ${treasuries.nativeBalance} - ${amount})`,
          lifetimeCredited: sql`greatest(0, ${treasuries.lifetimeCredited} - ${amount})`,
          updatedAt: new Date(this.now()),
        })
        .where(and(eq(treasuries.net, net), eq(treasuries.kind, kind)));
    }
    report.treasuryCredits = credits.length;

    await tx
      .delete(treasuryCredits)
      .where(and(eq(treasuryCredits.net, net), gte(treasuryCredits.chainPosition, fromPosition)));

    const deletedTrades = await tx
      .delete(trades)
      .where(and(eq(trades.net, net), gte(trades.chainPosition, fromPosition)))
      .returning({ id: trades.id });
    report.trades = deletedTrades.length;

    const deletedTape = await tx
      .delete(tape)
      .where(and(eq(tape.net, net), gte(tape.chainPosition, fromPosition)))
      .returning({ id: tape.id });
    report.tapeRows = deletedTape.length;
  }

  /** A launch that got reorged out leaves nothing behind. */
  private async dropToken(tx: Tx, net: Net, sym: string): Promise<void> {
    await tx.delete(candles).where(and(eq(candles.net, net), eq(candles.sym, sym)));
    await tx.delete(holdersSnapshot).where(and(eq(holdersSnapshot.net, net), eq(holdersSnapshot.sym, sym)));
    await tx.delete(stakePositions).where(and(eq(stakePositions.net, net), eq(stakePositions.sym, sym)));
    await tx.delete(creatorVaults).where(and(eq(creatorVaults.net, net), eq(creatorVaults.sym, sym)));
    await tx.delete(tokens).where(and(eq(tokens.net, net), eq(tokens.sym, sym)));
  }

  /* --------------------------------------------------------- the recompute */

  /**
   * Rebuilds everything that is a fold over `trades` for one token.
   *
   * The surviving `trades` rows are the source of truth: they were deleted by
   * position a moment ago, so what is left is exactly the fills the new
   * canonical chain still contains. Replaying them in order reproduces the
   * candle series and every holder's position and cost basis — including the
   * pro-rata retirement on sells, which is why this is a replay and not a
   * subtraction.
   */
  private async recomputeSym(tx: Tx, net: Net, sym: string): Promise<void> {
    const surviving = await tx
      .select()
      .from(trades)
      .where(and(eq(trades.net, net), eq(trades.sym, sym)))
      .orderBy(asc(trades.chainPosition), asc(trades.id));

    await tx.delete(candles).where(and(eq(candles.net, net), eq(candles.sym, sym)));
    await tx.delete(holdersSnapshot).where(and(eq(holdersSnapshot.net, net), eq(holdersSnapshot.sym, sym)));

    interface Bucket {
      tf: string;
      bucketStart: number;
      o: number;
      h: number;
      l: number;
      c: number;
      v: number;
      nativeVolume: number;
      trades: number;
    }
    const buckets = new Map<string, Bucket>();
    const holders = new Map<
      string,
      { tokenAmount: number; costNative: number; realizedNative: number; firstSeen: number; updatedAt: number }
    >();

    for (const fill of surviving) {
      const at = fill.blockTime.getTime();
      for (const update of candleUpdatesFor(at, fill.price, fill.usdValue, fill.nativeAmount)) {
        const key = `${update.tf}:${update.bucketStart}`;
        const bucket = buckets.get(key);
        if (bucket) {
          bucket.h = Math.max(bucket.h, fill.price);
          bucket.l = Math.min(bucket.l, fill.price);
          bucket.c = fill.price;
          bucket.v += update.usdVolume;
          bucket.nativeVolume += update.nativeVolume;
          bucket.trades += 1;
        } else {
          buckets.set(key, {
            tf: update.tf,
            bucketStart: update.bucketStart,
            o: fill.price,
            h: fill.price,
            l: fill.price,
            c: fill.price,
            v: update.usdVolume,
            nativeVolume: update.nativeVolume,
            trades: 1,
          });
        }
      }

      const holder =
        holders.get(fill.trader) ??
        { tokenAmount: 0, costNative: 0, realizedNative: 0, firstSeen: at, updatedAt: at };
      if (fill.side === 'buy') {
        holder.tokenAmount += fill.tokenAmount;
        holder.costNative += fill.nativeAmount;
      } else {
        // The same pro-rata retirement `Ingestor.updateHolder` applies.
        const sold = Math.min(fill.tokenAmount, holder.tokenAmount);
        const fraction = holder.tokenAmount > 0 ? sold / holder.tokenAmount : 0;
        const costOut = holder.costNative * fraction;
        holder.tokenAmount = Math.max(0, holder.tokenAmount - sold);
        holder.costNative = Math.max(0, holder.costNative - costOut);
        holder.realizedNative += fill.nativeAmount - costOut;
      }
      holder.updatedAt = at;
      holders.set(fill.trader, holder);
    }

    if (buckets.size > 0) {
      await tx.insert(candles).values(
        [...buckets.values()].map((b) => ({
          net,
          sym,
          tf: b.tf,
          bucketStart: new Date(b.bucketStart),
          o: b.o,
          h: b.h,
          l: b.l,
          c: b.c,
          v: b.v,
          nativeVolume: b.nativeVolume,
          trades: b.trades,
        })),
      );
    }

    if (holders.size > 0) {
      await tx.insert(holdersSnapshot).values(
        [...holders].map(([wallet, h]) => ({
          net,
          sym,
          wallet,
          tokenAmount: h.tokenAmount,
          costNative: h.costNative,
          realizedNative: h.realizedNative,
          firstSeen: new Date(h.firstSeen),
          updatedAt: new Date(h.updatedAt),
        })),
      );
    }

    const [row] = await tx
      .select({ sym: tokens.sym })
      .from(tokens)
      .where(and(eq(tokens.net, net), eq(tokens.sym, sym)))
      .limit(1);
    if (!row) return;

    // With every fill gone the token is back to its launch state, which the
    // surviving `TokenCreated` event still describes exactly — including the
    // opening market cap and the untouched curve reserves.
    const [launch] = await tx
      .select({ payload: chainEvents.payload })
      .from(chainEvents)
      .where(
        and(eq(chainEvents.net, net), eq(chainEvents.sym, sym), eq(chainEvents.kind, 'TokenCreated')),
      )
      .limit(1);
    const launchPayload = launch?.payload as { mc?: number; curve?: CurveSnapshot } | undefined;

    // A graduation is itself a chain event, so a token whose `Graduated` was
    // disowned has to come back out of the `grad` lane.
    const stillGraduated = await tx
      .select({ id: chainEvents.id })
      .from(chainEvents)
      .where(and(eq(chainEvents.net, net), eq(chainEvents.sym, sym), eq(chainEvents.kind, 'Graduated')))
      .limit(1);

    const last = surviving.at(-1);
    const mc = last?.mc ?? launchPayload?.mc ?? 0;
    const anchor = surviving.find(
      (t) => t.blockTime.getTime() >= (last?.blockTime.getTime() ?? 0) - CHANGE_WINDOW_MS,
    );
    const basis = anchor?.mc ?? mc;

    // The curve reserves that produced the last surviving fill. `trades` does
    // not carry them, so they come from that fill's own `chain_events` row —
    // the same payload the source decoded them into.
    const [lastFill] = last
      ? await tx
          .select({ payload: chainEvents.payload })
          .from(chainEvents)
          .where(
            and(
              eq(chainEvents.net, net),
              eq(chainEvents.txSig, last.txSig),
              eq(chainEvents.logIndex, last.logIndex),
              eq(chainEvents.kind, 'Trade'),
            ),
          )
          .limit(1)
      : [undefined];
    const reserves = (lastFill?.payload ?? {}) as { realBase?: string; realToken?: string };
    const restoredBase = reserves.realBase ?? launchPayload?.curve?.realBase;
    const restoredToken = reserves.realToken ?? launchPayload?.curve?.realToken;

    await tx
      .update(tokens)
      .set({
        mc,
        lastMc: surviving.at(-2)?.mc ?? mc,
        chg: basis > 0 ? ((mc - basis) / basis) * 100 : 0,
        holders: [...holders.values()].filter((h) => h.tokenAmount > 0).length,
        lane: stillGraduated.length > 0 ? 'grad' : laneOf({ mc }),
        ...(stillGraduated.length > 0 ? {} : { graduatedAt: null }),
        ...(restoredBase === undefined ? {} : { curveRealBase: restoredBase }),
        ...(restoredToken === undefined ? {} : { curveRealToken: restoredToken }),
        updatedAt: new Date(this.now()),
      })
      .where(and(eq(tokens.net, net), eq(tokens.sym, sym)));
  }

  /** The crown is a pure function of `tokens`, so it is re-derived, not undone. */
  private async recomputeKoth(tx: Tx, net: Net): Promise<void> {
    const [best] = await tx
      .select({ sym: tokens.sym, mc: tokens.mc })
      .from(tokens)
      .where(and(eq(tokens.net, net), inArray(tokens.lane, ['new', 'soon'])))
      .orderBy(sql`${tokens.mc} desc`)
      .limit(1);

    if (!best) {
      await tx.delete(koth).where(eq(koth.net, net));
      return;
    }
    await tx
      .insert(koth)
      .values({ net, sym: best.sym, mc: best.mc, crownedAt: new Date(this.now()) })
      .onConflictDoUpdate({
        target: koth.net,
        set: { sym: best.sym, mc: best.mc, crownedAt: new Date(this.now()) },
      });
  }
}

