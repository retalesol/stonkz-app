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
import { isAddress, parseEther } from 'viem';
import { SOLANA_RPC_URL, activeWallet, describeWalletError, mapWalletError } from '../wallet/index.js';
import { practiceSolanaSecretKey } from './keys.js';
import { signAndConfirm } from './signer.js';

/**
 * The wall's tip — a real native transfer, on either chain.
 *
 * This was the only flow in the app that ever touched a real RPC, precisely
 * because `apps/api/src/social/tips.ts`'s `verifyTip` re-derives sender,
 * recipient and amount from the chain: a fabricated signature is rejected as
 * "not found" server-side, so there was never any point pretending. Robinhood
 * tips were refused outright, with the honest reason that no EVM signing path
 * existed.
 *
 * Both halves are closed now. `wallet/evm.ts` signs and broadcasts, so an RH
 * tip is an `eth_sendTransaction` of `value` wei to the recipient, waited on
 * for a receipt. The Solana path prefers the connected wallet too, and only
 * falls back to signing with the practice key directly when *that* is the
 * connected wallet — the one case where this module still owns a secret key,
 * kept because it produces a genuine (and genuinely failing, for lack of
 * funds) broadcast rather than a fake success.
 */
export class TipBroadcastError extends Error {}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** The unfunded-practice-key path: a real transfer attempt that really fails. */
async function tipFromPracticeKey(to: PublicKey, lamports: number): Promise<string> {
  const from = Keypair.fromSecretKey(practiceSolanaSecretKey());
  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports }));
  try {
    return await sendAndConfirmTransaction(connection, tx, [from], { commitment: 'confirmed' });
  } catch (err) {
    throw new TipBroadcastError(
      'The practice wallet has no real SOL, so the tip could not be sent (' +
        describe(err) +
        '). Connect a funded wallet to send a real tip.',
    );
  }
}

/**
 * Builds an unsigned SOL transfer for the *connected* wallet to sign.
 *
 * `signAndConfirm` takes base64 of a serialised transaction — the same shape
 * `POST /trade/prepare` returns — so the fee payer and a fresh blockhash have
 * to be set here before serialising, and `requireAllSignatures: false` lets
 * it serialise while still unsigned.
 */
async function buildSolTransfer(from: string, to: PublicKey, lamports: number): Promise<string> {
  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  const fromPubkey = new PublicKey(from);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: fromPubkey, blockhash, lastValidBlockHeight }).add(
    SystemProgram.transfer({ fromPubkey, toPubkey: to, lamports }),
  );
  const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  let base64 = '';
  for (const b of bytes) base64 += String.fromCharCode(b);
  return btoa(base64);
}

/**
 * Builds, signs and broadcasts a native transfer of `amountNative` to
 * `toAddress`, waits for confirmation, and returns the confirmed signature.
 * Rejects with `TipBroadcastError` carrying a message safe to show the user
 * directly.
 */
export async function attemptTip(net: Net, toAddress: string, amountNative: number): Promise<string> {
  if (amountNative <= 0) throw new TipBroadcastError('Tip amount must be greater than zero.');
  const wallet = activeWallet();
  if (!wallet || wallet.net !== net) {
    throw new TipBroadcastError('Connect a wallet on this network to send a tip.');
  }

  if (net === 'RH') {
    if (!isAddress(toAddress)) {
      throw new TipBroadcastError('Not a valid Robinhood Chain address: ' + toAddress);
    }
    try {
      const { signature } = await signAndConfirm(net, {
        net: 'RH',
        to: toAddress,
        data: '0x',
        value: parseEther(String(amountNative)).toString(),
      });
      return signature;
    } catch (err) {
      throw new TipBroadcastError(describeWalletError(mapWalletError(err)));
    }
  }

  let to: PublicKey;
  try {
    to = new PublicKey(toAddress);
  } catch (err) {
    throw new TipBroadcastError('Not a valid Solana address: ' + describe(err));
  }
  const lamports = Math.round(amountNative * LAMPORTS_PER_SOL);
  if (lamports <= 0) throw new TipBroadcastError('Tip amount must be greater than zero.');

  if (wallet.practice) return tipFromPracticeKey(to, lamports);

  try {
    const transaction = await buildSolTransfer(wallet.address, to, lamports);
    const { signature } = await signAndConfirm(net, { net: 'SOL', transaction });
    return signature;
  } catch (err) {
    throw new TipBroadcastError(describeWalletError(mapWalletError(err)));
  }
}
