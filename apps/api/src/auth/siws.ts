import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';

/**
 * Sign-In With Solana verification.
 *
 * The wallet signs the raw UTF-8 message bytes with its ed25519 key; the
 * "address" is the base58 public key, so recovering an address is a decode
 * rather than a recovery. That makes the binding strict: the signature must
 * verify against the exact key the client claimed.
 */

/** Solana addresses are 32-byte base58. Reject anything else before touching crypto. */
export function isSolanaAddress(address: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return false;
  try {
    return bs58.decode(address).length === 32;
  } catch {
    return false;
  }
}

export interface SiwsVerifyInput {
  message: string;
  /** base58, as every Solana wallet returns it. */
  signature: string;
  address: string;
}

export function verifySiws({ message, signature, address }: SiwsVerifyInput): boolean {
  if (!isSolanaAddress(address)) return false;
  let sigBytes: Uint8Array;
  let pubkey: Uint8Array;
  try {
    sigBytes = bs58.decode(signature);
    pubkey = bs58.decode(address);
  } catch {
    return false;
  }
  if (sigBytes.length !== 64) return false;
  try {
    return ed25519.verify(sigBytes, new TextEncoder().encode(message), pubkey);
  } catch {
    return false;
  }
}
