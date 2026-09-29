import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  REFERRAL_FEE_RATES,
  REFERRAL_STONKZ_PER_NATIVE,
  referralFeePayouts,
  referralSpKickback,
  type Net,
  type ReferralTier,
} from '@stonkz/shared';
import type { Db } from '../db/client.js';
import {
  referralCodes,
  referralFeeBalances,
  referralFeeEvents,
  referralFeeTierBalances,
  referralPayouts,
  referrals,
  trades,
} from '../db/schema.js';
import type { Ledger } from './ledger.js';
import { REASONS } from './rules.js';

export interface ReferralServiceOptions {
  db: Db;
  ledger: Ledger;
  now?: () => number;
}

/** How a referrer wants a claim settled. */
export type ReferralPayoutMode = 'stonkz' | 'native';

export interface ReferralTierSnapshot {
  tier: ReferralTier;
  rate: number;
  pendingNative: number;
  lifetimeNative: number;
  fills: number;
}

export interface ReferralPayoutRow {
  id: number;
  net: Net;
  wallet: string;
  amountNative: number;
  mode: ReferralPayoutMode;
  status: 'requested' | 'paid' | 'void';
  tiers: Record<string, number>;
  stonkz: number | null;
  txSig: string | null;
  requestedAt: number;
  settledAt: number | null;
}

export interface ReferralClaimResult {
  mode: ReferralPayoutMode;
  claimedNative: number;
  /** Reward credits granted (`stonkz` mode), else 0. */
  stonkz: number;
  stonkzTotal: number;
  /** The `referral_payouts` row, when something was claimed. */
  payoutId: number | null;
  /** Per-tier breakdown of `claimedNative`. */
  tiers: Record<string, number>;
}

function makeCode(wallet: string): string {
  const salt = randomBytes(3).toString('hex');
  const digest = createHash('sha256').update(`${wallet}:${salt}`).digest('hex');
  return digest.slice(0, 8).toUpperCase();
}

/**
 * Referral graph + fee/SP kickbacks.
 *
 * - Fee shares: 15% / 10% / 5% of the referred trader's curve `feeAmount` for
 *   T1 / T2 / T3, funded from the platform's 15% leg. If the three tiers would
 *   exceed that leg they scale down to fit it, so the platform's on-chain
 *   protocol vault always holds every commission it owes. The indexer credits
 *   the DB protocol treasury **net** of these cuts (`ingest.ts`
 *   `reconcileFeeAccrued`), so the difference between the on-chain protocol
 *   vault and the DB treasury is exactly the unpaid referral commissions.
 * - SP kickback: 5% of SP a **direct** referee earns (no recursion).
 * - Claims: `stonkz` converts the pending balance into `$STONKZ` reward
 *   credits at once; `native` records a payout request that the protocol
 *   withdraw authority settles from the vault in a batch. Both drain the
 *   balance atomically and leave a `referral_payouts` row.
 */
export class ReferralService {
  private readonly now: () => number;

  constructor(private readonly opts: ReferralServiceOptions) {
    this.now = opts.now ?? Date.now;
  }

  private get db(): Db {
    return this.opts.db;
  }

  private get ledger(): Ledger {
    return this.opts.ledger;
  }

  /** Ensure the wallet has a shareable code; create one if missing. */
  async ensureCode(net: Net, wallet: string): Promise<string> {
    const [existing] = await this.db
      .select()
      .from(referralCodes)
      .where(and(eq(referralCodes.net, net), eq(referralCodes.wallet, wallet)))
      .limit(1);
    if (existing) return existing.code;

    for (let attempt = 0; attempt < 8; attempt++) {
      const code = makeCode(wallet);
      try {
        await this.db.insert(referralCodes).values({ net, wallet, code });
        return code;
      } catch {
        /* unique collision — retry */
      }
    }
    throw new Error('referral_code_alloc_failed');
  }

