import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AddressLookupTableAccount,
} from '@solana/web3.js';
import {
  NATIVE_MINT,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
} from '@solana/spl-token';
import type { ChainRpc, SolanaBlockhashSource, SolanaTransactionSource } from '../chain/types.js';
import type { JupiterInstruction, JupiterSwapInstructionsResponse } from './jupiter.js';
import { compileSolanaTransaction } from './solana-alt.js';
import { planSolanaFees, splitJupiterComputeBudget } from './solana-fees.js';
import { buildBuyInstruction, buildSellInstruction, traderAtas } from './solana-instructions.js';

/** Mirrors `app/deps.ts`'s `asEthCaller` — narrows a `ChainRpc` to the blockhash capability only the real Solana RPC (and `FakeChainRpc`) implement. */
export function asSolanaBlockhashSource(rpc: ChainRpc): SolanaBlockhashSource | undefined {
  const candidate = rpc as Partial<SolanaBlockhashSource>;
  return typeof candidate.latestBlockhash === 'function'
    ? (candidate as SolanaBlockhashSource)
    : undefined;
}

/** Same narrowing, for `routes/launch.ts`'s confirm-time transaction lookup. */
export function asSolanaTransactionSource(rpc: ChainRpc): SolanaTransactionSource | undefined {
  const candidate = rpc as Partial<SolanaTransactionSource>;
  return typeof candidate.getTransactionMessageBase64 === 'function'
    ? (candidate as SolanaTransactionSource)
    : undefined;
}

/**
 * Composes **one atomic Solana transaction**: Jupiter's swap instruction(s)
 * (hop 1, native \u2194 base, only when the base mint is not native — plan
 * step 86) followed or preceded by the launchpad's `buy`/`sell` instruction
 * (hop 2, the curve). This is the "single atomic tx" plan step 83 asks for on
 * Solana — unlike Robinhood Chain, nothing here needs a periphery contract:
 * Solana transactions are atomic across instructions by construction, and
 * every instruction just names the trader's own token accounts as the
 * intermediate holding spot, so there is no "whose contract holds the base
 * mint mid-flight" problem to solve.
 */

export interface JupiterHop {
  response: JupiterSwapInstructionsResponse;
}

export interface SolanaTradeComposition {
  side: 'buy' | 'sell';
  programId: PublicKey;
  trader: PublicKey;
  mint: PublicKey;
  baseMint: PublicKey;
  /** `amount_base` for a buy, `amount_token` for a sell — the curve instruction's own input. */
  curveAmountIn: bigint;
  /** The curve instruction's own `min_out`. */
  curveMinOut: bigint;
  /** Present when `aggregatorFor(net, baseSymbol)` selected Jupiter; absent on the direct-pair fast path. */
  jupiter?: JupiterHop;
  /** Priority fee budget in whole SOL (settings `prio`). */
  prioSol?: number;
  /** When true and `mevTipSol` > 0, tip a Jito account. */
  mevOn?: boolean;
  /** MEV tip in whole SOL (settings `mevTip`). */
  mevTipSol?: number;
  /**
   * Loaded lookup tables (Jupiter's `addressLookupTableAddresses` plus the
   * operator's `SOLANA_LAUNCH_ALT`). A Jupiter hop always compiles to a v0
   * message against these; the direct-pair path stays legacy unless it
   * would not fit one packet.
   */
  lookupTables?: readonly AddressLookupTableAccount[];
}

/** The fee/tip numbers actually written into the transaction — what the UI confirms against. */
export interface SolanaTradeFees {
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: number;
  /** `computeUnitLimit × price`, the most the priority fee can cost. */
  maxPriorityLamports: number;
  tipLamports: number;
  tipAccount: string | null;
}

export interface ComposedSolanaTransaction {
  /** Base64 of the serialized, *unsigned* transaction message + empty signature slots. */
  base64: string;
  lastValidBlockHeight: number;
  /** `'legacy'` or `0` — the web wallet reads the same thing off the version byte. */
  version: 'legacy' | 0;
  /** Wire size in bytes, at most 1232. */
  bytes: number;
  fees: SolanaTradeFees;
}

function toTransactionInstruction(ix: JupiterInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: Buffer.from(ix.data, 'base64'),
  });
}

/**
 * Jupiter's swap instructions, minus its compute-budget ixs — those are
 * merged into the single budget `planSolanaFees` writes at the front, the
 * same way `solana-launch-tx.ts` folds them into a launch. Jupiter's routes
 * index into its lookup tables; the caller has already read them
 * (`solana-alt.ts`'s `fetchAddressLookupTables`) and passes them as
 * `lookupTables`, so the v0 compile below resolves them.
 */
function jupiterInstructions(hop: JupiterHop): TransactionInstruction[] {
  const r = hop.response;
  const out: TransactionInstruction[] = [];
  if (r.tokenLedgerInstruction) out.push(toTransactionInstruction(r.tokenLedgerInstruction));
  out.push(...r.setupInstructions.map(toTransactionInstruction));
  out.push(toTransactionInstruction(r.swapInstruction));
  if (r.cleanupInstruction) out.push(toTransactionInstruction(r.cleanupInstruction));
  return out;
}

