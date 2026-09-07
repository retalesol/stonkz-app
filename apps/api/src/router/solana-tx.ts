import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import {
  NATIVE_MINT,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
} from '@solana/spl-token';
import type { ChainRpc, SolanaBlockhashSource, SolanaTransactionSource } from '../chain/types.js';
import type { JupiterInstruction, JupiterSwapInstructionsResponse } from './jupiter.js';
import { buildBuyInstruction, buildSellInstruction, traderAtas } from './solana-instructions.js';

/** Mirrors `app/deps.ts`'s `asEthCaller` — narrows a `ChainRpc` to the blockhash capability only the real Solana RPC (and `FakeChainRpc`) implement. */
export function asSolanaBlockhashSource(rpc: ChainRpc): SolanaBlockhashSource | undefined {
  const candidate = rpc as Partial<SolanaBlockhashSource>;
  return typeof candidate.latestBlockhash === 'function' ? (candidate as SolanaBlockhashSource) : undefined;
}

/** Same narrowing, for `routes/launch.ts`'s confirm-time transaction lookup. */
export function asSolanaTransactionSource(rpc: ChainRpc): SolanaTransactionSource | undefined {
  const candidate = rpc as Partial<SolanaTransactionSource>;
  return typeof candidate.getTransactionMessageBase64 === 'function' ? (candidate as SolanaTransactionSource) : undefined;
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
}

export interface ComposedSolanaTransaction {
  /** Base64 of the serialized, *unsigned* transaction message + empty signature slots. */
  base64: string;
  lastValidBlockHeight: number;
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

function jupiterInstructions(hop: JupiterHop): TransactionInstruction[] {
  const r = hop.response;
  if (r.addressLookupTableAddresses.length > 0) {
    // A legacy `Transaction` cannot resolve ALT-indexed accounts. Building a
    // `VersionedTransaction` here would need the looked-up table contents
    // (`getAddressLookupTable`), which is a live RPC read this composer does
    // not have wired in. Refusing loudly beats emitting a transaction that
    // fails to simulate with an opaque account-not-found error.
    throw new Error(
      'composeSolanaTradeTransaction: Jupiter route requires address lookup tables; ' +
        'VersionedTransaction support is not implemented — see solana-tx.ts',
    );
  }
  const out: TransactionInstruction[] = [];
  if (r.tokenLedgerInstruction) out.push(toTransactionInstruction(r.tokenLedgerInstruction));
  out.push(...r.computeBudgetInstructions.map(toTransactionInstruction));
  out.push(...r.setupInstructions.map(toTransactionInstruction));
  out.push(toTransactionInstruction(r.swapInstruction));
  if (r.cleanupInstruction) out.push(toTransactionInstruction(r.cleanupInstruction));
  return out;
}

export function composeSolanaTradeTransaction(
  c: SolanaTradeComposition,
  blockhash: { blockhash: string; lastValidBlockHeight: number },
): ComposedSolanaTransaction {
  const tx = new Transaction({
    feePayer: c.trader,
    blockhash: blockhash.blockhash,
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
  });

  const atas = traderAtas({ programId: c.programId, mint: c.mint, baseMint: c.baseMint, trader: c.trader });
  // Idempotent: a no-op if the trader already has either account. Included
  // unconditionally rather than after an extra `getAccountInfo` round trip —
  // one wasted, cheap instruction is preferable to a second RPC hop on the
  // 8-second quote-to-prepare budget.
  tx.add(
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
      tx.add(
        SystemProgram.transfer({ fromPubkey: c.trader, toPubkey: atas.base, lamports: c.curveAmountIn }),
        createSyncNativeInstruction(atas.base),
      );
    }
    // native -> base (Jupiter, into the trader's own base ATA) -> curve buy.
    if (c.jupiter) tx.add(...jupiterInstructions(c.jupiter));
    tx.add(curveIx);
  } else {
    // curve sell (token -> base, into the trader's own base ATA) -> base -> native (Jupiter).
    tx.add(curveIx);
    if (c.jupiter) {
      tx.add(...jupiterInstructions(c.jupiter));
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
      tx.add(createCloseAccountInstruction(atas.base, c.trader, c.trader));
    }
  }

  const base64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  return { base64, lastValidBlockHeight: blockhash.lastValidBlockHeight };
}
