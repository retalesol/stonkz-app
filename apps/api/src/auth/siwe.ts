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

/** ECDSA only. Sufficient for an EOA, and wrong for a smart account. */
export function verifySiwe({ message, signature, address }: SiweVerifyInput): boolean {
  if (!isEvmAddress(address) || !isChecksumValid(address)) return false;
  const recovered = recoverSiweAddress(message, signature);
  return recovered !== null && recovered.toLowerCase() === address.toLowerCase();
}

/**
 * ERC-1271 `isValidSignature(bytes32,bytes)`.
 *
 * The 4-byte selector and the success value are the same word — that is the
 * standard's design, not a coincidence here.
 */
export const EIP1271_SELECTOR = '1626ba7e';
export const EIP1271_MAGIC = `0x${EIP1271_SELECTOR}`;

function padTo32(n: number): string {
  return n.toString(16).padStart(64, '0');
}

/** ABI-encodes the `isValidSignature` call. `bytes` is dynamic, so it is passed by offset. */
export function encodeIsValidSignature(hash: Uint8Array, signature: string): string {
  const sig = signature.replace(/^0x/, '');
  const bytes = sig.length / 2;
  // The tail is padded to a whole word; an unpadded tail is a decode revert.
  const padded = sig.padEnd(Math.ceil(bytes / 32) * 64, '0');
  return (
    '0x' +
    EIP1271_SELECTOR +
    Buffer.from(hash).toString('hex') +
    padTo32(0x40) +
    padTo32(bytes) +
    padded
  );
}

export function isEip1271Success(returnData: string): boolean {
  const hex = returnData.replace(/^0x/, '').toLowerCase();
  // A conforming account returns the magic value left-aligned in one word.
  return hex.length >= 8 && hex.slice(0, 8) === EIP1271_SELECTOR;
}

/** The one RPC capability the contract path needs. Keeps SIWE off a full client. */
export interface EthCaller {
  ethCall(to: string, data: string): Promise<string>;
}

/**
 * Full SIWE verification: ECDSA, then ERC-1271.
 *
 * Robinhood Chain treats ERC-4337 as first-class, so smart-contract accounts
 * will log in, and `ecrecover` alone rejects them with "signature invalid"
 * rather than anything a user could act on. The contract call runs only after
 * ECDSA has failed, so an EOA login stays a pure local computation and costs
 * no RPC round trip.
 *
 * Deliberately not gated on signature length: an ERC-4337 account's signature
 * is whatever its validation logic accepts, frequently far longer than 65
 * bytes. Pre-deployment (ERC-6492) signatures are out of scope for Phase 1;
 * they would slot in as a third branch here, which is why this returns a
 * promise even though the ECDSA path is synchronous.
 */
export async function verifySiweFull(
  { message, signature, address }: SiweVerifyInput,
  caller?: EthCaller,
): Promise<boolean> {
  if (!isEvmAddress(address) || !isChecksumValid(address)) return false;
  if (verifySiwe({ message, signature, address })) return true;
  if (!caller) return false;

  try {
    const data = encodeIsValidSignature(personalSignHash(message), signature);
    return isEip1271Success(await caller.ethCall(address, data));
  } catch {
    // A plain EOA has no code, so the call reverts. Indistinguishable from a
    // refusal here, and both mean the same thing: not signed by this address.
    return false;
  }
}
