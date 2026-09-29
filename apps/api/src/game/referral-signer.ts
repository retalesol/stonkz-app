import { createPrivateKey, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';
import { Keypair, type PublicKey } from '@solana/web3.js';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

/**
 * The referral voucher signer — the API's half of self-serve on-chain
 * referral payouts (`docs/referral-payouts.md`).
 *
 * Same posture as `STOCK_PRICE_ATTESTER_KEY` (`router/price-attest.ts`): the
 * keys here only ever sign messages. They hold no funds, pay no gas, and the
 * vaults bound what a leaked key could move (`maxPerDay`); the launchpad
 * pauser can stop claims and admin rotates the signer.
 *
 * EVM (`ReferralVault.sol`): EIP-712
 *   domain  { name "StonkzReferralVault", version "1", chainId, verifyingContract = vault }
 *   message ReferralClaim(address recipient, address asset, uint256 cumulativeAmount, uint256 deadline)
 *
 * Solana (`instructions/referral.rs`): Ed25519 over
 *   "STONKZ_REFERRAL_V1" || cluster_tag[8] || vault || recipient || base_mint
 *                        || cumulative u64 LE || deadline i64 LE
 * carried in an `Ed25519Program` instruction the program reads back through
 * the instructions sysvar.
 *
 * Both vouchers certify a **cumulative** lifetime amount: the vault pays the
 * difference over what it already paid that recipient, so a replayed or
 * stale voucher pays nothing and no nonce is needed.
 */

export const REFERRAL_EVM_DOMAIN = { name: 'StonkzReferralVault', version: '1' } as const;

export const REFERRAL_CLAIM_TYPES = {
  ReferralClaim: [
    { name: 'recipient', type: 'address' },
    { name: 'asset', type: 'address' },
    { name: 'cumulativeAmount', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

export const REFERRAL_SOL_PREFIX = Buffer.from('STONKZ_REFERRAL_V1', 'utf8');
/** Prefix (18) + tag (8) + three keys (96) + u64 + i64. */
export const REFERRAL_SOL_MESSAGE_LEN = 18 + 8 + 32 + 32 + 32 + 8 + 8;

export interface EvmVoucherInput {
  chainId: number;
  vault: Address;
  recipient: Address;
  asset: Address;
  cumulativeAmount: bigint;
  deadline: bigint;
}

export interface SolVoucherInput {
  clusterTag: Buffer;
  vault: PublicKey;
  recipient: PublicKey;
  baseMint: PublicKey;
  cumulativeAmount: bigint;
  deadline: bigint;
}

/** The 8-byte cluster marker `ReferralConfig.cluster_tag` must equal. */
export function solClusterTag(cluster: 'mainnet-beta' | 'devnet' | 'testnet' | 'localnet'): Buffer {
  const word = cluster === 'mainnet-beta' ? 'mainnet' : cluster;
  const out = Buffer.alloc(8);
  out.write(word, 'utf8');
  return out;
}

/** Byte-for-byte `referral_message` in the program. */
export function referralMessageSol(v: SolVoucherInput): Buffer {
  if (v.clusterTag.length !== 8) throw new Error('cluster tag must be 8 bytes');
  const cum = Buffer.alloc(8);
  cum.writeBigUInt64LE(v.cumulativeAmount);
  const dl = Buffer.alloc(8);
  dl.writeBigInt64LE(v.deadline);
  const m = Buffer.concat([
    REFERRAL_SOL_PREFIX,
    v.clusterTag,
    v.vault.toBuffer(),
    v.recipient.toBuffer(),
    v.baseMint.toBuffer(),
    cum,
    dl,
  ]);
  if (m.length !== REFERRAL_SOL_MESSAGE_LEN) throw new Error('bad referral message length');
  return m;
}

export function evmSignerFromKey(raw: string | undefined): PrivateKeyAccount | null {
  const key = raw?.trim();
  if (!key) return null;
  const hex = (key.startsWith('0x') ? key : `0x${key}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('REFERRAL_SIGNER_KEY_EVM must be a 32-byte hex private key');
  }
  return privateKeyToAccount(hex);
}

export interface SolSigner {
  publicKey: PublicKey;
  key: KeyObject;
}

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** A 32-byte hex seed, a 64-byte hex secret key, or `solana-keygen`'s JSON array. */
export function solSignerFromKey(raw: string | undefined): SolSigner | null {
  const key = raw?.trim();
  if (!key) return null;
  let seed: Buffer;
  if (key.startsWith('[')) {
    const arr = JSON.parse(key) as unknown;
    if (!Array.isArray(arr) || (arr.length !== 64 && arr.length !== 32)) {
      throw new Error('REFERRAL_SIGNER_KEY_SOL JSON must be a 32- or 64-number array');
    }
    seed = Buffer.from(arr as number[]).subarray(0, 32);
  } else {
    const hex = key.startsWith('0x') ? key.slice(2) : key;
    if (!/^[0-9a-fA-F]{64}$/.test(hex) && !/^[0-9a-fA-F]{128}$/.test(hex)) {
      throw new Error('REFERRAL_SIGNER_KEY_SOL must be a 32-byte seed or 64-byte secret key, hex');
    }
    seed = Buffer.from(hex, 'hex').subarray(0, 32);
  }
  const publicKey = Keypair.fromSeed(seed).publicKey;
  const pkcs8 = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
  return { publicKey, key: createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }) };
}

/** Verify an Ed25519 voucher signature against a raw 32-byte public key (tests / confirm). */
export function verifyEd25519(publicKey: PublicKey, message: Buffer, signature: Buffer): boolean {
  const spki = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    publicKey.toBuffer(),
  ]);
  try {
    return edVerify(
      null,
      message,
      { key: spki, format: 'der', type: 'spki' } as unknown as KeyObject,
      signature,
    );
  } catch {
    return false;
  }
}

export class ReferralSigner {
  constructor(
    private readonly evm: PrivateKeyAccount | null,
    private readonly sol: SolSigner | null,
  ) {}

  /** The address the EVM vaults' `signer` must equal, or `null` when off. */
  get evmAddress(): Address | null {
    return this.evm?.address ?? null;
  }

  /** The key `ReferralConfig.signer` must equal, or `null` when off. */
  get solPublicKey(): PublicKey | null {
    return this.sol?.publicKey ?? null;
  }

  async signEvm(v: EvmVoucherInput): Promise<Hex> {
    if (!this.evm) throw new Error('referral signer: EVM key not configured');
    return this.evm.signTypedData({
      domain: { ...REFERRAL_EVM_DOMAIN, chainId: v.chainId, verifyingContract: v.vault },
      types: REFERRAL_CLAIM_TYPES,
      primaryType: 'ReferralClaim',
      message: {
        recipient: v.recipient,
        asset: v.asset,
        cumulativeAmount: v.cumulativeAmount,
        deadline: v.deadline,
      },
    });
  }

  signSol(v: SolVoucherInput): { message: Buffer; signature: Buffer } {
    if (!this.sol) throw new Error('referral signer: Solana key not configured');
    const message = referralMessageSol(v);
    const signature = Buffer.from(edSign(null, message, this.sol.key));
    return { message, signature };
  }
}

/** Parsed once at boot; a malformed key fails the boot loudly rather than silently disabling claims. */
export function referralSignerFromEnv(env: {
  referralSignerKeyEvm: string | undefined;
  referralSignerKeySol: string | undefined;
}): ReferralSigner {
  return new ReferralSigner(
    evmSignerFromKey(env.referralSignerKeyEvm),
    solSignerFromKey(env.referralSignerKeySol),
  );
}
