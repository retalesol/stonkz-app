import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  PRICE_UPDATE_V2_DISCRIMINATOR,
  PYTH_FEEDS,
  TOKEN_METADATA_PROGRAM_ID,
  anchorDiscriminator,
  decodePythPriceUpdateV2,
  deriveMetadataPda,
  derivePdas,
  deriveMintPda,
  encodePythPriceUpdateV2,
  pinnedPythFeedId,
  pythPriceFeedAccount,
  pythTo1e6,
} from './solana-idl.js';

/**
 * These byte arrays are the literal `discriminator` fields Anchor's IDL
 * generator produced for `programs/solana/programs/launchpad` (read once by
 * hand from `programs/solana/target/idl/launchpad.json` after a local
 * `anchor build` — see `solana-idl.ts`'s header for why that file itself is
 * not a runtime dependency). If any of these four ever change, either the
 * Rust instruction was renamed — and this file's seeds/encoders need a fresh
 * look — or `anchorDiscriminator` broke.
 */
const KNOWN_DISCRIMINATORS: Record<string, number[]> = {
  create_token: [84, 52, 204, 228, 24, 140, 234, 75],
  buy: [102, 6, 61, 18, 1, 218, 235, 234],
  sell: [51, 230, 133, 164, 1, 127, 131, 173],
  claim_creator_fees: [0, 23, 125, 234, 156, 118, 134, 89],
  stake: [206, 176, 202, 18, 200, 209, 179, 108],
  unstake: [90, 95, 107, 42, 205, 124, 50, 225],
  claim_stake: [62, 145, 133, 242, 244, 59, 53, 139],
  sync_price_from_pyth: [246, 192, 23, 109, 3, 214, 88, 150],
};

describe('anchorDiscriminator', () => {
  it('matches every discriminator Anchor generated for the launchpad IDL', () => {
    for (const [name, bytes] of Object.entries(KNOWN_DISCRIMINATORS)) {
      expect([...anchorDiscriminator(name)]).toEqual(bytes);
    }
  });

  it('is deterministic and 8 bytes long', () => {
    const a = anchorDiscriminator('buy');
    const b = anchorDiscriminator('buy');
    expect(a).toEqual(b);
    expect(a).toHaveLength(8);
  });
});

describe('derivePdas', () => {
  const programId = new PublicKey('FF1f3V47FtApwWWMHX462Gm7NVqNpUJ7K4yqKrYGSMbg');
  const mint = new PublicKey('So11111111111111111111111111111111111111112');
  const baseMint = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

  it('derives distinct, deterministic PDAs for every vault', () => {
    const first = derivePdas(programId, mint, baseMint);
    const second = derivePdas(programId, mint, baseMint);
    expect(first.curve.toBase58()).toBe(second.curve.toBase58());

    const addresses = Object.values(first).map((k) => k.toBase58());
    expect(new Set(addresses).size).toBe(addresses.length);
  });

  it('scopes protocol/ops vaults to the base mint, not the launched mint', () => {
    const other = derivePdas(
      programId,
      new PublicKey('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'),
      baseMint,
    );
    const first = derivePdas(programId, mint, baseMint);
    // Two different coins on the same base mint share a treasury, by design.
    expect(other.protocolVault.toBase58()).toBe(first.protocolVault.toBase58());
    expect(other.opsVault.toBase58()).toBe(first.opsVault.toBase58());
    // But never the per-coin curve/vaults.
    expect(other.curve.toBase58()).not.toBe(first.curve.toBase58());
  });

  it('derives the program-wide params PDA from the seed alone', () => {
    const first = derivePdas(programId, mint, baseMint);
    const other = derivePdas(
      programId,
      new PublicKey('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'),
      new PublicKey('So11111111111111111111111111111111111111112'),
    );
    expect(other.params.toBase58()).toBe(first.params.toBase58());
    expect(first.params.toBase58()).toBe(
      PublicKey.findProgramAddressSync([Buffer.from('params')], programId)[0].toBase58(),
    );
  });
});

describe('deriveMintPda', () => {
  it('is seeded on creator + salt, so the same ticker can mint twice', () => {
    const programId = new PublicKey('FF1f3V47FtApwWWMHX462Gm7NVqNpUJ7K4yqKrYGSMbg');
    const creator = new PublicKey('So11111111111111111111111111111111111111112');
    const other = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    const [a] = deriveMintPda(programId, creator, 1n);
    const [b] = deriveMintPda(programId, creator, 1n);
    const [c] = deriveMintPda(programId, creator, 2n);
    const [d] = deriveMintPda(programId, other, 1n);
    expect(a.toBase58()).toBe(b.toBase58());
    expect(a.toBase58()).not.toBe(c.toBase58());
    expect(a.toBase58()).not.toBe(d.toBase58());
  });
});