  /** Bind referee → referrer once. Returns false if already bound / invalid. */
  async attach(
    net: Net,
    referee: string,
    code: string,
  ): Promise<{ ok: true; referrer: string } | { ok: false; error: string }> {
    const normalised = code.trim().toUpperCase();
    if (!normalised) return { ok: false, error: 'invalid_code' };

    const [row] = await this.db
      .select()
      .from(referralCodes)
      .where(and(eq(referralCodes.net, net), eq(referralCodes.code, normalised)))
      .limit(1);
    if (!row) return { ok: false, error: 'unknown_code' };
    if (row.wallet === referee) return { ok: false, error: 'cannot_refer_self' };

    // Block cycles: referee must not already be an ancestor of the referrer.
    const ancestorsOfReferrer = await this.ancestors(net, row.wallet, 8);
    if (ancestorsOfReferrer.includes(referee)) return { ok: false, error: 'cycle' };

    try {
      await this.db.insert(referrals).values({
        net,
        referee,
        referrer: row.wallet,
        code: normalised,
      });
    } catch {
      return { ok: false, error: 'already_referred' };
    }
    return { ok: true, referrer: row.wallet };
  }

  /** Walk up to `depth` ancestors (index 0 = direct referrer). */
  async ancestors(net: Net, wallet: string, depth = 3): Promise<string[]> {
    const out: string[] = [];
    let cur = wallet;
    for (let i = 0; i < depth; i++) {
      const [edge] = await this.db
        .select({ referrer: referrals.referrer })
        .from(referrals)
        .where(and(eq(referrals.net, net), eq(referrals.referee, cur)))
        .limit(1);
      if (!edge) break;
      out.push(edge.referrer);
      cur = edge.referrer;
    }
    return out;
  }

  /** Pending / lifetime per tier, always three rows, zero-filled. */
  async tiers(net: Net, wallet: string): Promise<ReferralTierSnapshot[]> {
    const rows = await this.db
      .select()
      .from(referralFeeTierBalances)
      .where(and(eq(referralFeeTierBalances.net, net), eq(referralFeeTierBalances.wallet, wallet)));
    return REFERRAL_FEE_RATES.map((rate, i) => {
      const tier = (i + 1) as ReferralTier;
      const row = rows.find((r) => r.tier === tier);
      return {
        tier,
        rate,
        pendingNative: row?.pendingNative ?? 0,
        lifetimeNative: row?.lifetimeNative ?? 0,
        fills: row?.fills ?? 0,
      };
    });
  }

  /** The wallet's claim history, newest first. */
  async payouts(net: Net, wallet: string, limit = 20): Promise<ReferralPayoutRow[]> {
    const rows = await this.db
      .select()
      .from(referralPayouts)
      .where(and(eq(referralPayouts.net, net), eq(referralPayouts.wallet, wallet)))
      .orderBy(desc(referralPayouts.requestedAt), desc(referralPayouts.id))
      .limit(limit);
    return rows.map((r) => this.payoutRow(r));
  }

  private payoutRow(r: typeof referralPayouts.$inferSelect): ReferralPayoutRow {
    return {
      id: r.id,
      net: r.net as Net,
      wallet: r.wallet,
      amountNative: r.amountNative,
      mode: r.mode as ReferralPayoutMode,
      status: r.status as ReferralPayoutRow['status'],
      tiers: r.tiers,
      stonkz: r.stonkz,
      txSig: r.txSig,
      requestedAt: r.requestedAt.getTime(),
      settledAt: r.settledAt ? r.settledAt.getTime() : null,
    };
  }