export function composeSolanaTradeTransaction(
  c: SolanaTradeComposition,
  blockhash: { blockhash: string; lastValidBlockHeight: number },
): ComposedSolanaTransaction {
  const ixs: TransactionInstruction[] = [];

  // Priority / tip first so they apply even if a later ix fails simulation
  // after CU accounting. Exactly one CU limit and (when `prio` > 0) one CU
  // price for the whole transaction: Jupiter's own budget ixs are folded in,
  // never appended alongside ours.
  const fees = planSolanaFees({
    prioSol: c.prioSol ?? 0,
    mevOn: !!c.mevOn,
    mevTipSol: c.mevTipSol ?? 0,
    payer: c.trader,
    ...(c.jupiter
      ? {
          jupiterBudget: splitJupiterComputeBudget(
            c.jupiter.response.computeBudgetInstructions.map(toTransactionInstruction),
          ),
        }
      : {}),
  });
  ixs.push(...fees.instructions);

  const atas = traderAtas({
    programId: c.programId,
    mint: c.mint,
    baseMint: c.baseMint,
    trader: c.trader,
  });
  // Idempotent: a no-op if the trader already has either account. Included
  // unconditionally rather than after an extra `getAccountInfo` round trip —
  // one wasted, cheap instruction is preferable to a second RPC hop on the
  // 8-second quote-to-prepare budget.
  ixs.push(
    createAssociatedTokenAccountIdempotentInstruction(c.trader, atas.base, c.trader, c.baseMint),
    createAssociatedTokenAccountIdempotentInstruction(c.trader, atas.token, c.trader, c.mint),
  );

  const curveIx =
    c.side === 'buy'
      ? buildBuyInstruction(
          { programId: c.programId, mint: c.mint, baseMint: c.baseMint, trader: c.trader },
          c.curveAmountIn,
          c.curveMinOut,
        )
      : buildSellInstruction(
          { programId: c.programId, mint: c.mint, baseMint: c.baseMint, trader: c.trader },
          c.curveAmountIn,
          c.curveMinOut,
        );

  // The curve's `base` leg is always an SPL token account, even on the
  // direct-pair fast path where that base *is* native SOL — `traderAtas`
  // above derives `atas.base` from `baseMint` unconditionally, and when
  // `baseMint` is `WSOL_MINT` that account only holds SOL once it is
  // actually wrapped. Jupiter's own `wrapAndUnwrapSol: true` (see
  // `jupiter.ts`) handles this for the aggregator path; on the direct-pair
  // path there is no Jupiter leg to do it, so this composer must.
  const isDirectNativePair = !c.jupiter && c.baseMint.equals(NATIVE_MINT);

  if (c.side === 'buy') {
    if (isDirectNativePair) {
      // Fund the WSOL ATA with exactly the lamports the curve buy will pull,
      // then sync so the SPL balance reflects the transfer.
      ixs.push(
        SystemProgram.transfer({
          fromPubkey: c.trader,
          toPubkey: atas.base,
          lamports: c.curveAmountIn,
        }),
        createSyncNativeInstruction(atas.base),
      );
    }
    // native -> base (Jupiter, into the trader's own base ATA) -> curve buy.
    if (c.jupiter) ixs.push(...jupiterInstructions(c.jupiter));
    ixs.push(curveIx);
  } else {
    // curve sell (token -> base, into the trader's own base ATA) -> base -> native (Jupiter).
    ixs.push(curveIx);
    if (c.jupiter) {
      ixs.push(...jupiterInstructions(c.jupiter));
    } else if (isDirectNativePair) {
      // No aggregator leg to unwrap for us. Closing the WSOL ATA sweeps its
      // *entire* balance back to native lamports, not just this trade's
      // proceeds — the same behaviour Jupiter's own `wrapAndUnwrapSol`
      // produces for a native-out swap, and safe here because nothing before
      // this instruction leaves other WSOL sitting in that same account
      // (the idempotent create above only just created it, or it already
      // held only what the trader wrapped for a previous, already-settled
      // direct-pair trade). A trader who deliberately keeps a long-term WSOL
      // balance in this exact ATA outside of Stonkz trades would have it
      // swept too — a documented edge case, not a silent one.
      ixs.push(createCloseAccountInstruction(atas.base, c.trader, c.trader));
    }
  }

  const compiled = compileSolanaTransaction({
    payer: c.trader,
    blockhash: blockhash.blockhash,
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
    instructions: ixs,
    ...(c.lookupTables ? { lookupTables: c.lookupTables } : {}),
    forceV0: !!c.jupiter,
  });
  return {
    base64: compiled.base64,
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
    version: compiled.version,
    bytes: compiled.bytes,
    fees: {
      computeUnitLimit: fees.computeUnitLimit,
      computeUnitPriceMicroLamports: fees.computeUnitPriceMicroLamports,
      maxPriorityLamports: Math.ceil(
        (fees.computeUnitLimit * fees.computeUnitPriceMicroLamports) / 1_000_000,
      ),
      tipLamports: fees.tipLamports,
      tipAccount: fees.tipAccount,
    },
  };
}
