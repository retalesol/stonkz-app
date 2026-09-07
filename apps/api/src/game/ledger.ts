import { and, desc, eq, sql } from 'drizzle-orm';
import {
  ACH,
  achOf,
  applyXpMult,
  rankOf,
  xpMult,
  type AchievementKey,
  type CrateTier,
  type Net,
  type RankInfo,
} from '@stonkz/shared';
import type { Db } from '../db/client.js';
import { isUniqueViolation } from '../db/errors.js';
import {
  achievements,
  balanceLedger,
  balances,
  chainEvents,
  crateOpens,
  crateState,
  itemFlags,
  streaks,
  xpEvents,
} from '../db/schema.js';
import type { Publisher } from '../ws/publisher.js';
import { previousUtcDay, utcDayKey } from './day.js';
import { STREAK7_AT, achievementReason, requiresVerifiedEvent } from './rules.js';

export class UnverifiedEventError extends Error {
  constructor(
    readonly reason: string,
    readonly txSig: string | null,
  ) {
    super(
      txSig === null
        ? `reason "${reason}" requires a verified chain event but no tx signature was supplied`
        : `reason "${reason}" has no verified chain event for signature ${txSig}`,
    );
    this.name = 'UnverifiedEventError';
  }
}

export type Asset = 'XP' | 'SP' | 'OPTIONZ';

export interface LedgerOptions {
  db: Db;
  publisher: Publisher;
  dailyXpCap: number;
  dailySpCap: number;
  now?: () => number;
}

export interface AwardInput {
  net: Net;
  wallet: string;
  reason: string;
  /** Pre-multiplier XP, straight from the shared formula. */
  baseXp: number;
  sym?: string | undefined;
  txSig?: string | null | undefined;
  /** Set false for awards that must not mint SP (nothing does today). */
  mirrorSp?: boolean;
  meta?: Record<string, unknown>;
  /** Dust fills record the event at zero rather than skipping it. */
  zeroAward?: boolean;
}

export interface AwardResult {
  /** False when the unique constraint deduped a replay. */
  awarded: boolean;
  xp: number;
  sp: number;
  baseXp: number;
  totalXp: number;
  cappedBy: 'none' | 'daily_xp' | 'dust';
  streak: number;
  mult: number;
  rankBefore: number;
  rankAfter: number;
  rankedUp: boolean;
}

export interface StreakResult {
  count: number;
  mult: number;
  /** True when this call moved the streak to a new UTC day. */
  advanced: boolean;
  unlockedStreak7: boolean;
}

export interface RewardsSnapshot {
  net: Net;
  wallet: string;
  xp: number;
  sp: number;
  optionz: number;
  rank: RankInfo;
  streak: number;
  streakMult: number;
  achievements: { key: AchievementKey; unlockedAt: number }[];
  crates: { tier: CrateTier; readyAt: number; ready: boolean; opens: number }[];
  items: { item: string; count: number; expiresAt: number | null }[];
  dropLog: {
    at: number;
    tier: string;
    rarity: string;
    label: string;
    optionz: number;
    item: string | null;
  }[];
}

/**
 * The server-authoritative game ledger.
 *
 * Two invariants hold everything up:
 *
 *  1. `xp_events` is append-only and uniquely constrained on
 *     `(wallet, tx_sig, reason)`, so replaying a chain event is a no-op rather
 *     than a second payout. `balances` is a materialised fold, never the truth.
 *  2. A reason listed in `CHAIN_VERIFIED_REASONS` is refused unless a matching
 *     `chain_events` row exists. The client cannot mint XP by asserting that
 *     something happened.
 *
 * Award amounts and the streak multiplier come from `@stonkz/shared`, so the
 * server and the sim cannot disagree about what a trade is worth.
 */
export class Ledger {
  private readonly now: () => number;

  constructor(private readonly opts: LedgerOptions) {
    this.now = opts.now ?? Date.now;
  }

  private get db(): Db {
    return this.opts.db;
  }

  /* ---------------------------------------------------------------- streaks */

