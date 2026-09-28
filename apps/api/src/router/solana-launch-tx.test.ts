import { describe, expect, it } from 'vitest';
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import type { JupiterInstruction } from './jupiter.js';
import type { JupiterHop } from './solana-tx.js';
import {
  LAUNCH_COMPUTE_UNITS,
  MAX_TRANSACTION_COMPUTE_UNITS,
  composeSolanaLaunchTransaction,
  implicitComputeUnitLimit,
  launchComputeUnitLimit,
  type SolanaLaunchComposition,
} from './solana-launch-tx.js';
import { buildCreateTokenInstruction } from './solana-instructions.js';
import { TOKEN_METADATA_PROGRAM_ID, deriveMetadataPda } from './solana-idl.js';

/** Solana's wire limit for one transaction (IPv6 MTU minus headers). */
const PACKET_DATA_SIZE = 1232;

const programId = new PublicKey('FF1f3V47FtApwWWMHX462Gm7NVqNpUJ7K4yqKrYGSMbg');
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const blockhash = { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 };

/** Longest create args the program accepts: 32-byte name, 10-byte ticker, 200-byte uri. */
function maxArgs() {
  return {
    name: 'N'.repeat(32),
    ticker: 'T'.repeat(10),
    uri: `https://${'u'.repeat(192)}`,
    supply: 1_000_000_000n,
    feeBps: 100,
    cashback: false,
    salt: 1_790_000_000n,
  };
}

function composition(overrides: Partial<SolanaLaunchComposition> = {}): SolanaLaunchComposition {
  return {
    programId,
    creator: Keypair.generate().publicKey,
    baseMint: NATIVE_MINT,
    createArgs: maxArgs(),
    ...overrides,
  };
}

function setLimitIx(units: number): JupiterInstruction {
  const ix = ComputeBudgetProgram.setComputeUnitLimit({ units });
  return {
    programId: ix.programId.toBase58(),
    accounts: [],
    data: ix.data.toString('base64'),
  };
}

function setPriceIx(microLamports: number): JupiterInstruction {
  const ix = ComputeBudgetProgram.setComputeUnitPrice({ microLamports });
  return {
    programId: ix.programId.toBase58(),
    accounts: [],
    data: ix.data.toString('base64'),
  };
}

/** A Jupiter hop whose swap touches `accounts` fresh keys (no ALT). */
function jupiterHop(accounts: number, budget: JupiterInstruction[]): JupiterHop {
  return {
    response: {
      computeBudgetInstructions: budget,
      setupInstructions: [],
      swapInstruction: {
        programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
        accounts: Array.from({ length: accounts }, () => ({
          pubkey: Keypair.generate().publicKey.toBase58(),
          isSigner: false,
          isWritable: true,
        })),
        data: Buffer.alloc(24).toString('base64'),
      },
      addressLookupTableAddresses: [],
    },
  } as JupiterHop;
}

function decode(base64: string): Transaction {
  return Transaction.from(Buffer.from(base64, 'base64'));
}

function limitsIn(tx: Transaction): number[] {
  return tx.instructions
    .filter((ix) => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 2)
    .map((ix) => ix.data.readUInt32LE(1));
}

function wireSize(base64: string): number {
  return Buffer.from(base64, 'base64').length;
}

describe('buildCreateTokenInstruction — Metaplex accounts', () => {
  it('appends the metadata PDA and the Metaplex program after the original 15 accounts', () => {
    const creator = Keypair.generate().publicKey;
    const { instruction, mint, metadata } = buildCreateTokenInstruction(
      { programId, creator, baseMint: USDC, salt: 7n },
      { ...maxArgs(), salt: 7n },
    );
    expect(instruction.keys).toHaveLength(17);
    // Original layout untouched: creator stays at index 11.
    expect(instruction.keys[11]!.pubkey.equals(creator)).toBe(true);
    expect(instruction.keys[11]!.isSigner).toBe(true);

    const [expected] = deriveMetadataPda(mint);
    expect(metadata.equals(expected)).toBe(true);
    expect(instruction.keys[15]).toEqual({ pubkey: expected, isSigner: false, isWritable: true });
    expect(instruction.keys[16]).toEqual({
      pubkey: TOKEN_METADATA_PROGRAM_ID,
      isSigner: false,
      isWritable: false,
    });
  });
});

