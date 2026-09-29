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
 * Jupiter routes carry their own compute-budget ixs. Those are *merged*, not
 * kept: the caller passes `jupiterBudget` (see `splitJupiterComputeBudget`)
 * and this module emits exactly one `SetComputeUnitLimit` sized for the whole
 * transaction and exactly one `SetComputeUnitPrice` derived from the user's
 * own `prio` — Jupiter's price is dropped, otherwise the setting would be
 * silently ignored on every aggregator route (a transaction with two price
 * instructions is rejected by the runtime anyway).
 */

/**
 * Mainnet tip accounts as the Jito block engine itself reports them
 * (`getTipAccounts` on `mainnet.block-engine.jito.wtf`, 2026-09-29). Three
 * entries of the previous list were not in that set — a tip sent to a
 * mistyped key is simply lost — so this list is asserted against a
 * checked-in snapshot in `solana-fees.test.ts`. Harmless no-ops on devnet.
 */
export const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
] as const;

/** Jito refuses a tip below this (`sendTransaction` "minimum tip" rule). */
export const MIN_JITO_TIP_LAMPORTS = 1_000;

/** Budget for the curve leg plus ATA creates / wrap on the direct-pair path. */
export const DEFAULT_CU_LIMIT = 400_000;
/** What the curve leg adds on top of a Jupiter route's own estimate. */
export const CURVE_LEG_CU = 200_000;
/** Per-transaction ceiling enforced by the runtime. */
export const MAX_TRANSACTION_CU = 1_400_000;

/** `ComputeBudgetInstruction` tags. */
const SET_COMPUTE_UNIT_LIMIT_TAG = 2;
const SET_COMPUTE_UNIT_PRICE_TAG = 3;

export interface JupiterComputeBudget {
  /** Jupiter's own `SetComputeUnitLimit` units, `null` when it sent none. */
  units: number | null;
  /** Any other compute-budget ix (e.g. loaded-accounts data size) — kept verbatim. */
  other: TransactionInstruction[];
}

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
   * Jupiter's compute-budget ixs, pre-split. Their unit limit is folded into
   * ours; their price is replaced by the user's `prio`.
   */
  jupiterBudget?: JupiterComputeBudget;
}

export interface SolanaFeePlan {
  instructions: TransactionInstruction[];
  /** The one `SetComputeUnitLimit` this plan writes. */
  computeUnitLimit: number;
  /** Micro-lamports per CU; 0 means no `SetComputeUnitPrice` was written. */
  computeUnitPriceMicroLamports: number;
  /** Lamports the tip transfer moves; 0 when no tip instruction was written. */
  tipLamports: number;
  /** Tip recipient when `tipLamports > 0`. */
  tipAccount: string | null;
}

export function lamportsFromSol(sol: number): number {
  if (!Number.isFinite(sol) || sol <= 0) return 0;
  return Math.min(Math.floor(sol * 1e9), Number.MAX_SAFE_INTEGER);
}

export function isSetComputeUnitLimit(ix: TransactionInstruction): boolean {
  return (
    ix.programId.equals(ComputeBudgetProgram.programId) &&
    ix.data.length >= 5 &&
    ix.data[0] === SET_COMPUTE_UNIT_LIMIT_TAG
  );
}

export function isSetComputeUnitPrice(ix: TransactionInstruction): boolean {
  return (
    ix.programId.equals(ComputeBudgetProgram.programId) &&
    ix.data.length >= 9 &&
    ix.data[0] === SET_COMPUTE_UNIT_PRICE_TAG
  );
}

/**
 * Splits an aggregator's compute-budget ixs into the unit limit (returned as
 * a number so it can be folded into the whole-transaction limit), the price
 * (dropped — the user's setting wins) and anything else (kept).
 */
export function splitJupiterComputeBudget(
  ixs: readonly TransactionInstruction[],
): JupiterComputeBudget {
  let units: number | null = null;
  const other: TransactionInstruction[] = [];
  for (const ix of ixs) {
    if (isSetComputeUnitLimit(ix)) units = (units ?? 0) + ix.data.readUInt32LE(1);
    else if (isSetComputeUnitPrice(ix)) continue;
    else other.push(ix);
  }
  return { units, other };
}

/** Deterministic tip account pick from the trader pubkey. */
export function pickJitoTipAccount(payer: PublicKey): PublicKey {
  const b = payer.toBytes();
  const idx = b[0]! % JITO_TIP_ACCOUNTS.length;
  return new PublicKey(JITO_TIP_ACCOUNTS[idx]!);
}

/**
 * Convert a SOL priority budget into micro-lamports per compute unit against
 * the transaction's actual CU limit, so `prio` is what the trader pays *in
 * total* if every unit is consumed — not a per-unit number that balloons on a
 * bigger Jupiter route.
 */
export function microLamportsFromPrioSol(prioSol: number, cuLimit = DEFAULT_CU_LIMIT): number {
  const lam = lamportsFromSol(prioSol);
  if (lam <= 0) return 0;
  // microLamports = lamports * 1e6 / cuLimit
  return Math.max(1, Math.floor((lam * 1_000_000) / cuLimit));
}

/** The whole-transaction CU limit: our default, or Jupiter's estimate plus the curve leg. */
export function tradeComputeUnitLimit(jupiterUnits: number | null | undefined): number {
  if (jupiterUnits === null || jupiterUnits === undefined) return DEFAULT_CU_LIMIT;
  return Math.min(MAX_TRANSACTION_CU, Math.max(DEFAULT_CU_LIMIT, jupiterUnits + CURVE_LEG_CU));
}

/** Prefixed onto the trade transaction before ATA / hop / curve ixs. */
export function planSolanaFees(opts: SolanaFeeOpts): SolanaFeePlan {
  const out: TransactionInstruction[] = [];
  const computeUnitLimit = tradeComputeUnitLimit(opts.jupiterBudget?.units);
  const micro = microLamportsFromPrioSol(opts.prioSol, computeUnitLimit);
  out.push(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }));
  if (micro > 0) out.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: micro }));
  if (opts.jupiterBudget) out.push(...opts.jupiterBudget.other);

  let tipLamports = 0;
  let tipAccount: string | null = null;
  if (opts.mevOn) {
    tipLamports = lamportsFromSol(opts.mevTipSol);
    if (tipLamports > 0) {
      const to = pickJitoTipAccount(opts.payer);
      tipAccount = to.toBase58();
      out.push(
        SystemProgram.transfer({ fromPubkey: opts.payer, toPubkey: to, lamports: tipLamports }),
      );
    }
  }
  return {
    instructions: out,
    computeUnitLimit,
    computeUnitPriceMicroLamports: micro,
    tipLamports,
    tipAccount,
  };
}

/** Instruction-only view of `planSolanaFees`, for callers that need nothing else. */
export function buildSolanaFeeInstructions(opts: SolanaFeeOpts): TransactionInstruction[] {
  return planSolanaFees(opts).instructions;
}
