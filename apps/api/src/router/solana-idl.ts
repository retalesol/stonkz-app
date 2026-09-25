import { sha256 } from '@noble/hashes/sha256';
import { PublicKey } from '@solana/web3.js';

/**
 * The tiny slice of `programs/solana/programs/launchpad`'s public interface
 * this API needs to build unsigned instructions against, hand-derived rather
 * than depending on `programs/solana/target/idl/launchpad.json` — that file
 * is a build artifact (`programs/solana/.gitignore` excludes `target/`), so a
 * fresh checkout that has not run `anchor build` would not have it. Every
 * value below is instead derived the same way Anchor itself derives it, from
 * facts that are checked into the repo:
 * - discriminators: the first 8 bytes of `sha256("global:<ix_name>")`
 *   (Anchor's `sighash`), computed at runtime by {@link anchorDiscriminator}.
 * - PDA seeds: `programs/solana/programs/launchpad/src/constants.rs`.
 * - account order and arg encoding: `programs/solana/programs/launchpad/src/instructions/*.rs`.
 *
 * `solana-idl.test.ts` pins the four discriminators this file uses against
 * the literal byte arrays Anchor's own IDL generator produced (recorded once,
 * by hand, from `programs/solana/target/idl/launchpad.json` — see that test's
 * header), so a change to any instruction's Rust name would fail loudly here
 * even without a local Anchor build.
 */

export const LAUNCHPAD_SEEDS = {
  global: 'global',
  curve: 'curve',
  mint: 'mint',
  curveBaseVault: 'curve_base',
  curveTokenVault: 'curve_token',
  lpVault: 'lp_vault',
  bucketBaseVault: 'bucket_base',
  bucketTokenVault: 'bucket_token',
  stakeEscrow: 'stake_escrow',
  stakePosition: 'stake',
  protocolVault: 'protocol_vault',
  opsVault: 'ops_vault',
  burnVault: 'burn_vault',
  oracle: 'oracle',
} as const;

export function anchorDiscriminator(instructionName: string): Buffer {
  return Buffer.from(sha256(`global:${instructionName}`)).subarray(0, 8);
}

export interface LaunchpadPdas {
  global: PublicKey;
  curve: PublicKey;
  curveBaseVault: PublicKey;
  curveTokenVault: PublicKey;
  bucketBaseVault: PublicKey;
  bucketTokenVault: PublicKey;
  lpVault: PublicKey;
  stakeEscrow: PublicKey;
  protocolVault: PublicKey;
  opsVault: PublicKey;
  burnVault: PublicKey;
  oracle: PublicKey;
}

function pda(programId: PublicKey, seeds: (Buffer | Uint8Array)[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

/** Every PDA `buy`/`sell`/`claim_creator_fees` need, derived from `mint` and `baseMint` alone. */
export function derivePdas(
  programId: PublicKey,
  mint: PublicKey,
  baseMint: PublicKey,
): LaunchpadPdas {
  const global = pda(programId, [Buffer.from(LAUNCHPAD_SEEDS.global)]);
  const curve = pda(programId, [Buffer.from(LAUNCHPAD_SEEDS.curve), mint.toBuffer()]);
  const curveBaseVault = pda(programId, [
    Buffer.from(LAUNCHPAD_SEEDS.curveBaseVault),
    mint.toBuffer(),
  ]);
  const curveTokenVault = pda(programId, [
    Buffer.from(LAUNCHPAD_SEEDS.curveTokenVault),
    mint.toBuffer(),
  ]);
  const bucketBaseVault = pda(programId, [
    Buffer.from(LAUNCHPAD_SEEDS.bucketBaseVault),
    mint.toBuffer(),
  ]);
  const bucketTokenVault = pda(programId, [
    Buffer.from(LAUNCHPAD_SEEDS.bucketTokenVault),
    mint.toBuffer(),
  ]);
  const lpVault = pda(programId, [Buffer.from(LAUNCHPAD_SEEDS.lpVault), mint.toBuffer()]);
  const stakeEscrow = pda(programId, [Buffer.from(LAUNCHPAD_SEEDS.stakeEscrow), mint.toBuffer()]);
  const protocolVault = pda(programId, [
    Buffer.from(LAUNCHPAD_SEEDS.protocolVault),
    baseMint.toBuffer(),
  ]);
  const opsVault = pda(programId, [Buffer.from(LAUNCHPAD_SEEDS.opsVault), baseMint.toBuffer()]);
  const burnVault = pda(programId, [Buffer.from(LAUNCHPAD_SEEDS.burnVault), baseMint.toBuffer()]);
  const oracle = pda(programId, [Buffer.from(LAUNCHPAD_SEEDS.oracle), baseMint.toBuffer()]);
  return {
    global,
    curve,
    curveBaseVault,
    curveTokenVault,
    bucketBaseVault,
    bucketTokenVault,
    lpVault,
    stakeEscrow,
    protocolVault,
    opsVault,
    burnVault,
    oracle,
  };
}

/** `create_token`'s mint PDA — seeds `[b"mint", creator, salt_le]`. */
export function deriveMintPda(
  programId: PublicKey,
  creator: PublicKey,
  salt: bigint | number,
): [PublicKey, number] {
  const saltBuf = Buffer.alloc(8);
  saltBuf.writeBigUInt64LE(typeof salt === 'bigint' ? salt : BigInt(salt));
  return PublicKey.findProgramAddressSync(
    [Buffer.from(LAUNCHPAD_SEEDS.mint), creator.toBuffer(), saltBuf],
    programId,
  );
}

/** Per-wallet stake position PDA — seeds `[b"stake", mint, owner]`. */
export function deriveStakePositionPda(
  programId: PublicKey,
  mint: PublicKey,
  owner: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(LAUNCHPAD_SEEDS.stakePosition), mint.toBuffer(), owner.toBuffer()],
    programId,
  );
}

/* ---------------------------------------------------------------- borsh-lite encoding */
// Anchor's instruction args are plain Borsh, and every arg this API ever
// sends is one of these four primitives — not worth pulling in a full Borsh
// dependency for.

export function encodeU16(n: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(n, 0);
  return buf;
}

export function encodeU64(n: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(n, 0);
  return buf;
}

export function encodeBool(b: boolean): Buffer {
  return Buffer.from([b ? 1 : 0]);
}

export function encodeString(s: string): Buffer {
  const body = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length, 0);
  return Buffer.concat([len, body]);
}
