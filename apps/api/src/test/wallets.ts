import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import bs58 from 'bs58';
import { toChecksumAddress } from '../auth/siwe.js';

/**
 * Real keypairs for tests.
 *
 * The auth suite signs actual messages rather than stubbing the verifiers, so
 * a regression in the SIWS/SIWE crypto shows up as a failing login instead of
 * a passing mock.
 */
export interface TestWallet {
  address: string;
  sign(message: string): string;
}

/** Deterministic 32-byte seed so a failing test reproduces exactly. */
function seedBytes(seed: string): Uint8Array {
  return keccak_256(new TextEncoder().encode(seed));
}

export function solanaWallet(seed = 'sol-test-wallet'): TestWallet {
  const priv = seedBytes(seed);
  const pub = ed25519.getPublicKey(priv);
  return {
    address: bs58.encode(pub),
    sign: (message) => bs58.encode(ed25519.sign(new TextEncoder().encode(message), priv)),
  };
}

export function evmWallet(seed = 'evm-test-wallet'): TestWallet {
  const priv = seedBytes(seed);
  const pub = secp256k1.getPublicKey(priv, false);
  const address = toChecksumAddress('0x' + Buffer.from(keccak_256(pub.slice(1))).subarray(12).toString('hex'));

  return {
    address,
    sign(message) {
      const bytes = new TextEncoder().encode(message);
      const prefix = new TextEncoder().encode(`\u0019Ethereum Signed Message:\n${bytes.length}`);
      const joined = new Uint8Array(prefix.length + bytes.length);
      joined.set(prefix, 0);
      joined.set(bytes, prefix.length);
      const sig = secp256k1.sign(keccak_256(joined), priv);
      // 65 bytes: r || s || v, with v in the 27/28 form wallets emit.
      return (
        '0x' +
        Buffer.from(sig.toCompactRawBytes()).toString('hex') +
        (sig.recovery + 27).toString(16).padStart(2, '0')
      );
    },
  };
}