describe('deriveMetadataPda', () => {
  it("matches Metaplex's real metadata account for USDC", () => {
    // Same vector as `metadata_pda_matches_the_mainnet_usdc_metadata_account`
    // in programs/solana/programs/launchpad/src/tests.rs.
    const usdc = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(deriveMetadataPda(usdc)[0].toBase58()).toBe(
      '5x38Kp4hvdomTCnCrAny4UtMUt5rQBdB6px2K1Ui45Wq',
    );
    expect(TOKEN_METADATA_PROGRAM_ID.toBase58()).toBe(
      'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
    );
  });
});

describe('Pyth PriceUpdateV2', () => {
  const SOL_USD = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
  /** Real devnet `7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE`, fetched 2026-09-29 (same vector as `pyth.rs`). */
  const DEVNET_SOL_USD =
    'IvEjY51+9M1gMUcENA3t3zcf1CRyFI8kjp0abRpesqw6zYt/1dayQwHvDYtv2izrpB2hXUCV0do5Kg0vjtDGx7wPTPrIwoC1bS3zG8QCAAAA6pEJAAAAAAD4////J/66agAAAAAm/rpqAAAAAPJCtcICAAAAwtcTAAAAAACbxh4eAAAAAAA=';

  it('pins the same feeds as the program and derives the sponsored feed accounts', () => {
    expect(PYTH_FEEDS).toEqual({
      So11111111111111111111111111111111111111112: SOL_USD,
      EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:
        'eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
      Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB:
        '2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b',
    });
    const wsol = new PublicKey('So11111111111111111111111111111111111111112');
    expect(pinnedPythFeedId(wsol)!.toString('hex')).toBe(SOL_USD);
    expect(pinnedPythFeedId(new PublicKey('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'))).toBe(
      null,
    );
    expect(pythPriceFeedAccount(pinnedPythFeedId(wsol)!).toBase58()).toBe(
      '7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE',
    );
    expect([...PRICE_UPDATE_V2_DISCRIMINATOR]).toEqual([34, 241, 35, 99, 157, 126, 244, 205]);
  });

  it('decodes the real devnet SOL/USD account (Full verification, 1-byte level)', () => {
    const u = decodePythPriceUpdateV2(Buffer.from(DEVNET_SOL_USD, 'base64'))!;
    expect(u.fullyVerified).toBe(true);
    expect(u.feedId.toString('hex')).toBe(SOL_USD);
    expect(u.exponent).toBe(-8);
    expect(u.price).toBeGreaterThan(0n);
    expect(u.publishTime).toBeGreaterThan(1_700_000_000);
  });

  it('round-trips both verification-level encodings', () => {
    const feedId = Buffer.from(SOL_USD, 'hex');
    const base = { feedId, price: 15_012_345_678n, conf: 7n, exponent: -8, publishTime: 1_800 };
    const full = decodePythPriceUpdateV2(encodePythPriceUpdateV2(base))!;
    expect(full).toEqual({ fullyVerified: true, ...base });
    const partial = decodePythPriceUpdateV2(
      encodePythPriceUpdateV2({ ...base, partialSignatures: 5 }),
    )!;
    // Partial shifts every later field by one byte; decoded the same, flagged unverified.
    expect(partial).toEqual({ fullyVerified: false, ...base });
  });

  it('refuses anything that is not a PriceUpdateV2', () => {
    const good = encodePythPriceUpdateV2({
      feedId: Buffer.alloc(32, 1),
      price: 1n,
      exponent: -8,
      publishTime: 1,
    });
    const badDisc = Buffer.from(good);
    badDisc[0] ^= 1;
    expect(decodePythPriceUpdateV2(badDisc)).toBeNull();
    const badLevel = Buffer.from(good);
    badLevel[40] = 2;
    expect(decodePythPriceUpdateV2(badLevel)).toBeNull();
    expect(decodePythPriceUpdateV2(good.subarray(0, 100))).toBeNull();
    expect(decodePythPriceUpdateV2(Buffer.alloc(0))).toBeNull();
  });

  it('rescales to 1e6 the way the program does (floor)', () => {
    expect(pythTo1e6(15_012_345_678n, -8)).toBe(150_123_456n);
    expect(pythTo1e6(1_234n, -6)).toBe(1_234n);
    expect(pythTo1e6(3n, 2)).toBe(300_000_000n);
    expect(pythTo1e6(2n ** 63n, 0)).toBeNull();
  });
});
