import { describe, expect, it } from 'vitest';
import {
  REFERRAL_FEE_RATES,
  REFERRAL_SP_KICKBACK,
  referralFeePayouts,
  referralSpKickback,
} from '../src/referrals.js';

describe('referralFeePayouts', () => {
  it('pins the 15 / 10 / 5 rates', () => {
    expect(REFERRAL_FEE_RATES).toEqual([0.15, 0.1, 0.05]);
    expect(REFERRAL_SP_KICKBACK).toBe(0.05);
  });

  it('pays T1 from feeAmount within the protocol leg', () => {
    // 1 SOL fee → protocol 0.2; T1 wants 0.15 — fits.
    const [t1] = referralFeePayouts(1, 0.2, 1);
    expect(t1).toMatchObject({ tier: 1, rate: 0.15, amount: 0.15 });
  });

  it('scales T1–T3 down when they would exceed the protocol leg', () => {
    // 1 SOL fee → raw 0.15+0.10+0.05 = 0.30 > protocol 0.20 → scale 2/3.
    const payouts = referralFeePayouts(1, 0.2, 3);
    expect(payouts).toHaveLength(3);
    const sum = payouts.reduce((s, p) => s + p.amount, 0);
    expect(sum).toBeCloseTo(0.2, 10);
    expect(payouts[0]!.amount).toBeCloseTo(0.1, 10); // 0.15 * (0.2/0.3)
  });

  it('returns nothing without ancestors or fees', () => {
    expect(referralFeePayouts(1, 0.2, 0)).toEqual([]);
    expect(referralFeePayouts(0, 0.2, 1)).toEqual([]);
  });
});

describe('referralSpKickback', () => {
  it('floors 5% of referee SP', () => {
    expect(referralSpKickback(100)).toBe(5);
    expect(referralSpKickback(19)).toBe(0);
    expect(referralSpKickback(0)).toBe(0);
  });
});