  async snapshot(net: Net, wallet: string) {
    const code = await this.ensureCode(net, wallet);
    const [bal] = await this.db
      .select()
      .from(referralFeeBalances)
      .where(and(eq(referralFeeBalances.net, net), eq(referralFeeBalances.wallet, wallet)))
      .limit(1);
    const [mine] = await this.db
      .select()
      .from(referrals)
      .where(and(eq(referrals.net, net), eq(referrals.referee, wallet)))
      .limit(1);
    const directCount = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(referrals)
      .where(and(eq(referrals.net, net), eq(referrals.referrer, wallet)));
    const [tiers, payouts] = await Promise.all([
      this.tiers(net, wallet),
      this.payouts(net, wallet),
    ]);
    const requestedNative = payouts
      .filter((p) => p.mode === 'native' && p.status === 'requested')
      .reduce((s, p) => s + p.amountNative, 0);
    const paidNative = payouts
      .filter((p) => p.mode === 'native' && p.status === 'paid')
      .reduce((s, p) => s + p.amountNative, 0);

    return {
      code,
      rates: [...REFERRAL_FEE_RATES],
      spKickbackRate: 0.05,
      referredBy: mine?.referrer ?? null,
      directReferrals: directCount[0]?.n ?? 0,
      pendingNative: bal?.pendingNative ?? 0,
      lifetimeNative: bal?.lifetimeNative ?? 0,
      tiers,
      /** Native payouts requested and not yet settled by the treasury signer. */
      requestedNative,
      /** Native payouts settled on chain. */
      paidNative,
      payouts,
    };
  }

  /**
   * Credit T1–T3 fee shares for a curve fill. Returns total native paid out
   * (to subtract from the protocol vault credit).
   */
  async creditFeesFromFill(input: {
    net: Net;
    trader: string;
    feeAmount: number;
    protocolLeg: number;
    txSig: string;
  }): Promise<number> {
    const { net, trader, feeAmount, protocolLeg, txSig } = input;
    if (!(feeAmount > 0) || !(protocolLeg > 0)) return 0;

    const chain = await this.ancestors(net, trader, 3);
    const payouts = referralFeePayouts(feeAmount, protocolLeg, chain.length);
    let total = 0;
    const nowDate = new Date(this.now());

    for (let i = 0; i < payouts.length; i++) {
      const payout = payouts[i]!;
      const earner = chain[i]!;
      if (!(payout.amount > 0)) continue;

      const inserted = await this.db
        .insert(referralFeeEvents)
        .values({
          net,
          earner,
          sourceTrader: trader,
          tier: payout.tier,
          txSig,
          feeAmount,
          payoutNative: payout.amount,
        })
        .onConflictDoNothing()
        .returning({ id: referralFeeEvents.id });
      // Already credited (replay): the cut still came off the protocol leg.
      total += payout.amount;
      if (inserted.length === 0) continue;

      await this.db
        .insert(referralFeeBalances)
        .values({
          net,
          wallet: earner,
          pendingNative: payout.amount,
          lifetimeNative: payout.amount,
          updatedAt: nowDate,
        })
        .onConflictDoUpdate({
          target: [referralFeeBalances.net, referralFeeBalances.wallet],
          set: {
            pendingNative: sql`${referralFeeBalances.pendingNative} + ${payout.amount}`,
            lifetimeNative: sql`${referralFeeBalances.lifetimeNative} + ${payout.amount}`,
            updatedAt: nowDate,
          },
        });
      await this.db
        .insert(referralFeeTierBalances)
        .values({
          net,
          wallet: earner,
          tier: payout.tier,
          pendingNative: payout.amount,
          lifetimeNative: payout.amount,
          fills: 1,
          updatedAt: nowDate,
        })
        .onConflictDoUpdate({
          target: [
            referralFeeTierBalances.net,
            referralFeeTierBalances.wallet,
            referralFeeTierBalances.tier,
          ],
          set: {
            pendingNative: sql`${referralFeeTierBalances.pendingNative} + ${payout.amount}`,
            lifetimeNative: sql`${referralFeeTierBalances.lifetimeNative} + ${payout.amount}`,
            fills: sql`${referralFeeTierBalances.fills} + 1`,
            updatedAt: nowDate,
          },
        });
    }
    return total;
  }

