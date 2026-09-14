import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import {
  NATIVE_MINT,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
} from '@solana/spl-token';
import { JupiterAltRequiredError } from './errors.js';
import type { JupiterHop } from './solana-tx.js';
import { buildBuyInstruction, buildCreateTokenInstruction, traderAtas, type CreateTokenArgs } from './solana-instructions.js';

/**
 * `POST /launch/prepare` on Solana — `create_token`, optionally followed
 * atomically by a dev buy (plan step 90's "unsigned create (+ optional atomic
 * native \u2192 base \u2192 dev_buy)"). One transaction either way: Solana's
 * account model lets `buy` reference the mint/curve `create_token` creates
 * earlier in the *same* transaction, since only ordering — not confirmation —
 * matters within one atomic tx.
 *
 * Instruction order when a dev buy is present:
 *  1. Idempotent-create the creator's **base** ATA (needs to exist before
 *     either a native-SOL wrap or a Jupiter swap can land funds in it).
 *  2. Fund it — either a direct SOL wrap (base is native) or a Jupiter
 *     swap (base is anything else; `jupiter.ts`'s `wrapAndUnwrapSol: true`
 *     already handles unwrapping the *input* SOL on that path).
 *  3. `create_token` — creates the mint, the curve, and every PDA vault.
 *  4. Idempotent-create the creator's **token** ATA — only possible now,
 *     since the mint does not exist before step 3 runs.
 *  5. `buy` — the dev buy itself, against the curve `create_token` just made.
 */
export interface SolanaLaunchDevBuy {
  /** Base atoms the dev buy spends — already net of nothing; this is `amount_base`. */
  curveAmountIn: bigint;
  curveMinOut: bigint;
  /** Present when the base asset is not native/wrapped-native. */
  jupiter?: JupiterHop;
}

export interface SolanaLaunchComposition {
  programId: PublicKey;
  creator: PublicKey;
  baseMint: PublicKey;
  createArgs: CreateTokenArgs;
  devBuy?: SolanaLaunchDevBuy;
}

export interface ComposedSolanaLaunch {
  /** Full wire-format unsigned transaction — what the client's wallet actually signs. */
  base64: string;
  /** Compiled message only (signatures stripped), base64 — what `launch_intents.unsignedPayload` stores and `/launch/confirm` re-derives from the signed, submitted transaction to verify a match. */
  messageBase64: string;
  lastValidBlockHeight: number;
  mint: PublicKey;
  curve: PublicKey;
}

function toIx(ix: { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string }): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(ix.data, 'base64'),
  });
}

function jupiterInstructions(hop: JupiterHop): TransactionInstruction[] {
  const r = hop.response;
  if (r.addressLookupTableAddresses.length > 0) {
    throw new JupiterAltRequiredError();
  }
  const out: TransactionInstruction[] = [];
  if (r.tokenLedgerInstruction) out.push(toIx(r.tokenLedgerInstruction));
  out.push(...r.computeBudgetInstructions.map(toIx));
  out.push(...r.setupInstructions.map(toIx));
  out.push(toIx(r.swapInstruction));
  if (r.cleanupInstruction) out.push(toIx(r.cleanupInstruction));
  return out;
}

export function composeSolanaLaunchTransaction(
  c: SolanaLaunchComposition,
  blockhash: { blockhash: string; lastValidBlockHeight: number },
): ComposedSolanaLaunch {
  const tx = new Transaction({
    feePayer: c.creator,
    blockhash: blockhash.blockhash,
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
  });

  const { instruction: createIx, mint, curve } = buildCreateTokenInstruction(
    {
      programId: c.programId,
      creator: c.creator,
      baseMint: c.baseMint,
      salt: c.createArgs.salt,
    },
    c.createArgs,
  );

  if (c.devBuy) {
    const atas = traderAtas({ programId: c.programId, mint, baseMint: c.baseMint, trader: c.creator });
    const isDirectNativePair = !c.devBuy.jupiter && c.baseMint.equals(NATIVE_MINT);

    tx.add(createAssociatedTokenAccountIdempotentInstruction(c.creator, atas.base, c.creator, c.baseMint));
    if (isDirectNativePair) {
      tx.add(
        SystemProgram.transfer({ fromPubkey: c.creator, toPubkey: atas.base, lamports: c.devBuy.curveAmountIn }),
        createSyncNativeInstruction(atas.base),
      );
    } else if (c.devBuy.jupiter) {
      tx.add(...jupiterInstructions(c.devBuy.jupiter));
    }

    tx.add(createIx);
    tx.add(createAssociatedTokenAccountIdempotentInstruction(c.creator, atas.token, c.creator, mint));
    tx.add(
      buildBuyInstruction(
        { programId: c.programId, mint, baseMint: c.baseMint, trader: c.creator },
        c.devBuy.curveAmountIn,
        c.devBuy.curveMinOut,
      ),
    );
  } else {
    tx.add(createIx);
  }

  const base64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  const messageBase64 = tx.compileMessage().serialize().toString('base64');
  return { base64, messageBase64, lastValidBlockHeight: blockhash.lastValidBlockHeight, mint, curve };
}
