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

/**
 * Metaplex Token Metadata program. `create_token` pins it with an `address =`
 * constraint (`TOKEN_METADATA_PROGRAM_ID` in `constants.rs`) and CPIs
 * `CreateMetadataAccountV3` into it.
 */
export const TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
);

/**
 * Metaplex metadata PDA for `mint` — seeds `["metadata", metaplex, mint]`
 * under the Metaplex program (`create_token`'s `metadata` account).
 */
export function deriveMetadataPda(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    TOKEN_METADATA_PROGRAM_ID,
  );
}

/* ------------------------------------------------------------------ Pyth */

/**
 * Pyth Solana receiver program — owner of every `PriceUpdateV2` account
 * (`programs/.../src/pyth.rs` `PYTH_RECEIVER_PROGRAM_ID`). Same on devnet and
 * mainnet.
 */
export const PYTH_RECEIVER_PROGRAM_ID = new PublicKey(
  'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ',
);

/**
 * Pyth push-oracle program. Each sponsored feed's `PriceUpdateV2` account is
 * its PDA `[shard_id u16 LE, feed_id]`, refreshed by Pyth on a heartbeat
 * (measured ~35 s devnet, ~55 s mainnet) or on a price move.
 */
export const PYTH_PUSH_ORACLE_PROGRAM_ID = new PublicKey(
  'pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT',
);

/**
 * Base mint → the Pyth feed id (hex) `sync_price_from_pyth` accepts for it.
 * Mirrors `PYTH_FEEDS` in `programs/solana/programs/launchpad/src/pyth.rs`:
 * the program refuses any other feed for these mints and any feed at all for
 * a mint not listed, so a mint must be added to both or neither.
 */
export const PYTH_FEEDS: Readonly<Record<string, string>> = {
  // Wrapped SOL → SOL/USD.
  So11111111111111111111111111111111111111112:
    'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  // Mainnet USDC → USDC/USD.
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:
    'eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
  // Mainnet USDT → USDT/USD.
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB:
    '2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b',
};

/** The feed id pinned for `baseMint`, or `null` when the program pins none. */
export function pinnedPythFeedId(baseMint: PublicKey): Buffer | null {
  const hex = PYTH_FEEDS[baseMint.toBase58()];
  return hex ? Buffer.from(hex, 'hex') : null;
}

/** Sponsored push-feed account for `feedId` — PDA `[shard u16 LE, feed_id]` under the push-oracle program. */
export function pythPriceFeedAccount(feedId: Buffer | Uint8Array, shard = 0): PublicKey {
  const shardLe = Buffer.alloc(2);
  shardLe.writeUInt16LE(shard, 0);
  return PublicKey.findProgramAddressSync(
    [shardLe, Buffer.from(feedId)],
    PYTH_PUSH_ORACLE_PROGRAM_ID,
  )[0];
}

/** `sha256("account:PriceUpdateV2")[..8]`. */
export const PRICE_UPDATE_V2_DISCRIMINATOR = Buffer.from(sha256('account:PriceUpdateV2')).subarray(
  0,
  8,
);

/** The fields of a `PriceUpdateV2` the launch composer uses. */
export interface PythPriceUpdate {
  /** `true` only for `VerificationLevel::Full` — the only level the program accepts. */
  fullyVerified: boolean;
  feedId: Buffer;
  price: bigint;
  conf: bigint;
  exponent: number;
  publishTime: number;
}

/**
 * `PriceUpdateV2` after the 8-byte discriminator: `write_authority [32] |
 * verification_level (Partial{u8}=0 → 2 bytes, Full=1 → 1 byte) | feed_id [32]
 * | price i64 | conf u64 | exponent i32 | publish_time i64 | prev_publish_time
 * i64 | ema_price i64 | ema_conf u64 | posted_slot u64`. `null` for anything
 * that is not a well-formed one (the same shapes the program refuses as
 * `PythAccountInvalid`).
 */
export function decodePythPriceUpdateV2(data: Buffer): PythPriceUpdate | null {
  if (data.length < 8 + 32 + 1 || !data.subarray(0, 8).equals(PRICE_UPDATE_V2_DISCRIMINATOR)) {
    return null;
  }
  let o = 8 + 32;
  const level = data.readUInt8(o);
  if (level === 0) o += 2;
  else if (level === 1) o += 1;
  else return null;
  if (data.length < o + 32 + 8 + 8 + 4 + 8 + 32) return null;
  const feedId = Buffer.from(data.subarray(o, o + 32));
  o += 32;
  const price = data.readBigInt64LE(o);
  o += 8;
  const conf = data.readBigUInt64LE(o);
  o += 8;
  const exponent = data.readInt32LE(o);
  o += 4;
  const publishTime = Number(data.readBigInt64LE(o));
  return { fullyVerified: level === 1, feedId, price, conf, exponent, publishTime };
}

/** Test/fixture helper: `PriceUpdateV2` account bytes as the receiver program writes them. */
export function encodePythPriceUpdateV2(u: {
  feedId: Buffer | Uint8Array;
  price: bigint;
  conf?: bigint;
  exponent: number;
  publishTime: number;
  /** `undefined` = `Full`; a number = `Partial { num_signatures }`. */
  partialSignatures?: number;
}): Buffer {
  const level =
    u.partialSignatures === undefined ? Buffer.from([1]) : Buffer.from([0, u.partialSignatures]);
  const msg = Buffer.alloc(32 + 8 + 8 + 4 + 8 + 8 + 8 + 8);
  let o = 0;
  Buffer.from(u.feedId).copy(msg, o);
  o += 32;
  msg.writeBigInt64LE(u.price, o);
  o += 8;
  msg.writeBigUInt64LE(u.conf ?? 0n, o);
  o += 8;
  msg.writeInt32LE(u.exponent, o);
  o += 4;
  msg.writeBigInt64LE(BigInt(u.publishTime), o);
  o += 8;
  msg.writeBigInt64LE(BigInt(u.publishTime - 1), o);
  o += 8;
  msg.writeBigInt64LE(u.price, o);
  o += 8;
  msg.writeBigUInt64LE(u.conf ?? 0n, o);
  const postedSlot = Buffer.alloc(8);
  postedSlot.writeBigUInt64LE(1n);
  // Sponsored accounts are allocated for the 2-byte (Partial) level: a Full
  // update leaves one trailing zero byte.
  const pad = Buffer.alloc(u.partialSignatures === undefined ? 1 : 0);
  return Buffer.concat([
    PRICE_UPDATE_V2_DISCRIMINATOR,
    Buffer.alloc(32, 7),
    level,
    msg,
    postedSlot,
    pad,
  ]);
}

/**
 * `v · 10^exponent` at the `1e6` scale `BaseOracle` stores, rounded down —
 * `pyth.rs` `scale_to_1e6(v, exponent, false)`. `null` past `u64`.
 */
export function pythTo1e6(v: bigint, exponent: number): bigint | null {
  const shift = exponent + 6;
  const out = shift >= 0 ? v * 10n ** BigInt(shift) : v / 10n ** BigInt(-shift);
  return out >= 0n && out <= 0xffff_ffff_ffff_ffffn ? out : null;
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
