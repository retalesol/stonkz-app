/**
 * Synthetic wallet addresses for load-test traffic.
 *
 * Solana addresses have to be real base58-encoded 32-byte public keys —
 * `POST /trade/prepare` does `new PublicKey(wallet)` on whatever `sub` claim
 * the JWT carries (`routes/trade.ts`) — so these are real, freshly generated
 * `Keypair`s. Nothing ever needs their private keys; only the address is
 * used, and only as an opaque identity key for rate limiting, `settings`,
 * `holders_snapshot`, etc.
 *
 * Robinhood (EVM) addresses only need to look like a 20-byte hex address —
 * nothing on the load-tested paths recovers a signature against one, they are
 * just an identity/rate-limit key and a calldata field.
 */
import { randomBytes } from 'node:crypto';
import { Keypair } from '@solana/web3.js';

export function solanaWallet(): string {
  return Keypair.generate().publicKey.toBase58();
}

export function evmWallet(): string {
  return `0x${randomBytes(20).toString('hex')}`;
}
