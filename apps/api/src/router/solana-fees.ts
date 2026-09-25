import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
} from '@solana/web3.js';

/**
 * Priority fee + optional Jito tip for Solana trade (and similar) txs.
 *
 * `prioSol` / `mevTipSol` are whole-SOL amounts from user settings. We convert
 * the priority budget into a compute-unit price and, when MEV protection is
 * on, tip a rotating Jito tip account so the bundle path can land.
 *
 * Jupiter routes often already include their own compute-budget ixs — callers
 * pass `skipComputeBudget: true` in that case so we only append the tip.
 */

/** Mainnet tip accounts published by Jito. Harmless no-ops on unlocked-devnet. */
export const JITO_TIP_ACCOUNTS = [
  'HFqU5x63VTqvQss8hp11i4bVmkvbwo26uwjqkC2bJb9L',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6E8dfdzPVLmSqUkDN51c5JU',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
  'HFqU5x63VTqvQss8hp11i4wFNkf5WfNZArfE85Rgs8k',
] as const;

const DEFAULT_CU_LIMIT = 400_000;

export interface SolanaFeeOpts {
  /** Priority fee budget in whole SOL (settings `prio`). */
  prioSol: number;
  /** When true, also tip `mevTipSol` to a Jito tip account. */
  mevOn: boolean;
  /** MEV tip in whole SOL (settings `mevTip`). */
  mevTipSol: number;
  /** Trader pubkey that pays the tip. */
  payer: PublicKey;
  /**
   * Skip ComputeBudget ixs when Jupiter (or another hop) already supplied them.
   * Tip still applies.
   */
  skipComputeBudget?: boolean;
}

function lamports(sol: number): number {
  if (!Number.isFinite(sol) || sol <= 0) return 0;
  return Math.min(Math.floor(sol * 1e9), Number.MAX_SAFE_INTEGER);
}

/** Deterministic tip account pick from the trader pubkey. */
export function pickJitoTipAccount(payer: PublicKey): PublicKey {
  const b = payer.toBytes();
  const idx = b[0]! % JITO_TIP_ACCOUNTS.length;
  return new PublicKey(JITO_TIP_ACCOUNTS[idx]!);
}

/**
 * Convert a SOL priority budget into micro-lamports per compute unit,
 * assuming ~DEFAULT_CU_LIMIT CU for a curve (+ optional hop) trade.
 */
export function microLamportsFromPrioSol(prioSol: number, cuLimit = DEFAULT_CU_LIMIT): number {
  const lam = lamports(prioSol);
  if (lam <= 0) return 0;
  // microLamports = lamports * 1e6 / cuLimit
  return Math.max(1, Math.floor((lam * 1_000_000) / cuLimit));
}

/** Prefixed onto the trade transaction before ATA / hop / curve ixs. */
export function buildSolanaFeeInstructions(opts: SolanaFeeOpts): TransactionInstruction[] {
  const out: TransactionInstruction[] = [];
  if (!opts.skipComputeBudget) {
    const micro = microLamportsFromPrioSol(opts.prioSol);
    out.push(ComputeBudgetProgram.setComputeUnitLimit({ units: DEFAULT_CU_LIMIT }));
    if (micro > 0) {
      out.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: micro }));
    }
  }
  if (opts.mevOn) {
    const tipLamports = lamports(opts.mevTipSol);
    if (tipLamports > 0) {
      out.push(
        SystemProgram.transfer({
          fromPubkey: opts.payer,
          toPubkey: pickJitoTipAccount(opts.payer),
          lamports: tipLamports,
        }),
      );
    }
  }
  return out;
}
