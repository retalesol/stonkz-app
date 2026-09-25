import { createHash, randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  REFERRAL_FEE_RATES,
  REFERRAL_OPTIONZ_PER_NATIVE,
  referralFeePayouts,
  referralSpKickback,
  type Net,
} from '@stonkz/shared';
import type { Db } from '../db/client.js';
import {
  referralCodes,
  referralFeeBalances,
  referralFeeEvents,
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

function makeCode(wallet: string): string {
  const salt = randomBytes(3).toString('hex');
  const digest = createHash('sha256').update(`${wallet}:${salt}`).digest('hex');
  return digest.slice(0, 8).toUpperCase();
}

/**
 * Referral graph + fee/SP kickbacks.
 *
 * - Fee shares: 15% / 10% / 5% of the referred trader's curve feeAmount for
 *   T1 / T2 / T3, funded from the protocol leg (scaled if needed).
 * - SP kickback: 5% of SP a **direct** referee earns (no recursion).
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

    return {
      code,
      rates: [...REFERRAL_FEE_RATES],
      spKickbackRate: 0.05,
      referredBy: mine?.referrer ?? null,
      directReferrals: directCount[0]?.n ?? 0,
      pendingNative: bal?.pendingNative ?? 0,
      lifetimeNative: bal?.lifetimeNative ?? 0,
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
      total += payout.amount;
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
   * Claim all pending referral fee native as Stonk Optionz.
   * Returns 0 optionz when nothing is pending.
   */
  async claimFees(
    net: Net,
    wallet: string,
  ): Promise<{ claimedNative: number; optionz: number; optionzTotal: number }> {
    const [row] = await this.db
      .select()
      .from(referralFeeBalances)
      .where(and(eq(referralFeeBalances.net, net), eq(referralFeeBalances.wallet, wallet)))
      .limit(1);
    const pending = row?.pendingNative ?? 0;
    if (!(pending > 0)) {
      const bal = await this.ledger.readBalance(net, wallet);
      return { claimedNative: 0, optionz: 0, optionzTotal: bal.optionz };
    }

    const nowDate = new Date(this.now());
    // Optimistic drain: only clear if the balance is still exactly what we read.
    const drained = await this.db
      .update(referralFeeBalances)
      .set({ pendingNative: 0, updatedAt: nowDate })
      .where(
        and(
          eq(referralFeeBalances.net, net),
          eq(referralFeeBalances.wallet, wallet),
          sql`${referralFeeBalances.pendingNative} = ${pending}`,
        ),
      )
      .returning({ wallet: referralFeeBalances.wallet });

    if (drained.length === 0) {
      const bal = await this.ledger.readBalance(net, wallet);
      return { claimedNative: 0, optionz: 0, optionzTotal: bal.optionz };
    }

    const optionz = Math.max(1, Math.floor(pending * REFERRAL_OPTIONZ_PER_NATIVE));
    const refId = `refclaim:${net}:${wallet}:${Math.floor(pending * 1e9)}:${nowDate.getTime()}`;
    const optionzTotal = await this.ledger.creditOptionz(
      net,
      wallet,
      optionz,
      'referral_fee_claim',
      refId,
    );
    return { claimedNative: pending, optionz, optionzTotal };
  }
}
