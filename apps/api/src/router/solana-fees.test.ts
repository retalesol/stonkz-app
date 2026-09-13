import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  JITO_TIP_ACCOUNTS,
  buildSolanaFeeInstructions,
  microLamportsFromPrioSol,
  pickJitoTipAccount,
} from './solana-fees.js';

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
});

describe('buildSolanaFeeInstructions', () => {
  const payer = new PublicKey('11111111111111111111111111111112');

  it('emits compute budget + tip when MEV is on', () => {
    const ixs = buildSolanaFeeInstructions({
      prioSol: 0.0012,
      mevOn: true,
      mevTipSol: 0.0009,
      payer,
    });
    // CU limit + CU price + tip
    expect(ixs.length).toBe(3);
  });

  it('skips compute budget when Jupiter already supplied them', () => {
    const ixs = buildSolanaFeeInstructions({
      prioSol: 0.0012,
      mevOn: true,
      mevTipSol: 0.0009,
      payer,
      skipComputeBudget: true,
    });
    expect(ixs.length).toBe(1);
  });

  it('omits tip when MEV is off', () => {
    const ixs = buildSolanaFeeInstructions({
      prioSol: 0.0012,
      mevOn: false,
      mevTipSol: 0.0009,
      payer,
    });
    expect(ixs.length).toBe(2);
  });
});

describe('pickJitoTipAccount', () => {
  it('returns a known tip account', () => {
    const tip = pickJitoTipAccount(new PublicKey('11111111111111111111111111111112'));
    expect(JITO_TIP_ACCOUNTS).toContain(tip.toBase58());
  });
});
