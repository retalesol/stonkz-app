import { describe, expect, it } from 'vitest';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type TransactionInstruction,
} from '@solana/web3.js';
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
import {
  buildCreateTokenInstruction,
  buildSyncPriceFromPythInstruction,
} from './solana-instructions.js';
import {
  TOKEN_METADATA_PROGRAM_ID,
  anchorDiscriminator,
  deriveMetadataPda,
  derivePdas,
  pinnedPythFeedId,
  pythPriceFeedAccount,
} from './solana-idl.js';
import { SolanaTransactionTooLargeError } from './errors.js';
import { stonkzLaunchAltAddresses, wireMessageBase64 } from './solana-alt.js';
import { syntheticJupiterRoute, syntheticLookupTable } from '../test/solana-alt-fixtures.js';

/** Solana's wire limit for one transaction (IPv6 MTU minus headers). */
const PACKET_DATA_SIZE = 1232;

const programId = new PublicKey('FF1f3V47FtApwWWMHX462Gm7NVqNpUJ7K4yqKrYGSMbg');
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const blockhash = { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 };
/** Sponsored Pyth push-feed accounts `sync_price_from_pyth` reads. */
const SOL_USD_FEED = pythPriceFeedAccount(pinnedPythFeedId(NATIVE_MINT)!);
const USDC_USD_FEED = pythPriceFeedAccount(pinnedPythFeedId(USDC)!);
const SYNC_DISC = anchorDiscriminator('sync_price_from_pyth');
const isSync = (ix: TransactionInstruction) => ix.data.subarray(0, 8).equals(SYNC_DISC);

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

/** Legacy or v0 — the instructions back, resolving any table lookups against `tables`. */
function decode(
  base64: string,
  tables: AddressLookupTableAccount[] = [],
): { version: 'legacy' | 0; instructions: TransactionInstruction[] } {
  const vtx = VersionedTransaction.deserialize(Buffer.from(base64, 'base64'));
  return {
    version: vtx.version,
    instructions: TransactionMessage.decompile(vtx.message, {
      addressLookupTableAccounts: tables,
    }).instructions,
  };
}

function limitsIn(tx: { instructions: TransactionInstruction[] }): number[] {
  return tx.instructions
    .filter((ix) => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 2)
    .map((ix) => ix.data.readUInt32LE(1));
}

function wireSize(base64: string): number {
  return Buffer.from(base64, 'base64').length;
}