  /** Look up trader for a FeeAccrued tx and credit referral fee shares. */
  async creditFeesForTx(
    net: Net,
    txSig: string,
    feeAmount: number,
    protocolLeg: number,
  ): Promise<number> {
    const [trade] = await this.db
      .select({ trader: trades.trader })
      .from(trades)
      .where(and(eq(trades.net, net), eq(trades.txSig, txSig)))
      .limit(1);
    if (!trade) return 0;
    return this.creditFeesFromFill({
      net,
      trader: trade.trader,
      feeAmount,
      protocolLeg,
      txSig,
    });
  }

  /**
   * 5% SP kickback to the direct referrer. Uses a distinct reason so it does
   * not recurse through the after-SP hook.
   */
  async kickbackSp(net: Net, referee: string, spAwarded: number, refId: string): Promise<void> {
    const amount = referralSpKickback(spAwarded);
    if (amount <= 0) return;
    const [edge] = await this.db
      .select({ referrer: referrals.referrer })
      .from(referrals)
      .where(and(eq(referrals.net, net), eq(referrals.referee, referee)))
      .limit(1);
    if (!edge) return;

    await this.ledger.creditSpOnly(
      net,
      edge.referrer,
      amount,
      REASONS.referralSp,
      `refsp:${refId}`,
      { referee, sourceSp: spAwarded },
    );
  }