  /**
   * One increment per UTC day per wallet (plan step 117). Idempotent within a
   * day, so calling it on every request is safe.
   */
  async touchStreak(net: Net, wallet: string): Promise<StreakResult> {
    const today = utcDayKey(this.now());
    const [existing] = await this.db
      .select()
      .from(streaks)
      .where(and(eq(streaks.wallet, wallet), eq(streaks.net, net)))
      .limit(1);

    if (existing?.lastDayUtc === today) {
      return {
        count: existing.count,
        mult: xpMult(existing.count),
        advanced: false,
        unlockedStreak7: false,
      };
    }

    // index.html:2161 — consecutive only if the last visit was yesterday.
    const count = existing?.lastDayUtc === previousUtcDay(today) ? existing.count + 1 : 1;

    await this.db
      .insert(streaks)
      .values({ wallet, net, count, lastDayUtc: today, updatedAt: new Date(this.now()) })
      .onConflictDoUpdate({
        target: [streaks.wallet, streaks.net],
        set: { count, lastDayUtc: today, updatedAt: new Date(this.now()) },
      });

    await this.opts.publisher.user(net, wallet, {
      type: 'streak',
      net,
      wallet,
      count,
      mult: xpMult(count),
    });

    let unlockedStreak7 = false;
    if (count >= STREAK7_AT) {
      unlockedStreak7 = (await this.unlock(net, wallet, 'streak7')).unlocked;
    }
    return { count, mult: xpMult(count), advanced: true, unlockedStreak7 };
  }

  async currentStreak(net: Net, wallet: string): Promise<number> {
    const [row] = await this.db
      .select()
      .from(streaks)
      .where(and(eq(streaks.wallet, wallet), eq(streaks.net, net)))
      .limit(1);
    if (!row?.lastDayUtc) return 0;
    const today = utcDayKey(this.now());
    // A streak that missed a whole day is dead for multiplier purposes.
    if (row.lastDayUtc !== today && row.lastDayUtc !== previousUtcDay(today)) return 0;
    return row.count;
  }

  /* ----------------------------------------------------------------- awards */

  private async assertVerified(reason: string, txSig: string | null | undefined, net: Net): Promise<void> {
    if (!requiresVerifiedEvent(reason)) return;
    if (!txSig) throw new UnverifiedEventError(reason, null);
    const rows = await this.db
      .select({ id: chainEvents.id })
      .from(chainEvents)
      .where(and(eq(chainEvents.net, net), eq(chainEvents.txSig, txSig)))
      .limit(1);
    if (rows.length === 0) throw new UnverifiedEventError(reason, txSig);
  }

  private async xpAwardedToday(net: Net, wallet: string, dayUtc: string): Promise<number> {
    const rows = await this.db
      .select({ total: sql<number>`coalesce(sum(${xpEvents.amount}), 0)::int` })
      .from(xpEvents)
      .where(and(eq(xpEvents.wallet, wallet), eq(xpEvents.net, net), eq(xpEvents.dayUtc, dayUtc)));
    return rows[0]?.total ?? 0;
  }

  private async spAwardedToday(net: Net, wallet: string, dayUtc: string): Promise<number> {
    const rows = await this.db
      .select({ total: sql<number>`coalesce(sum(${balanceLedger.delta}), 0)::int` })
      .from(balanceLedger)
      .where(
        and(
          eq(balanceLedger.wallet, wallet),
          eq(balanceLedger.net, net),
          eq(balanceLedger.asset, 'SP'),
          eq(balanceLedger.dayUtc, dayUtc),
        ),
      );
    return rows[0]?.total ?? 0;
  }

