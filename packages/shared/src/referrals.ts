/**
 * Referral fee + SP kickback rates.
 *
 * Fee shares are taken from the **protocol** leg of each curve fill (20% of
 * the curve fee), never from the creator bucket. If T1+T2+T3 would exceed the
 * protocol leg, payouts scale down proportionally so the vault never goes
 * negative.
 *
 * SP kickback is **direct (T1) only**: 5% of SP the referee just earned.
 */

/** T1 / T2 / T3 share of the referred trader's curve `feeAmount`. */
export const REFERRAL_FEE_RATES = [0.15, 0.1, 0.05] as const;

/** Fraction of a direct referee's SP award that kicks back to the referrer. */
export const REFERRAL_SP_KICKBACK = 0.05;

/**
 * Pending referral fee native → Stonk Optionz when claimed.
 * 1 SOL of accrued affiliate fees → 10,000 Optionz (claimable off-chain until
 * a native withdraw vault ships).
 */
export const REFERRAL_OPTIONZ_PER_NATIVE = 10_000;

export type ReferralTier = 1 | 2 | 3;

export interface ReferralFeePayout {
  tier: ReferralTier;
  rate: number;
  /** Native units of the curve fee allocated to this referrer before scaling. */
  raw: number;
  /** Native units after scaling to fit inside the protocol leg. */
  amount: number;
}

/**
 * Compute T1–T3 fee payouts for a fill. `ancestors[0]` is the direct referrer.
 * Amounts are scaled so `sum(amount) <= protocolLeg`.
 */
export function referralFeePayouts(
  feeAmount: number,
  protocolLeg: number,
  ancestorCount: number,
): ReferralFeePayout[] {
  if (!(feeAmount > 0) || !(protocolLeg > 0) || ancestorCount <= 0) return [];
  const n = Math.min(3, ancestorCount);
  const raw: ReferralFeePayout[] = [];
  let sumRaw = 0;
  for (let i = 0; i < n; i++) {
    const rate = REFERRAL_FEE_RATES[i]!;
    const r = feeAmount * rate;
    sumRaw += r;
    raw.push({ tier: (i + 1) as ReferralTier, rate, raw: r, amount: r });
  }
  if (sumRaw <= protocolLeg) return raw;
  const scale = protocolLeg / sumRaw;
  return raw.map((p) => ({ ...p, amount: p.raw * scale }));
}

/** Whole SP units kicked back from a direct referee's SP award. */
export function referralSpKickback(refereeSpAwarded: number): number {
  if (!(refereeSpAwarded > 0)) return 0;
  return Math.floor(refereeSpAwarded * REFERRAL_SP_KICKBACK);
}