  /**
   * Claim every pending referral commission.
   *
   * `stonkz`: converted to `$STONKZ` reward credits at
   * `REFERRAL_STONKZ_PER_NATIVE`, settled immediately.
   * `native`: a payout request for the native/base amount, settled later from
   * the on-chain protocol vault by the treasury signer (see `referral_payouts`).
   *
   * The drain is one transaction: the balance row is locked, the tier rows
   * are zeroed by the same amounts, and the payout row records the split. A
   * credit landing concurrently is not visible to the locked read and stays
   * pending — nothing is lost and nothing is claimed twice.
   */
  async claimFees(
    net: Net,
    wallet: string,
    mode: ReferralPayoutMode = 'stonkz',
  ): Promise<ReferralClaimResult> {
    const nowDate = new Date(this.now());
    const nothing = async (): Promise<ReferralClaimResult> => {
      const bal = await this.ledger.readBalance(net, wallet);
      return {
        mode,
        claimedNative: 0,
        stonkz: 0,
        stonkzTotal: bal.stonkz,
        payoutId: null,
        tiers: {},
      };
    };

    const drained = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(referralFeeBalances)
        .where(and(eq(referralFeeBalances.net, net), eq(referralFeeBalances.wallet, wallet)))
        .for('update');
      const pending = row?.pendingNative ?? 0;
      if (!(pending > 0)) return null;

      const tierRows = await tx
        .select()
        .from(referralFeeTierBalances)
        .where(
          and(eq(referralFeeTierBalances.net, net), eq(referralFeeTierBalances.wallet, wallet)),
        )
        .for('update');
      const tiers: Record<string, number> = {};
      for (const t of tierRows) if (t.pendingNative > 0) tiers[String(t.tier)] = t.pendingNative;

      await tx
        .update(referralFeeBalances)
        .set({ pendingNative: 0, updatedAt: nowDate })
        .where(and(eq(referralFeeBalances.net, net), eq(referralFeeBalances.wallet, wallet)));
      await tx
        .update(referralFeeTierBalances)
        .set({ pendingNative: 0, updatedAt: nowDate })
        .where(
          and(eq(referralFeeTierBalances.net, net), eq(referralFeeTierBalances.wallet, wallet)),
        );

      const stonkz =
        mode === 'stonkz' ? Math.max(1, Math.floor(pending * REFERRAL_STONKZ_PER_NATIVE)) : null;
      const [payout] = await tx
        .insert(referralPayouts)
        .values({
          net,
          wallet,
          amountNative: pending,
          mode,
          status: mode === 'stonkz' ? 'paid' : 'requested',
          tiers,
          stonkz,
          requestedAt: nowDate,
          settledAt: mode === 'stonkz' ? nowDate : null,
        })
        .returning({ id: referralPayouts.id });
      return { pending, tiers, stonkz: stonkz ?? 0, payoutId: payout?.id ?? null };
    });

    if (!drained) return nothing();

    if (mode === 'native') {
      const bal = await this.ledger.readBalance(net, wallet);
      return {
        mode,
        claimedNative: drained.pending,
        stonkz: 0,
        stonkzTotal: bal.stonkz,
        payoutId: drained.payoutId,
        tiers: drained.tiers,
      };
    }

    const refId = `refclaim:${net}:${wallet}:${drained.payoutId ?? Math.floor(drained.pending * 1e9)}:${nowDate.getTime()}`;
    const stonkzTotal = await this.ledger.creditStonkz(
      net,
      wallet,
      drained.stonkz,
      'referral_fee_claim',
      refId,
      'referral_claim',
    );
    return {
      mode,
      claimedNative: drained.pending,
      stonkz: drained.stonkz,
      stonkzTotal,
      payoutId: drained.payoutId,
      tiers: drained.tiers,
    };
  }

  /* ------------------------------------------------------------ operator */

  /** Native payout requests awaiting the treasury signer, oldest first. */
  async listPayoutRequests(net?: Net): Promise<ReferralPayoutRow[]> {
    const where = net
      ? and(
          eq(referralPayouts.mode, 'native'),
          eq(referralPayouts.status, 'requested'),
          eq(referralPayouts.net, net),
        )
      : and(eq(referralPayouts.mode, 'native'), eq(referralPayouts.status, 'requested'));
    const rows = await this.db
      .select()
      .from(referralPayouts)
      .where(where)
      .orderBy(referralPayouts.requestedAt, referralPayouts.id);
    return rows.map((r) => this.payoutRow(r));
  }

  /** Marks native requests settled by one on-chain withdrawal. Returns the rows it changed. */
  async markPayoutsPaid(ids: number[], txSig: string, note?: string): Promise<number> {
    if (ids.length === 0) return 0;
    const updated = await this.db
      .update(referralPayouts)
      .set({ status: 'paid', txSig, settledAt: new Date(this.now()), ...(note ? { note } : {}) })
      .where(
        and(
          inArray(referralPayouts.id, ids),
          eq(referralPayouts.mode, 'native'),
          eq(referralPayouts.status, 'requested'),
        ),
      )
      .returning({ id: referralPayouts.id });
    return updated.length;
  }

  /** Cancels a native request and returns its amount to the pending balance. */
  async voidPayoutRequest(id: number, note: string): Promise<boolean> {
    const nowDate = new Date(this.now());
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(referralPayouts)
        .where(eq(referralPayouts.id, id))
        .for('update');
      if (!row || row.mode !== 'native' || row.status !== 'requested') return false;
      await tx
        .update(referralPayouts)
        .set({ status: 'void', note, settledAt: nowDate })
        .where(eq(referralPayouts.id, id));
      await tx
        .update(referralFeeBalances)
        .set({
          pendingNative: sql`${referralFeeBalances.pendingNative} + ${row.amountNative}`,
          updatedAt: nowDate,
        })
        .where(
          and(eq(referralFeeBalances.net, row.net), eq(referralFeeBalances.wallet, row.wallet)),
        );
      for (const [tier, amount] of Object.entries(row.tiers)) {
        await tx
          .update(referralFeeTierBalances)
          .set({
            pendingNative: sql`${referralFeeTierBalances.pendingNative} + ${amount}`,
            updatedAt: nowDate,
          })
          .where(
            and(
              eq(referralFeeTierBalances.net, row.net),
              eq(referralFeeTierBalances.wallet, row.wallet),
              eq(referralFeeTierBalances.tier, Number(tier)),
            ),
          );
      }
      return true;
    });
  }
}
