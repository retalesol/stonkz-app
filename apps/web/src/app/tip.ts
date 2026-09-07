import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import type { Net } from '@stonkz/shared';
import { practiceSolanaSecretKey } from './keys.js';

/**
 * Attempts a genuinely real on-chain native transfer for the wall's tip flow.
 *
 * `app/signer.ts` explains why trade/launch/claim never touch a real RPC:
 * nothing in this repo broadcasts a signed transaction and waits for it to
 * land, and the practice key is never funded, so any real attempt fails at
 * broadcast regardless. Tipping is the one flow honest enough to make that
 * attempt anyway — `apps/api/src/social/tips.ts`'s `verifyTip` re-derives the
 * transfer from the chain itself, so a fabricated signature (`signer.ts`'s
 * `fakeSolanaSignature()`) would just be rejected as "not found" server-side.
 * Actually asking a real RPC to send a real transfer produces the same
 * "insufficient funds" rejection, but for the true reason instead of a
 * fabricated one, and is what the plan calls for in Phase 5.C.
 *
 * Solana-only: Robinhood Chain has no wallet-adapter or RPC signing path in
 * this build at all (`app/wallet.ts`'s `TODO`), and constructing a raw EVM
 * transaction without one would not be any more "real" than not trying.
 */
export class TipBroadcastError extends Error {}

const SOLANA_RPC_URL: string =
  (import.meta.env['VITE_SOLANA_RPC_URL'] as string | undefined) ?? 'https://api.mainnet-beta.solana.com';

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Builds, signs and broadcasts a native SOL transfer of `amountNative` to
 * `toAddress`, waits for confirmation, and returns the confirmed signature.
 * Rejects with `TipBroadcastError` for `net !== 'SOL'` or when the broadcast
 * fails — which it always will from this unfunded practice key — with a
 * message safe to show the user directly.
 */
export async function attemptTip(net: Net, toAddress: string, amountNative: number): Promise<string> {
  if (net !== 'SOL') {
    throw new TipBroadcastError(
      'Live tips on Robinhood Chain need a real wallet-adapter connection, which this build does not have yet.',
    );
  }

  let to: PublicKey;
  try {
    to = new PublicKey(toAddress);
  } catch (err) {
    throw new TipBroadcastError('Not a valid Solana address: ' + describe(err));
  }

  const from = Keypair.fromSecretKey(practiceSolanaSecretKey());
  const lamports = Math.round(amountNative * LAMPORTS_PER_SOL);
  if (lamports <= 0) throw new TipBroadcastError('Tip amount must be greater than zero.');

  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports }));

  try {
    return await sendAndConfirmTransaction(connection, tx, [from], { commitment: 'confirmed' });
  } catch (err) {
    // The practice key has no real SOL, so this always ends here — a real
    // RPC genuinely refusing a real, unfunded transfer, not theatre.
    throw new TipBroadcastError(
      'The practice wallet has no real SOL, so the tip could not be sent (' +
        describe(err) +
        '). Connect a funded wallet to send a real tip.',
    );
  }
}