  /**
   * Credits XP (and, 1:1, SP — plan step 109) for one reason.
   *
   * Order matters and mirrors the sim: the streak multiplier is read first
   * (`index.html:2142` applies `xpMult()` inside `addXP`), then the daily cap
   * clamps the result, then the event is appended. If the append hits the
   * uniqueness constraint the whole thing was a replay and nothing is credited.
   */
  async award(input: AwardInput): Promise<AwardResult> {
    const { net, wallet, reason } = input;
    await this.assertVerified(reason, input.txSig, net);

    const dayUtc = utcDayKey(this.now());
    const streak = await this.currentStreak(net, wallet);
    const mult = xpMult(streak);
    const before = await this.readBalance(net, wallet);
    const rankBefore = rankOf(before.xp).i;

    const multiplied = input.zeroAward ? 0 : applyXpMult(input.baseXp, streak);

    let cappedBy: AwardResult['cappedBy'] = input.zeroAward ? 'dust' : 'none';
    let xp = multiplied;
    if (xp > 0) {
      const usedXp = await this.xpAwardedToday(net, wallet, dayUtc);
      const remaining = Math.max(0, this.opts.dailyXpCap - usedXp);
      if (xp > remaining) {
        xp = remaining;
        cappedBy = 'daily_xp';
      }
    }

    let sp = input.mirrorSp === false ? 0 : xp;
    if (sp > 0) {
      const usedSp = await this.spAwardedToday(net, wallet, dayUtc);
      sp = Math.min(sp, Math.max(0, this.opts.dailySpCap - usedSp));
    }

    let eventId: number;
    try {
      const [inserted] = await this.db
        .insert(xpEvents)
        .values({
          wallet,
          net,
          amount: xp,
          baseAmount: input.baseXp,
          reason,
          txSig: input.txSig ?? null,
          sym: input.sym ?? null,
          dayUtc,
          meta: { mult, cappedBy, ...(input.meta ?? {}) },
        })
        .returning({ id: xpEvents.id });
      if (!inserted) throw new Error('xp_events insert returned no row');
      eventId = inserted.id;
    } catch (err) {
      if (isUniqueViolation(err)) {
        return {
          awarded: false,
          xp: 0,
          sp: 0,
          baseXp: input.baseXp,
          totalXp: before.xp,
          cappedBy: 'none',
          streak,
          mult,
          rankBefore,
          rankAfter: rankBefore,
          rankedUp: false,
        };
      }
      throw err;
    }

    // The ledger row points at the `xp_events` row that caused it, not at the
    // signature: one transaction can pay several reasons (a fill that also
    // unlocks `first` and `whale`), and each needs its own idempotency key.
    const after = await this.applyBalanceDeltas(net, wallet, dayUtc, reason, 'xp_event', String(eventId), {
      XP: xp,
      SP: sp,
    });
    const rankAfter = rankOf(after.xp).i;

    if (xp > 0) {
      await this.opts.publisher.user(net, wallet, {
        type: 'xp',
        net,
        wallet,
        amount: xp,
        total: after.xp,
        reason,
      });
    }
    if (sp > 0) {
      await this.opts.publisher.user(net, wallet, { type: 'sp', net, wallet, delta: sp, total: after.sp });
    }
    if (rankAfter > rankBefore) {
      await this.opts.publisher.user(net, wallet, {
        type: 'rank_up',
        net,
        wallet,
        rankIndex: rankAfter,
        name: rankOf(after.xp).name,
      });
    }

    return {
      awarded: true,
      xp,
      sp,
      baseXp: input.baseXp,
      totalXp: after.xp,
      cappedBy,
      streak,
      mult,
      rankBefore,
      rankAfter,
      rankedUp: rankAfter > rankBefore,
    };
  }

  /* ----------------------------------------------------------- achievements */