describe('buildCreateTokenInstruction — Metaplex + params accounts', () => {
  it('appends the metadata PDA, the Metaplex program and the params PDA after the original 15 accounts', () => {
    const creator = Keypair.generate().publicKey;
    const { instruction, mint, metadata } = buildCreateTokenInstruction(
      { programId, creator, baseMint: USDC, salt: 7n },
      { ...maxArgs(), salt: 7n },
    );
    expect(instruction.keys).toHaveLength(18);
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
    // Runtime params PDA last, read-only (it may not exist on chain yet).
    expect(instruction.keys[17]).toEqual({
      pubkey: derivePdas(programId, mint, USDC).params,
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
    // Maximal metadata + native dev buy no longer fits legacy since the
    // runtime-params PDA joined create_token and buy (+34 bytes); it
    // compiles v0 against the operator table. See the wire-size report.
    const alt = syntheticLookupTable(stonkzLaunchAltAddresses(programId, [NATIVE_MINT]));
    const out = composeSolanaLaunchTransaction(
      composition({
        devBuy: { curveAmountIn: 1_000_000_000n, curveMinOut: 1n },
        lookupTables: [alt],
      }),
      blockhash,
    );
    const u = LAUNCH_COMPUTE_UNITS;
    const budget = u.createToken + 2 * u.ataCreate + u.nativeWrap + u.devBuy;
    const tx = decode(out.base64, [alt]);
    // No explicit limit: those ~41 bytes are what keeps a near-maximal launch in one legacy packet.
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
    // A Jupiter hop always compiles to v0, even with no tables to resolve.
    expect(tx.version).toBe(0);
    expect(out.version).toBe(0);
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
  it('fits one packet with the longest name/ticker/uri; a native dev buy on top needs the operator table', () => {
    const createOnly = wireSize(composeSolanaLaunchTransaction(composition(), blockhash).base64);
    expect(createOnly).toBeLessThanOrEqual(PACKET_DATA_SIZE);
    // 32-byte name + 200-byte uri + native dev buy: 1259 bytes legacy since the
    // runtime-params PDA was appended to create_token and buy (it was 1225, 7
    // under the packet). Without a lookup table that is a structured refusal...
    expect(() =>
      composeSolanaLaunchTransaction(
        composition({ devBuy: { curveAmountIn: 1n, curveMinOut: 1n } }),
        blockhash,
      ),
    ).toThrow(SolanaTransactionTooLargeError);
    // ...and with the operator table (which carries the params PDA) it is a
    // comfortable v0 message.
    const withBuy = composeSolanaLaunchTransaction(
      composition({
        devBuy: { curveAmountIn: 1n, curveMinOut: 1n },
        lookupTables: [syntheticLookupTable(stonkzLaunchAltAddresses(programId, [NATIVE_MINT]))],
      }),
      blockhash,
    );
    expect(withBuy.version).toBe(0);
    expect(wireSize(withBuy.base64)).toBeLessThanOrEqual(PACKET_DATA_SIZE);
    // A Pinata-length uri (113 bytes) with the longest name and a native dev
    // buy still fits legacy with no table at all.
    const pinata = composeSolanaLaunchTransaction(
      composition({
        createArgs: { ...maxArgs(), uri: `https://${'u'.repeat(105)}` },
        devBuy: { curveAmountIn: 1n, curveMinOut: 1n },
      }),
      blockhash,
    );
    expect(pinata.version).toBe('legacy');
    expect(wireSize(pinata.base64)).toBeLessThanOrEqual(PACKET_DATA_SIZE);
  });
});

describe('composeSolanaLaunchTransaction — v0 with address lookup tables', () => {
  const stonkzAlt = () =>
    syntheticLookupTable(stonkzLaunchAltAddresses(programId, [NATIVE_MINT, USDC]));

  /** A USDC-based launch with a Jupiter-routed dev buy over a realistic route. */
  function jupiterLaunch(opts: {
    uriLen: number;
    poolAccounts: number;
    withStonkzAlt: boolean;
    withJupiterAlts?: boolean;
    jupiterTables?: number;
    pythSync?: boolean;
  }) {
    const creator = Keypair.generate().publicKey;
    const route = syntheticJupiterRoute({
      user: creator,
      baseMint: USDC,
      poolAccounts: opts.poolAccounts,
      ...(opts.jupiterTables ? { tableCount: opts.jupiterTables } : {}),
    });
    const tables = [
      ...(opts.withJupiterAlts === false ? [] : route.tables),
      ...(opts.withStonkzAlt ? [stonkzAlt()] : []),
    ];
    const out = composeSolanaLaunchTransaction(
      composition({
        creator,
        baseMint: USDC,
        createArgs: { ...maxArgs(), uri: `https://${'u'.repeat(opts.uriLen - 8)}` },
        devBuy: {
          curveAmountIn: 1_000_000n,
          curveMinOut: 1n,
          jupiter: { response: route.response },
        },
        lookupTables: tables,
        ...(opts.pythSync ? { pythPriceUpdate: USDC_USD_FEED } : {}),
      }),
      blockhash,
    );
    return { out, route, tables, creator };
  }

  it('fits one packet with the default pinned-metadata URI and a 24-account, one-table route', () => {
    const { out, route, tables } = jupiterLaunch({
      uriLen: 113,
      poolAccounts: 15,
      jupiterTables: 1,
      withStonkzAlt: true,
    });
    expect(route.swapAccounts).toBe(24);
    expect(out.version).toBe(0);
    expect(out.bytes).toBe(wireSize(out.base64));
    expect(out.bytes).toBeLessThanOrEqual(PACKET_DATA_SIZE);

    const vtx = VersionedTransaction.deserialize(Buffer.from(out.base64, 'base64'));
    // Jupiter's two tables and the Stonkz table are all referenced.
    const used = vtx.message.addressTableLookups.map((l) => l.accountKey.toBase58()).sort();
    expect(used).toEqual(tables.map((t) => t.key.toBase58()).sort());
    // The fee payer is the one signer, and it and every invoked program stay static.
    expect(vtx.message.header.numRequiredSignatures).toBe(1);
    const statics = vtx.message.staticAccountKeys.map((k) => k.toBase58());
    for (const ix of vtx.message.compiledInstructions) {
      expect(ix.programIdIndex).toBeLessThan(statics.length);
    }
    expect(statics).toContain(programId.toBase58());
  });

  it("keeps the compute budget to one SetComputeUnitLimit and keeps Jupiter's price", () => {
    const { out, tables } = jupiterLaunch({ uriLen: 80, poolAccounts: 22, withStonkzAlt: true });
    const tx = decode(out.base64, tables);
    const u = LAUNCH_COMPUTE_UNITS;
    expect(limitsIn(tx)).toEqual([u.createToken + 2 * u.ataCreate + u.devBuy + 300_000]);
    const prices = tx.instructions.filter(
      (ix) => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 3,
    );
    expect(prices).toHaveLength(1);
    // Order: budget, base ATA, Jupiter setup/swap/cleanup, create_token, token ATA, buy.
    const createIdx = tx.instructions.findIndex((ix) =>
      ix.data.subarray(0, 8).equals(anchorDiscriminator('create_token')),
    );
    const buyIdx = tx.instructions.findIndex((ix) =>
      ix.data.subarray(0, 8).equals(anchorDiscriminator('buy')),
    );
    const swapIdx = tx.instructions.findIndex(
      (ix) => ix.programId.toBase58() === 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
    );
    expect(swapIdx).toBeGreaterThan(0);
    expect(createIdx).toBeGreaterThan(swapIdx);
    expect(buyIdx).toBe(tx.instructions.length - 1);
    // The decompiled create_token still names all 18 accounts, table-loaded or not.
    expect(tx.instructions[createIdx]!.keys).toHaveLength(18);
  });

  it('stores the v0 message verbatim, lookups included, and /launch/confirm re-derives it from the wire', () => {
    const { out } = jupiterLaunch({ uriLen: 80, poolAccounts: 20, withStonkzAlt: true });
    const message = Buffer.from(out.messageBase64, 'base64');
    // Version prefix: high bit set, version 0.
    expect(message[0]).toBe(0x80);
    expect(wireMessageBase64(Buffer.from(out.base64, 'base64'))).toBe(out.messageBase64);
  });

  it('reports wire sizes (legacy before, v0 after) for the rollout notes', () => {
    const sizes: Record<string, number> = {};
    const measure = (f: () => { bytes: number }): number => {
      try {
        return f().bytes;
      } catch (e) {
        if (e instanceof SolanaTransactionTooLargeError && e.bytes !== null) return e.bytes;
        throw e;
      }
    };
    // 113 = the default Pinata gateway URL + a CIDv1 (`https://…mypinata.cloud/ipfs/bafkrei…`).
    for (const uriLen of [200, 113, 80]) {
      for (const swapAccounts of [20, 24, 30]) {
        for (const jupiterTables of [1, 2]) {
          const key = `uri${uriLen}_swap${swapAccounts}_jt${jupiterTables}`;
          const run = (withStonkzAlt: boolean, withJupiterAlts = true) =>
            measure(
              () =>
                jupiterLaunch({
                  uriLen,
                  poolAccounts: swapAccounts - 9,
                  jupiterTables,
                  withStonkzAlt,
                  withJupiterAlts,
                }).out,
            );
          sizes[`${key}_noTables`] = run(false, false);
          sizes[`${key}_jupAlts`] = run(false);
          sizes[`${key}_jupAlts+stonkzAlt`] = run(true);
          sizes[`${key}_pythSync_jupAlts+stonkzAlt`] = measure(
            () =>
              jupiterLaunch({
                uriLen,
                poolAccounts: swapAccounts - 9,
                jupiterTables,
                withStonkzAlt: true,
                pythSync: true,
              }).out,
          );
        }
      }
    }
    console.info('solana launch v0 tx sizes (bytes):', JSON.stringify(sizes));
    for (const swapAccounts of [20, 24]) {
      // Default pinned metadata, a route within LAUNCH_JUPITER_MAX_ACCOUNTS: fits.
      expect(sizes[`uri113_swap${swapAccounts}_jt1_jupAlts+stonkzAlt`]).toBeLessThanOrEqual(
        PACKET_DATA_SIZE,
      );
      // Without any table the same launch is hundreds of bytes over.
      expect(sizes[`uri113_swap${swapAccounts}_jt1_noTables`]).toBeGreaterThan(
        PACKET_DATA_SIZE + 300,
      );
    }
    // A shorter URI leaves room for a 30-account, two-table route.
    expect(sizes['uri80_swap30_jt2_jupAlts+stonkzAlt']).toBeLessThanOrEqual(PACKET_DATA_SIZE);
    // The Pyth sync costs 18 bytes in v0 (the feed account comes from the
    // Stonkz table), so the default route shape still fits.
    for (const swapAccounts of [20, 24]) {
      const key = `uri113_swap${swapAccounts}_jt1`;
      expect(sizes[`${key}_pythSync_jupAlts+stonkzAlt`]).toBe(
        sizes[`${key}_jupAlts+stonkzAlt`]! + 18,
      );
      expect(sizes[`${key}_pythSync_jupAlts+stonkzAlt`]).toBeLessThanOrEqual(PACKET_DATA_SIZE);
    }
    // Each table actually saves bytes.
    expect(sizes['uri113_swap24_jt1_jupAlts+stonkzAlt']).toBeLessThan(
      sizes['uri113_swap24_jt1_jupAlts']!,
    );
  });

  it('a no-Jupiter launch stays legacy even when tables are available, going v0 only when legacy cannot fit', () => {
    const out = composeSolanaLaunchTransaction(
      composition({
        // Longest name, Pinata-length uri: fits legacy, so the table is unused.
        createArgs: { ...maxArgs(), uri: `https://${'u'.repeat(105)}` },
        devBuy: { curveAmountIn: 1n, curveMinOut: 1n },
        lookupTables: [stonkzAlt()],
      }),
      blockhash,
    );
    expect(out.version).toBe('legacy');
    expect(decode(out.base64).version).toBe('legacy');
    // The maximal uri on top is 27 bytes over legacy: the same table turns it into v0.
    const maximal = composeSolanaLaunchTransaction(
      composition({
        devBuy: { curveAmountIn: 1n, curveMinOut: 1n },
        lookupTables: [stonkzAlt()],
      }),
      blockhash,
    );
    expect(maximal.version).toBe(0);
  });

  it('throws a structured error, not a raw one, when even v0 cannot fit', () => {
    expect(() =>
      jupiterLaunch({ uriLen: 200, poolAccounts: 60, withStonkzAlt: true, withJupiterAlts: false }),
    ).toThrow(SolanaTransactionTooLargeError);
  });
});

describe('composeSolanaLaunchTransaction — Pyth price sync', () => {
  const stonkzAlt = () =>
    syntheticLookupTable(stonkzLaunchAltAddresses(programId, [NATIVE_MINT, USDC]));

  it('opens the transaction with sync_price_from_pyth, paid by the creator', () => {
    const creator = Keypair.generate().publicKey;
    const out = composeSolanaLaunchTransaction(
      composition({
        creator,
        // The common case: 20-byte name, default Pinata URI (113 bytes).
        createArgs: { ...maxArgs(), name: 'N'.repeat(20), uri: `https://${'u'.repeat(105)}` },
        devBuy: { curveAmountIn: 1_000_000_000n, curveMinOut: 1n },
        pythPriceUpdate: SOL_USD_FEED,
      }),
      blockhash,
    );
    expect(out.version).toBe('legacy');
    const tx = decode(out.base64);
    const sync = tx.instructions[0]!;
    expect(isSync(sync)).toBe(true);
    expect(sync.data).toHaveLength(8);
    expect(sync.programId.equals(programId)).toBe(true);
    const pdas = derivePdas(programId, PublicKey.default, NATIVE_MINT);
    const want = [
      { pubkey: pdas.global, isSigner: false, isWritable: false },
      { pubkey: pdas.oracle, isSigner: false, isWritable: true },
      { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: SOL_USD_FEED, isSigner: false, isWritable: false },
      { pubkey: creator, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];
    // The builder's own metas, exactly (`SyncPriceFromPyth`'s account order)...
    expect(
      buildSyncPriceFromPythInstruction({
        programId,
        baseMint: NATIVE_MINT,
        priceUpdate: SOL_USD_FEED,
        payer: creator,
      }).keys,
    ).toEqual(want);
    // ...and the same accounts in the composed message (a legacy message
    // merges writability across instructions, e.g. `global` for create_token).
    expect(sync.keys.map((k) => k.pubkey.toBase58())).toEqual(want.map((k) => k.pubkey.toBase58()));
    expect(sync.keys[4]!.isSigner).toBe(true);
    // Before create_token, which reads the BaseOracle the sync just wrote.
    const createIdx = tx.instructions.findIndex((ix) =>
      ix.data.subarray(0, 8).equals(anchorDiscriminator('create_token')),
    );
    expect(createIdx).toBeGreaterThan(0);
    expect(tx.instructions.filter(isSync)).toHaveLength(1);
    // The sync's 200k implicit share covers its own budget: still no limit ix.
    expect(limitsIn(tx)).toEqual([]);
    const u = LAUNCH_COMPUTE_UNITS;
    expect(out.computeUnitLimit).toBeGreaterThanOrEqual(
      u.pythSync + u.createToken + 2 * u.ataCreate + u.nativeWrap + u.devBuy,
    );
  });

  it('create-only: the sync makes the explicit limit unnecessary (implicit 400k)', () => {
    const out = composeSolanaLaunchTransaction(
      composition({ pythPriceUpdate: SOL_USD_FEED }),
      blockhash,
    );
    const tx = decode(out.base64);
    expect(tx.instructions.map(isSync)).toEqual([true, false]);
    expect(limitsIn(tx)).toEqual([]);
    expect(out.computeUnitLimit).toBe(400_000);
    expect(out.computeUnitLimit).toBeGreaterThanOrEqual(
      LAUNCH_COMPUTE_UNITS.pythSync + LAUNCH_COMPUTE_UNITS.createToken,
    );
  });

  it('without a price update the composition is unchanged (no sync)', () => {
    const c = composition({
      createArgs: { ...maxArgs(), uri: `https://${'u'.repeat(105)}` },
      devBuy: { curveAmountIn: 1n, curveMinOut: 1n },
    });
    const a = composeSolanaLaunchTransaction(c, blockhash);
    expect(decode(a.base64).instructions.some(isSync)).toBe(false);
    expect(launchComputeUnitLimit({ devBuy: true, nativeWrap: true, pythSync: false })).toBe(
      launchComputeUnitLimit({ devBuy: true, nativeWrap: true }),
    );
  });

  it("Jupiter hop: the sync's units are folded into the one explicit limit", () => {
    const hop = jupiterHop(0, [setLimitIx(300_000), setPriceIx(1_000)]);
    const out = composeSolanaLaunchTransaction(
      composition({
        baseMint: USDC,
        createArgs: { ...maxArgs(), name: 'N', uri: '' },
        devBuy: { curveAmountIn: 1_000_000n, curveMinOut: 1n, jupiter: hop },
        pythPriceUpdate: USDC_USD_FEED,
      }),
      blockhash,
    );
    const tx = decode(out.base64);
    const u = LAUNCH_COMPUTE_UNITS;
    expect(limitsIn(tx)).toEqual([
      u.pythSync + u.createToken + 2 * u.ataCreate + u.devBuy + 300_000,
    ]);
    const syncIdx = tx.instructions.findIndex(isSync);
    const swapIdx = tx.instructions.findIndex(
      (ix) => ix.programId.toBase58() === 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
    );
    expect(syncIdx).toBeGreaterThan(0);
    expect(syncIdx).toBeLessThan(swapIdx);
    expect(tx.instructions[syncIdx]!.keys[3]!.pubkey.equals(USDC_USD_FEED)).toBe(true);
  });

  it('reports legacy sizes with the sync, and the ALT fallback for the worst case', () => {
    const measure = (f: () => { bytes: number; version: 'legacy' | 0 }): string => {
      try {
        const r = f();
        return `${r.version}:${r.bytes}`;
      } catch (e) {
        if (e instanceof SolanaTransactionTooLargeError) return `over:${e.bytes}`;
        throw e;
      }
    };
    const run = (o: { name: number; uri: number; devBuy: boolean; sync: boolean; alt: boolean }) =>
      measure(() =>
        composeSolanaLaunchTransaction(
          composition({
            createArgs: {
              ...maxArgs(),
              name: 'N'.repeat(o.name),
              uri: `https://${'u'.repeat(o.uri - 8)}`,
            },
            ...(o.devBuy ? { devBuy: { curveAmountIn: 1n, curveMinOut: 1n } } : {}),
            ...(o.sync ? { pythPriceUpdate: SOL_USD_FEED } : {}),
            ...(o.alt ? { lookupTables: [stonkzAlt()] } : {}),
          }),
          blockhash,
        ),
      );
    const sizes: Record<string, string> = {};
    // 113 = default Pinata gateway + CIDv1; 200 = the program's uri maximum.
    for (const [name, uri] of [
      [32, 200],
      [20, 200],
      [32, 113],
      [20, 113],
      [20, 150],
    ] as const) {
      for (const devBuy of [false, true]) {
        const key = `name${name}_uri${uri}_${devBuy ? 'nativeBuy' : 'createOnly'}`;
        sizes[`${key}_noSync`] = run({ name, uri, devBuy, sync: false, alt: false });
        sizes[`${key}_sync`] = run({ name, uri, devBuy, sync: true, alt: false });
        sizes[`${key}_sync+stonkzAlt`] = run({ name, uri, devBuy, sync: true, alt: true });
      }
    }
    console.info('solana launch legacy tx sizes with Pyth sync:', JSON.stringify(sizes));

    // The worst case (32-byte name, 200-byte uri, native dev buy) is 27 bytes
    // over legacy on its own: it was 1225 (7 to spare) until the runtime-params
    // PDA was appended to create_token and buy (+32-byte key, +2 index bytes)...
    expect(sizes['name32_uri200_nativeBuy_noSync']).toBe('over:1259');
    // ...and the sync costs a further 49 bytes (one 32-byte key + a 17-byte instruction),
    expect(sizes['name32_uri200_nativeBuy_sync']).toBe('over:1308');
    // so the worst case needs the operator ALT (which holds the params PDA), and fits with it (v0).
    expect(sizes['name32_uri200_nativeBuy_sync+stonkzAlt']).toMatch(/^0:/);
    expect(sizes['name32_uri200_nativeBuy_noSync']).toBe(sizes['name32_uri200_nativeBuy_noSync']);
    expect(
      Number(sizes['name32_uri200_nativeBuy_sync+stonkzAlt']!.split(':')[1]),
    ).toBeLessThanOrEqual(PACKET_DATA_SIZE);
    // The common case (name <= 20, Pinata URI, native dev buy) stays legacy
    // without any table.
    expect(sizes['name20_uri113_nativeBuy_sync']).toMatch(/^legacy:/);
    expect(sizes['name20_uri113_nativeBuy_sync+stonkzAlt']).toBe(
      sizes['name20_uri113_nativeBuy_sync'],
    );
    // Legacy with the sync and a native dev buy fits while name + ticker +
    // uri stay within ~166 bytes (the 200-byte margin before the params PDA,
    // less its 34 bytes): a 20-byte name with a 150-byte uri is now 14 over
    // and goes v0 through the table, while the longest name with a Pinata uri
    // (32 + 10 + 113) still fits with 11 to spare.
    expect(sizes['name20_uri150_nativeBuy_sync']).toBe('over:1246');
    expect(sizes['name20_uri150_nativeBuy_noSync']).toBe('legacy:1197');
    expect(sizes['name32_uri113_nativeBuy_sync']).toBe('legacy:1221');
    // Create-only drops the explicit compute limit (41 bytes) for the sync.
    expect(sizes['name32_uri200_createOnly_sync']).toMatch(/^legacy:/);
    for (const [k, v] of Object.entries(sizes)) {
      if (k.endsWith('+stonkzAlt')) expect(v, k).not.toMatch(/^over/);
    }
  });
});
