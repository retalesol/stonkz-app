import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

/**
 * Sign-In With Ethereum (EIP-4361) verification for the Robinhood net.
 *
 * `personal_sign` hashes the message with the EIP-191 prefix, then the
 * signer's address is *recovered* from the signature — the opposite of SIWS,
 * where the address is the public key. So the recovered address has to be
 * compared against the claimed one, and that comparison is what binds the
 * session to an address.
 */

export function isEvmAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}

/** EIP-55 checksum. Mixed-case addresses that fail it are typos, not addresses. */
export function toChecksumAddress(address: string): string {
  const lower = address.toLowerCase().replace(/^0x/, '');
  const hash = Buffer.from(keccak_256(new TextEncoder().encode(lower))).toString('hex');
  let out = '0x';
  for (let i = 0; i < lower.length; i++) {
    const char = lower[i] as string;
    const nibble = Number.parseInt(hash[i] as string, 16);
    out += nibble >= 8 ? char.toUpperCase() : char;
  }
  return out;
}

export function isChecksumValid(address: string): boolean {
  if (!isEvmAddress(address)) return false;
  const body = address.slice(2);
  // All-lower or all-upper addresses carry no checksum information.
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  return toChecksumAddress(address) === address;
}

/** EIP-191 `personal_sign` digest. */
export function personalSignHash(message: string): Uint8Array {
  const bytes = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\u0019Ethereum Signed Message:\n${bytes.length}`);
  const joined = new Uint8Array(prefix.length + bytes.length);
  joined.set(prefix, 0);
  joined.set(bytes, prefix.length);
  return keccak_256(joined);
}

function addressFromPublicKey(uncompressed: Uint8Array): string {
  // Drop the 0x04 tag; the address is the last 20 bytes of keccak(pubkey).
  const hash = keccak_256(uncompressed.slice(1));
  return toChecksumAddress('0x' + Buffer.from(hash).subarray(12).toString('hex'));
}

/** Recovers the signer, or null if the signature is malformed. */
export function recoverSiweAddress(message: string, signature: string): string | null {
  const hex = signature.replace(/^0x/, '');
  if (hex.length !== 130 || !/^[0-9a-fA-F]+$/.test(hex)) return null;

  const raw = Buffer.from(hex, 'hex');
  let v = raw[64] as number;
  // Wallets send 27/28; some send 0/1. EIP-155 chain-encoded v is not valid here.
  if (v === 27 || v === 28) v -= 27;
  if (v !== 0 && v !== 1) return null;

  try {
    const sig = secp256k1.Signature.fromCompact(
      Buffer.from(raw.subarray(0, 64)).toString('hex'),
    ).addRecoveryBit(v);
    const digest = personalSignHash(message);
    const pubkey = sig.recoverPublicKey(digest).toRawBytes(false);
    return addressFromPublicKey(pubkey);
  } catch {
    return null;
  }
}

export interface SiweVerifyInput {
  message: string;
  signature: string;
  address: string;
}

export function verifySiwe({ message, signature, address }: SiweVerifyInput): boolean {
  if (!isEvmAddress(address) || !isChecksumValid(address)) return false;
  const recovered = recoverSiweAddress(message, signature);
  return recovered !== null && recovered.toLowerCase() === address.toLowerCase();
}