  /**
   * `index.html:2180` — unlock once, then pay the achievement's own XP through
   * the same multiplier path as everything else.
   */
  async unlock(
    net: Net,
    wallet: string,
    key: AchievementKey,
    txSig?: string | null,
  ): Promise<{ unlocked: boolean; xp: number }> {
    const def = achOf(key);
    if (!def) return { unlocked: false, xp: 0 };

    // The row is claimed first, because its primary key is the once-only
    // guard. Server-authored achievements (`crate`, `social`, `streak7`) carry
    // no signature, so `xp_events`' partial index cannot dedupe them.
    const inserted = await this.db
      .insert(achievements)
      .values({ wallet, net, key, unlockedAt: new Date(this.now()) })
      .onConflictDoNothing()
      .returning({ key: achievements.key });
    if (inserted.length === 0) return { unlocked: false, xp: 0 };

    let award: AwardResult;
    try {
      award = await this.award({
        net,
        wallet,
        reason: achievementReason(key),
        baseXp: def.xp,
        txSig: txSig ?? null,
      });
    } catch (err) {
      // Release the claim, or the wallet would show the achievement as earned
      // while never having been paid for it — and a retry would see it as
      // already unlocked and pay nothing.
      await this.db
        .delete(achievements)
        .where(and(eq(achievements.wallet, wallet), eq(achievements.net, net), eq(achievements.key, key)));
      throw err;
    }

    await this.opts.publisher.user(net, wallet, {
      type: 'achievement',
      net,
      wallet,
      key,
      xp: award.xp,
    });
    return { unlocked: true, xp: award.xp };
  }

  async unlockedKeys(net: Net, wallet: string): Promise<Set<AchievementKey>> {
    const rows = await this.db
      .select({ key: achievements.key })
      .from(achievements)
      .where(and(eq(achievements.wallet, wallet), eq(achievements.net, net)));
    return new Set(rows.map((r) => r.key as AchievementKey));
  }

  /* --------------------------------------------------------------- balances */

  async readBalance(net: Net, wallet: string): Promise<{ xp: number; sp: number; optionz: number }> {
    const [row] = await this.db
      .select()
      .from(balances)
      .where(and(eq(balances.wallet, wallet), eq(balances.net, net)))
      .limit(1);
    return { xp: row?.xp ?? 0, sp: row?.sp ?? 0, optionz: row?.optionz ?? 0 };
  }

  private async applyBalanceDeltas(
    net: Net,
    wallet: string,
    dayUtc: string,
    reason: string,
    refType: string,
    refId: string | null,
    deltas: Partial<Record<Asset, number>>,
  ): Promise<{ xp: number; sp: number; optionz: number }> {
    const xp = deltas.XP ?? 0;
    const sp = deltas.SP ?? 0;
    const optionz = deltas.OPTIONZ ?? 0;

    const [row] = await this.db
      .insert(balances)
      .values({ wallet, net, xp, sp, optionz, updatedAt: new Date(this.now()) })
      .onConflictDoUpdate({
        target: [balances.wallet, balances.net],
        set: {
          xp: sql`${balances.xp} + ${xp}`,
          sp: sql`${balances.sp} + ${sp}`,
          optionz: sql`${balances.optionz} + ${optionz}`,
          updatedAt: new Date(this.now()),
        },
      })
      .returning({ xp: balances.xp, sp: balances.sp, optionz: balances.optionz });

    const totals = { xp: row?.xp ?? xp, sp: row?.sp ?? sp, optionz: row?.optionz ?? optionz };

    const entries: { asset: Asset; delta: number; balanceAfter: number }[] = [];
    if (xp !== 0) entries.push({ asset: 'XP', delta: xp, balanceAfter: totals.xp });
    if (sp !== 0) entries.push({ asset: 'SP', delta: sp, balanceAfter: totals.sp });
    if (optionz !== 0) entries.push({ asset: 'OPTIONZ', delta: optionz, balanceAfter: totals.optionz });

    if (entries.length > 0) {
      await this.db.insert(balanceLedger).values(
        entries.map((e) => ({
          wallet,
          net,
          asset: e.asset,
          delta: e.delta,
          balanceAfter: e.balanceAfter,
          reason,
          refType,
          // The partial unique index needs one ref per asset, not per event.
          refId: refId === null ? null : `${refId}:${e.asset}`,
          dayUtc,
        })),
      );
    }
    return totals;
  }

