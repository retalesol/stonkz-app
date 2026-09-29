import { ComputeBudgetProgram, PublicKey, SystemProgram } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  CURVE_LEG_CU,
  DEFAULT_CU_LIMIT,
  JITO_TIP_ACCOUNTS,
  MAX_TRANSACTION_CU,
  buildSolanaFeeInstructions,
  isSetComputeUnitLimit,
  isSetComputeUnitPrice,
  microLamportsFromPrioSol,
  pickJitoTipAccount,
  planSolanaFees,
  splitJupiterComputeBudget,
  tradeComputeUnitLimit,
} from './solana-fees.js';

/**
 * `getTipAccounts` from `https://mainnet.block-engine.jito.wtf/api/v1/bundles`
 * on 2026-09-29. A tip to a key outside this set is money lost, so the list
 * in the module is pinned to it here (order-insensitive: Jito rotates the
 * order it returns).
 */
const JITO_GET_TIP_ACCOUNTS_SNAPSHOT = [
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
];

describe('JITO_TIP_ACCOUNTS', () => {
  it('matches the block engine’s own getTipAccounts list exactly', () => {
    expect([...JITO_TIP_ACCOUNTS].sort()).toEqual([...JITO_GET_TIP_ACCOUNTS_SNAPSHOT].sort());
    for (const a of JITO_TIP_ACCOUNTS) expect(new PublicKey(a).toBase58()).toBe(a);
  });
});

describe('microLamportsFromPrioSol', () => {
  it('returns 0 for empty budgets', () => {
    expect(microLamportsFromPrioSol(0)).toBe(0);
    expect(microLamportsFromPrioSol(-1)).toBe(0);
  });

  it('scales with the SOL priority budget', () => {
    const low = microLamportsFromPrioSol(0.0005);
    const high = microLamportsFromPrioSol(0.004);
    expect(low).toBeGreaterThan(0);
    expect(high).toBeGreaterThan(low);
  });

  it('is a total budget: a bigger CU limit lowers the per-unit price', () => {
    const at400k = microLamportsFromPrioSol(0.0012, 400_000);
    const at800k = microLamportsFromPrioSol(0.0012, 800_000);
    expect(at800k).toBe(Math.floor(at400k / 2));
    // 0.0012 SOL = 1_200_000 lamports over 400k CU = 3 lamports/CU = 3e6 µlamports.
    expect(at400k).toBe(3_000_000);
  });
});

describe('tradeComputeUnitLimit', () => {
  it('uses the default with no aggregator, and Jupiter’s estimate plus the curve leg with one', () => {
    expect(tradeComputeUnitLimit(null)).toBe(DEFAULT_CU_LIMIT);
    expect(tradeComputeUnitLimit(undefined)).toBe(DEFAULT_CU_LIMIT);
    expect(tradeComputeUnitLimit(300_000)).toBe(300_000 + CURVE_LEG_CU);
    expect(tradeComputeUnitLimit(100_000)).toBe(DEFAULT_CU_LIMIT);
    expect(tradeComputeUnitLimit(2_000_000)).toBe(MAX_TRANSACTION_CU);
  });
});

describe('splitJupiterComputeBudget', () => {
  it('lifts the unit limit out, drops the price, keeps anything else', () => {
    const other = ComputeBudgetProgram.setComputeUnitLimit({ units: 1 });
    other.data = Buffer.from([4, 0, 0, 0, 0]); // SetLoadedAccountsDataSizeLimit
    const split = splitJupiterComputeBudget([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 12_345 }),
      other,
    ]);
    expect(split.units).toBe(250_000);
    expect(split.other).toEqual([other]);
  });

  it('reports null units when Jupiter sent no limit', () => {
    expect(splitJupiterComputeBudget([])).toEqual({ units: null, other: [] });
  });
});

describe('planSolanaFees', () => {
  const payer = new PublicKey('11111111111111111111111111111112');

  it('emits one CU limit, one CU price and a tip when MEV is on', () => {
    const plan = planSolanaFees({ prioSol: 0.0012, mevOn: true, mevTipSol: 0.0009, payer });
    expect(plan.instructions).toHaveLength(3);
    expect(plan.instructions.filter(isSetComputeUnitLimit)).toHaveLength(1);
    expect(plan.instructions.filter(isSetComputeUnitPrice)).toHaveLength(1);
    expect(plan.computeUnitLimit).toBe(DEFAULT_CU_LIMIT);
    expect(plan.computeUnitPriceMicroLamports).toBe(3_000_000);
    expect(plan.tipLamports).toBe(900_000);
    const tip = plan.instructions[2]!;
    expect(tip.programId.equals(SystemProgram.programId)).toBe(true);
    expect(tip.keys[1]!.pubkey.toBase58()).toBe(plan.tipAccount);
    expect(JITO_TIP_ACCOUNTS).toContain(plan.tipAccount);
  });

  it('merges Jupiter’s budget: its limit is folded in, its price replaced by the user’s prio', () => {
    const jupiterBudget = splitJupiterComputeBudget([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 12_345 }),
    ]);
    const plan = planSolanaFees({
      prioSol: 0.0012,
      mevOn: false,
      mevTipSol: 0,
      payer,
      jupiterBudget,
    });
    const limits = plan.instructions.filter(isSetComputeUnitLimit);
    const prices = plan.instructions.filter(isSetComputeUnitPrice);
    expect(limits).toHaveLength(1);
    expect(prices).toHaveLength(1);
    expect(limits[0]!.data.readUInt32LE(1)).toBe(300_000 + CURVE_LEG_CU);
    expect(plan.computeUnitLimit).toBe(500_000);
    // 1_200_000 lamports over 500k CU = 2.4 lamports/CU.
    expect(Number(prices[0]!.data.readBigUInt64LE(1))).toBe(2_400_000);
    expect(plan.computeUnitPriceMicroLamports).toBe(2_400_000);
  });

  it('writes no price at prio 0 — Jupiter’s own price is not resurrected', () => {
    const jupiterBudget = splitJupiterComputeBudget([
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 12_345 }),
    ]);
    const plan = planSolanaFees({ prioSol: 0, mevOn: false, mevTipSol: 0, payer, jupiterBudget });
    expect(plan.instructions.filter(isSetComputeUnitPrice)).toHaveLength(0);
    expect(plan.computeUnitPriceMicroLamports).toBe(0);
  });

  it('omits the tip when MEV is off or the tip is zero', () => {
    expect(
      buildSolanaFeeInstructions({ prioSol: 0.0012, mevOn: false, mevTipSol: 0.0009, payer }),
    ).toHaveLength(2);
    const zero = planSolanaFees({ prioSol: 0.0012, mevOn: true, mevTipSol: 0, payer });
    expect(zero.instructions).toHaveLength(2);
    expect(zero.tipAccount).toBeNull();
  });
});

describe('pickJitoTipAccount', () => {
  it('returns a known tip account, deterministically per payer', () => {
    const payer = new PublicKey('11111111111111111111111111111112');
    const tip = pickJitoTipAccount(payer);
    expect(JITO_TIP_ACCOUNTS).toContain(tip.toBase58());
    expect(pickJitoTipAccount(payer).equals(tip)).toBe(true);
  });
});
