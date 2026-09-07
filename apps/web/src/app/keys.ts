import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import bs58 from 'bs58';
import type { Net } from '@stonkz/shared';

/**
 * The practice wallet — a real keypair, generated in the browser and never
 * leaving it, that stands in for a browser extension (Phantom / MetaMask /
 * Robinhood Wallet) so this phase can complete a genuine SIWS/SIWE handshake
 * end to end.
 *
 * `apps/api`'s auth is real cryptographic verification (`auth/siws.ts`,
 * `auth/siwe.ts` — ed25519 / secp256k1, not a fixture bypass), so there is no
 * way to obtain a real access token without signing with a real key. No
 * browser-extension integration exists yet in this codebase (that is Phase
 * 1.B's frontend half, still a `TODO` in `app/wallet.ts`), and building one is
 * out of this phase's scope. This is the smallest thing that is *actually
 * real* rather than theatre: a genuine keypair, persisted per net in
 * `localStorage` so the same session address survives a reload, producing a
 * signature the server's verifier genuinely accepts.
 *
 * It is deliberately never funded and never will be — nothing here can put
 * real SOL or ETH into it. `router/compose.ts`'s balance/cap checks will
 * correctly refuse a buy against this wallet's real (zero) on-chain balance
 * when pointed at a real RPC; that is the honest result, not a bug this file
 * should work around.
 */

const STORAGE_PREFIX = 'stonkz.practiceKey.';

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function storageKey(net: Net): string {
  return STORAGE_PREFIX + net;
}

/** Load the persisted private key for `net`, minting one the first time. */
function privateKeyFor(net: Net): Uint8Array {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(storageKey(net));
  } catch {
    // Storage blocked (private browsing, etc.) — fall through to an
    // in-memory-only key for the rest of this page load.
  }
  if (stored) return hexToBytes(stored);
  const priv = net === 'SOL' ? ed25519.utils.randomPrivateKey() : secp256k1.utils.randomPrivateKey();
  try {
    localStorage.setItem(storageKey(net), bytesToHex(priv));
  } catch {
    // Same as above — this session's key just will not survive a reload.
  }
  return priv;
}

/** The real address this practice key derives to — base58 pubkey (SOL) or a checksummed `0x…` (RH). */
export function practiceAddress(net: Net): string {
  const priv = privateKeyFor(net);
  if (net === 'SOL') return bs58.encode(ed25519.getPublicKey(priv));
  const pub = secp256k1.getPublicKey(priv, false); // uncompressed, 0x04 || X || Y
  const hash = keccak_256(pub.slice(1));
  return '0x' + bytesToHex(hash.slice(-20));
}

/** EIP-191 `personal_sign` digest — byte-for-byte `auth/siwe.ts`'s `personalSignHash`. */
function personalSignHash(message: string): Uint8Array {
  const bytes = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\u0019Ethereum Signed Message:\n${bytes.length}`);
  const joined = new Uint8Array(prefix.length + bytes.length);
  joined.set(prefix, 0);
  joined.set(bytes, prefix.length);
  return keccak_256(joined);
}

/**
 * Sign a SIWS/SIWE challenge message for real. The server hands back the
 * exact string it expects signed (`AuthService.issueNonce`'s `message`), so
 * there is nothing to compose here — only to sign.
 */
export function signSignInMessage(net: Net, message: string): string {
  const priv = privateKeyFor(net);
  if (net === 'SOL') {
    return bs58.encode(ed25519.sign(new TextEncoder().encode(message), priv));
  }
  // `prehash: false`: `personalSignHash` is already the final keccak256
  // digest `auth/siwe.ts`'s `verifySiwe`/`recoverSiweAddress` recovers
  // against — noble's default `prehash: true` would sha256 it again first,
  // which is right for NIST curves but wrong for Ethereum's signing
  // convention (sign the keccak digest directly).
  const sig = secp256k1.sign(personalSignHash(message), priv, { prehash: false });
  const v = (sig.recovery + 27).toString(16).padStart(2, '0');
  return '0x' + sig.toCompactHex() + v;
}