  /**
   * Crate `S` drops pay Stonk Optionz (plan step 107) — never `$STONKZ`, which
   * does not exist yet. `refId` makes the credit idempotent per crate open.
   */
  async creditOptionz(
    net: Net,
    wallet: string,
    amount: number,
    reason: string,
    refId: string,
  ): Promise<number> {
    if (amount <= 0) return (await this.readBalance(net, wallet)).optionz;
    const totals = await this.applyBalanceDeltas(
      net,
      wallet,
      utcDayKey(this.now()),
      reason,
      'crate_open',
      refId,
      { OPTIONZ: amount },
    );
    await this.opts.publisher.user(net, wallet, {
      type: 'optionz',
      net,
      wallet,
      delta: amount,
      total: totals.optionz,
    });
    return totals.optionz;
  }

  async grantItem(net: Net, wallet: string, item: string, expiresAt: Date | null): Promise<void> {
    await this.db
      .insert(itemFlags)
      .values({ wallet, net, item, count: 1, grantedAt: new Date(this.now()), expiresAt })
      .onConflictDoUpdate({
        target: [itemFlags.wallet, itemFlags.net, itemFlags.item],
        set: { count: sql`${itemFlags.count} + 1`, expiresAt },
      });
  }

  /* --------------------------------------------------------------- snapshot */

  /** Backs `GET /rewards` and the rewards half of `GET /me`. */
  async snapshot(net: Net, wallet: string): Promise<RewardsSnapshot> {
    const [bal, achRows, crateRows, itemRows, logRows, streak] = await Promise.all([
      this.readBalance(net, wallet),
      this.db
        .select()
        .from(achievements)
        .where(and(eq(achievements.wallet, wallet), eq(achievements.net, net))),
      this.db
        .select()
        .from(crateState)
        .where(and(eq(crateState.wallet, wallet), eq(crateState.net, net))),
      this.db.select().from(itemFlags).where(and(eq(itemFlags.wallet, wallet), eq(itemFlags.net, net))),
      this.db
        .select()
        .from(crateOpens)
        .where(and(eq(crateOpens.wallet, wallet), eq(crateOpens.net, net)))
        .orderBy(desc(crateOpens.id))
        // index.html:2377 keeps the last 14 rows in the drop log.
        .limit(14),
      this.currentStreak(net, wallet),
    ]);

    const now = this.now();
    return {
      net,
      wallet,
      xp: bal.xp,
      sp: bal.sp,
      optionz: bal.optionz,
      rank: rankOf(bal.xp),
      streak,
      streakMult: xpMult(streak),
      achievements: achRows.map((r) => ({
        key: r.key as AchievementKey,
        unlockedAt: r.unlockedAt.getTime(),
      })),
      crates: crateRows.map((r) => ({
        tier: r.tier as CrateTier,
        readyAt: r.readyAt.getTime(),
        ready: r.readyAt.getTime() <= now,
        opens: r.opens,
      })),
      items: itemRows.map((r) => ({
        item: r.item,
        count: r.count,
        expiresAt: r.expiresAt?.getTime() ?? null,
      })),
      dropLog: logRows.map((r) => {
        const payload = r.payloadJson as { label?: string };
        return {
          at: r.openedAt.getTime(),
          tier: r.tier,
          rarity: r.rarity,
          label: payload.label ?? '',
          optionz: r.optionzAwarded,
          item: r.itemKey,
        };
      }),
    };
  }

  /** Achievement definitions plus this wallet's unlocks — `GET /achievements`. */
  async achievementList(
    net: Net,
    wallet: string | null,
  ): Promise<{ key: AchievementKey; name: string; desc: string; xp: number; unlockedAt: number | null }[]> {
    const unlocked =
      wallet === null
        ? new Map<string, number>()
        : new Map(
            (
              await this.db
                .select()
                .from(achievements)
                .where(and(eq(achievements.wallet, wallet), eq(achievements.net, net)))
            ).map((r) => [r.key, r.unlockedAt.getTime()]),
          );

    return ACH.map((a) => ({
      key: a.k,
      name: a.n,
      desc: a.d,
      xp: a.xp,
      unlockedAt: unlocked.get(a.k) ?? null,
    }));
  }
}
