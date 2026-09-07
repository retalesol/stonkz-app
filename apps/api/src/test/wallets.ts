import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import bs58 from 'bs58';
import { EIP1271_SELECTOR, toChecksumAddress } from '../auth/siwe.js';

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

/**
 * A stand-in for an ERC-4337 smart account: it signs with an owner key, but
 * the signature does not recover to its own address, so only the ERC-1271
 * path can admit it. `ethCall` is what the verifier consults.
 */
export interface TestContractWallet extends TestWallet {
  /** The EOA that actually holds the key. */
  ownerAddress: string;
  ethCall(to: string, data: string): Promise<string>;
}

export function contractWallet(seed = 'evm-contract-wallet'): TestContractWallet {
  const owner = evmWallet(`${seed}:owner`);
  // Deliberately unrelated to the owner key, exactly like a deployed account.
  const address = toChecksumAddress(
    '0x' + Buffer.from(seedBytes(`${seed}:account`)).subarray(12).toString('hex'),
  );

  return {
    address,
    ownerAddress: owner.address,
    sign: (message) => owner.sign(message),
    async ethCall(to, data) {
      if (to.toLowerCase() !== address.toLowerCase()) throw new Error('no code at address');
      // Decode the ABI the verifier encodes: selector, hash word, offset,
      // length, then the signature tail.
      const hex = data.replace(/^0x/, '');
      if (hex.slice(0, 8) !== EIP1271_SELECTOR) throw new Error('unknown selector');
      const hash = hex.slice(8, 72);
      const length = Number.parseInt(hex.slice(136, 200), 16);
      const signature = '0x' + hex.slice(200, 200 + length * 2);

      const recovered = recoverSiweAddressFromHash(hash, signature);
      const ok = recovered !== null && recovered.toLowerCase() === owner.address.toLowerCase();
      // Conforming accounts return the magic value; refusals return zero.
      return ok ? `0x${EIP1271_SELECTOR}${'0'.repeat(56)}` : `0x${'0'.repeat(64)}`;
    },
  };
}

/** Recovery against a pre-computed digest, which is all the account sees. */
function recoverSiweAddressFromHash(hashHex: string, signature: string): string | null {
  const raw = Buffer.from(signature.replace(/^0x/, ''), 'hex');
  if (raw.length !== 65) return null;
  let v = raw[64] as number;
  if (v === 27 || v === 28) v -= 27;
  if (v !== 0 && v !== 1) return null;
  try {
    const sig = secp256k1.Signature.fromCompact(
      Buffer.from(raw.subarray(0, 64)).toString('hex'),
    ).addRecoveryBit(v);
    const pub = sig.recoverPublicKey(Buffer.from(hashHex, 'hex')).toRawBytes(false);
    return toChecksumAddress('0x' + Buffer.from(keccak_256(pub.slice(1))).subarray(12).toString('hex'));
  } catch {
    return null;
  }
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