describe('composeSolanaLaunchTransaction — compute budget', () => {
  it('create-only: one SetComputeUnitLimit for create_token + Metaplex', () => {
    const out = composeSolanaLaunchTransaction(composition(), blockhash);
    const tx = decode(out.base64);
    // Implicit default for one instruction (200k) is under the create budget.
    expect(implicitComputeUnitLimit([tx.instructions[1]!])).toBeLessThan(
      LAUNCH_COMPUTE_UNITS.createToken,
    );
    expect(limitsIn(tx)).toEqual([LAUNCH_COMPUTE_UNITS.createToken]);
    expect(out.computeUnitLimit).toBe(LAUNCH_COMPUTE_UNITS.createToken);
    expect(out.metadata.equals(deriveMetadataPda(out.mint)[0])).toBe(true);
  });

  it('native dev buy: the implicit default already covers the budget, so no limit ix', () => {
    const out = composeSolanaLaunchTransaction(
      composition({ devBuy: { curveAmountIn: 1_000_000_000n, curveMinOut: 1n } }),
      blockhash,
    );
    const u = LAUNCH_COMPUTE_UNITS;
    const budget = u.createToken + 2 * u.ataCreate + u.nativeWrap + u.devBuy;
    const tx = decode(out.base64);
    // No explicit limit: those ~41 bytes are what keeps a maximal launch in one packet.
    expect(limitsIn(tx)).toEqual([]);
    // ATA, transfer (builtin), SyncNative, create_token, ATA, buy.
    expect(implicitComputeUnitLimit(tx.instructions)).toBe(5 * 200_000 + 3_000);
    expect(out.computeUnitLimit).toBe(5 * 200_000 + 3_000);
    expect(out.computeUnitLimit).toBeGreaterThanOrEqual(budget);
  });

  it("Jupiter hop: folds Jupiter's limit into one instruction, keeps its price", () => {
    const hop = jupiterHop(0, [setLimitIx(300_000), setPriceIx(1_000)]);
    const out = composeSolanaLaunchTransaction(
      composition({
        baseMint: USDC,
        // Short metadata: a legacy (no-ALT) Jupiter launch only fits one
        // packet with a near-empty route — see the wire-size report below.
        createArgs: { ...maxArgs(), name: 'N', uri: '' },
        devBuy: { curveAmountIn: 1_000_000n, curveMinOut: 1n, jupiter: hop },
      }),
      blockhash,
    );
    const tx = decode(out.base64);
    const u = LAUNCH_COMPUTE_UNITS;
    const want = u.createToken + 2 * u.ataCreate + u.devBuy + 300_000;
    // Exactly one limit: two would be rejected by the runtime.
    expect(limitsIn(tx)).toEqual([want]);
    const prices = tx.instructions.filter(
      (ix) => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 3,
    );
    expect(prices).toHaveLength(1);
  });

  it('Jupiter hop with no compute-budget instructions at all still composes', () => {
    const out = composeSolanaLaunchTransaction(
      composition({
        baseMint: USDC,
        createArgs: { ...maxArgs(), name: 'N', uri: '' },
        devBuy: { curveAmountIn: 1_000_000n, curveMinOut: 1n, jupiter: jupiterHop(0, []) },
      }),
      blockhash,
    );
    const tx = decode(out.base64);
    // Implicit default (ATA, swap, create_token, ATA, buy) already covers the budget.
    expect(limitsIn(tx)).toEqual([]);
    expect(out.computeUnitLimit).toBe(1_000_000);
  });

  it('Jupiter hop without its own limit falls back, and the total is capped', () => {
    expect(launchComputeUnitLimit({ devBuy: true, nativeWrap: false, jupiterUnits: null })).toBe(
      LAUNCH_COMPUTE_UNITS.createToken +
        2 * LAUNCH_COMPUTE_UNITS.ataCreate +
        LAUNCH_COMPUTE_UNITS.devBuy +
        LAUNCH_COMPUTE_UNITS.jupiterFallback,
    );
    expect(
      launchComputeUnitLimit({ devBuy: true, nativeWrap: false, jupiterUnits: 1_400_000 }),
    ).toBe(MAX_TRANSACTION_COMPUTE_UNITS);
  });
});

describe('composeSolanaLaunchTransaction — wire size', () => {
  it('fits one packet with the longest name/ticker/uri, with and without a native dev buy', () => {
    const createOnly = wireSize(composeSolanaLaunchTransaction(composition(), blockhash).base64);
    const withBuy = wireSize(
      composeSolanaLaunchTransaction(
        composition({ devBuy: { curveAmountIn: 1n, curveMinOut: 1n } }),
        blockhash,
      ).base64,
    );
    expect(createOnly).toBeLessThanOrEqual(PACKET_DATA_SIZE);
    expect(withBuy).toBeLessThanOrEqual(PACKET_DATA_SIZE);
  });

  it('reports the Jupiter-hop headroom (legacy message, no ALT)', () => {
    const sizes: Record<string, number> = {};
    // web3.js refuses to serialize past 1232 bytes; recover the size it reports.
    const sized = (f: () => string): number => {
      try {
        return wireSize(f());
      } catch (e) {
        const m = /Transaction too large: (\d+)/.exec(String(e));
        if (!m) throw e;
        return Number(m[1]);
      }
    };
    const build = (uriLen: number, jupAccounts: number) =>
      sized(
        () =>
          composeSolanaLaunchTransaction(
            composition({
              baseMint: USDC,
              createArgs: { ...maxArgs(), uri: `https://${'u'.repeat(uriLen - 8)}` },
              devBuy: {
                curveAmountIn: 1n,
                curveMinOut: 1n,
                jupiter: jupiterHop(jupAccounts, [setLimitIx(300_000), setPriceIx(1)]),
              },
            }),
            blockhash,
          ).base64,
      );
    for (const uriLen of [200, 80]) {
      for (const n of [0, 4, 8, 16]) sizes[`uri${uriLen}_jup${n}`] = build(uriLen, n);
    }
    // Recorded for the rollout notes; the assertion is only that the numbers
    // move the way the byte accounting says they must.
    console.info('solana launch tx sizes (bytes):', JSON.stringify(sizes));
    expect(sizes['uri200_jup4']! - sizes['uri200_jup0']!).toBeGreaterThanOrEqual(4 * 33);
  });
});
