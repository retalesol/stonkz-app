import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { anchorDiscriminator, derivePdas, deriveMintPda } from './solana-idl.js';

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
    const other = derivePdas(programId, new PublicKey('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'), baseMint);
    const first = derivePdas(programId, mint, baseMint);
    // Two different coins on the same base mint share a treasury, by design.
    expect(other.protocolVault.toBase58()).toBe(first.protocolVault.toBase58());
    expect(other.opsVault.toBase58()).toBe(first.opsVault.toBase58());
    // But never the per-coin curve/vaults.
    expect(other.curve.toBase58()).not.toBe(first.curve.toBase58());
  });
});

describe('deriveMintPda', () => {
  it('is seeded on the ticker, so the same ticker always predicts the same mint', () => {
    const programId = new PublicKey('FF1f3V47FtApwWWMHX462Gm7NVqNpUJ7K4yqKrYGSMbg');
    const [a] = deriveMintPda(programId, 'WOJAK');
    const [b] = deriveMintPda(programId, 'WOJAK');
    const [c] = deriveMintPda(programId, 'PEPE');
    expect(a.toBase58()).toBe(b.toBase58());
    expect(a.toBase58()).not.toBe(c.toBase58());
  });
});
