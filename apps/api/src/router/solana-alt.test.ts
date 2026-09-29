import { describe, expect, it } from 'vitest';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import { SolanaRpc } from '../chain/solana.js';
import type { FetchLike } from '../chain/types.js';
import {
  encodeLookupTableAccount,
  syntheticJupiterRoute,
  syntheticLookupTable,
} from '../test/solana-alt-fixtures.js';
import { SolanaTransactionTooLargeError } from './errors.js';
import {
  PACKET_DATA_SIZE,
  compileSolanaTransaction,
  composeWithLookupTables,
  fetchAddressLookupTables,
  stonkzLaunchAltAddresses,
  v0WireSize,
  wireMessageBase64,
} from './solana-alt.js';
import { composeSolanaTradeTransaction } from './solana-tx.js';
import {
  PYTH_PUSH_ORACLE_PROGRAM_ID,
  PYTH_RECEIVER_PROGRAM_ID,
  pinnedPythFeedId,
  pythPriceFeedAccount,
} from './solana-idl.js';

const programId = new PublicKey('FF1f3V47FtApwWWMHX462Gm7NVqNpUJ7K4yqKrYGSMbg');
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const blockhash = { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 9 };

/** A source serving raw account bytes, recording every read. */
function accountSource(accounts: Record<string, Buffer | null>) {
  const reads: string[] = [];
  return {
    reads,
    async getAccountDataBase64(address: string): Promise<string | null> {
      reads.push(address);
      const data = accounts[address];
      return data ? data.toString('base64') : null;
    },
  };
}

/** An instruction naming `n` fresh writable accounts — bulk for size tests. */
function wideIx(payer: PublicKey, keys: PublicKey[]): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      ...keys.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
    ],
    data: Buffer.alloc(8),
  });
}

function rpcReplying(reply: unknown): FetchLike {
  return async () =>
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, ...(reply as object) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
}

describe('fetchAddressLookupTables', () => {
  it('decodes live tables and skips missing, malformed and deactivated ones', async () => {
    const addrs = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    const live = Keypair.generate().publicKey.toBase58();
    const missing = Keypair.generate().publicKey.toBase58();
    const garbage = Keypair.generate().publicKey.toBase58();
    const deactivated = Keypair.generate().publicKey.toBase58();
    const dead = encodeLookupTableAccount(addrs);
    dead.writeBigUInt64LE(5n, 4);
    const src = accountSource({
      [live]: encodeLookupTableAccount(addrs, Keypair.generate().publicKey),
      [garbage]: Buffer.from('not a table'),
      [deactivated]: dead,
    });
    const skipped: string[] = [];
    const tables = await fetchAddressLookupTables(
      src,
      [live, missing, garbage, deactivated, live],
      (a) => skipped.push(a),
    );
    expect(tables).toHaveLength(1);
    expect(tables[0]!.key.toBase58()).toBe(live);
    expect(tables[0]!.state.addresses.map((a) => a.toBase58())).toEqual(
      addrs.map((a) => a.toBase58()),
    );
    expect(skipped.sort()).toEqual([missing, garbage, deactivated].sort());
    // Duplicates are read once.
    expect(src.reads.filter((r) => r === live)).toHaveLength(1);
  });
});

describe('stonkzLaunchAltAddresses', () => {
  it('holds the shared accounts once each, never a per-launch one', () => {
    const list = stonkzLaunchAltAddresses(programId, [NATIVE_MINT, USDC, NATIVE_MINT]);
    const s = list.map((k) => k.toBase58());
    expect(new Set(s).size).toBe(s.length);
    // 6 shared + global + 5 per base (the WSOL mint appears once) + each
    // base's pinned Pyth push-feed account.
    expect(list).toHaveLength(6 + 5 + 4 + 2);
    expect(s).toContain('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
    expect(s).toContain(USDC.toBase58());
    // Sponsored SOL/USD feed (same address on devnet and mainnet).
    expect(s).toContain('7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE');
    expect(s).toContain(pythPriceFeedAccount(pinnedPythFeedId(USDC)!).toBase58());
    // The Pyth programs are never named by a launch, so they take no slot.
    expect(s).not.toContain(PYTH_RECEIVER_PROGRAM_ID.toBase58());
    expect(s).not.toContain(PYTH_PUSH_ORACLE_PROGRAM_ID.toBase58());
  });

  it('adds no Pyth account for a base mint with no pinned feed', () => {
    const bonk = new PublicKey('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
    expect(pinnedPythFeedId(bonk)).toBeNull();
    const withBonk = stonkzLaunchAltAddresses(programId, [NATIVE_MINT, bonk]);
    // 6 shared + WSOL's 4 PDAs + its feed + BONK's mint and 4 PDAs.
    expect(withBonk).toHaveLength(6 + 4 + 1 + 5);
  });
});

describe('compileSolanaTransaction', () => {
  const payer = Keypair.generate().publicKey;

  it('stays legacy when it fits, byte-identical to a plain Transaction', () => {
    const ix = SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 });
    const out = compileSolanaTransaction({
      payer,
      ...blockhash,
      instructions: [ix],
      lookupTables: [syntheticLookupTable([SystemProgram.programId])],
    });
    const plain = new Transaction({ feePayer: payer, ...blockhash }).add(ix);
    expect(out.version).toBe('legacy');
    expect(out.base64).toBe(
      plain.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
    );
    expect(out.messageBase64).toBe(plain.compileMessage().serialize().toString('base64'));
  });

  it('falls back to v0 when the legacy form would exceed the packet and a table helps', () => {
    const keys = Array.from({ length: 40 }, () => Keypair.generate().publicKey);
    const table = syntheticLookupTable(keys);
    const out = compileSolanaTransaction({
      payer,
      ...blockhash,
      instructions: [wideIx(payer, keys)],
      lookupTables: [table],
    });
    expect(out.version).toBe(0);
    expect(out.bytes).toBeLessThanOrEqual(PACKET_DATA_SIZE);
    const vtx = VersionedTransaction.deserialize(Buffer.from(out.base64, 'base64'));
    expect(vtx.message.addressTableLookups[0]!.accountKey.equals(table.key)).toBe(true);
    expect(v0WireSize(vtx.message as never)).toBe(out.bytes);
  });

  it('refuses with a structured error when nothing makes it fit', () => {
    const keys = Array.from({ length: 40 }, () => Keypair.generate().publicKey);
    expect(() =>
      compileSolanaTransaction({ payer, ...blockhash, instructions: [wideIx(payer, keys)] }),
    ).toThrow(SolanaTransactionTooLargeError);
    try {
      compileSolanaTransaction({
        payer,
        ...blockhash,
        instructions: [wideIx(payer, keys)],
        forceV0: true,
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SolanaTransactionTooLargeError);
      // The overflow is measured, not guessed.
      expect((e as SolanaTransactionTooLargeError).bytes).toBeGreaterThan(PACKET_DATA_SIZE);
      expect((e as SolanaTransactionTooLargeError).toResponse().error).toBe('solana_tx_too_large');
    }
  });

  it('drops a table that costs more than the keys it saves', () => {
    const keys = Array.from({ length: 10 }, () => Keypair.generate().publicKey);
    const big = syntheticLookupTable(keys.slice(1));
    // Holds just one of the keys: referencing it (34 bytes) beats nothing.
    const tiny = syntheticLookupTable([keys[0]!]);
    const out = compileSolanaTransaction({
      payer,
      ...blockhash,
      instructions: [wideIx(payer, keys)],
      lookupTables: [tiny, big],
      forceV0: true,
    });
    const vtx = VersionedTransaction.deserialize(Buffer.from(out.base64, 'base64'));
    expect(vtx.message.addressTableLookups.map((l) => l.accountKey.toBase58())).toEqual([
      big.key.toBase58(),
    ]);
  });
});

describe('composeWithLookupTables', () => {
  const stonkz = syntheticLookupTable([Keypair.generate().publicKey]);
  const jup = syntheticLookupTable([Keypair.generate().publicKey]);
  const src = () =>
    accountSource({
      [stonkz.key.toBase58()]: encodeLookupTableAccount(stonkz.state.addresses),
      [jup.key.toBase58()]: encodeLookupTableAccount(jup.state.addresses),
    });

  it('reads the operator and Jupiter tables for a Jupiter hop, operator first', async () => {
    const s = src();
    const seen = await composeWithLookupTables((t) => t?.map((x) => x.key.toBase58()), {
      source: s,
      jupiterAlts: [jup.key.toBase58()],
      stonkzAlts: [stonkz.key.toBase58()],
    });
    expect(seen).toEqual([stonkz.key.toBase58(), jup.key.toBase58()]);
  });

  it('reads nothing on the plain path while legacy fits', async () => {
    const s = src();
    const seen = await composeWithLookupTables((t) => t, {
      source: s,
      stonkzAlts: [stonkz.key.toBase58()],
    });
    expect(seen).toBeUndefined();
    expect(s.reads).toEqual([]);
  });

  it('retries a too-large plain composition against the operator tables', async () => {
    const s = src();
    const seen = await composeWithLookupTables(
      (t) => {
        if (!t) throw new SolanaTransactionTooLargeError(1300);
        return t.map((x) => x.key.toBase58());
      },
      { source: s, stonkzAlts: [stonkz.key.toBase58()] },
    );
    expect(seen).toEqual([stonkz.key.toBase58()]);
  });

  it('surfaces the size error when no operator table is configured', async () => {
    await expect(
      composeWithLookupTables(
        () => {
          throw new SolanaTransactionTooLargeError(1300);
        },
        { source: src(), stonkzAlts: [] },
      ),
    ).rejects.toBeInstanceOf(SolanaTransactionTooLargeError);
  });
});

describe('composeSolanaTradeTransaction — Jupiter hop as v0', () => {
  const stonkzAlt = syntheticLookupTable(stonkzLaunchAltAddresses(programId, [NATIVE_MINT, USDC]));

  for (const side of ['buy', 'sell'] as const) {
    it(`${side}: a 30-account route over two Jupiter tables fits, with fees and a tip`, () => {
      const trader = Keypair.generate().publicKey;
      const route = syntheticJupiterRoute({
        user: trader,
        baseMint: USDC,
        poolAccounts: 21,
        tableCount: 2,
      });
      const out = composeSolanaTradeTransaction(
        {
          side,
          programId,
          trader,
          mint: Keypair.generate().publicKey,
          baseMint: USDC,
          curveAmountIn: 1_000n,
          curveMinOut: 1n,
          jupiter: { response: route.response },
          prioSol: 0.001,
          mevOn: true,
          mevTipSol: 0.0009,
          lookupTables: [stonkzAlt, ...route.tables],
        },
        blockhash,
      );
      expect(out.version).toBe(0);
      expect(out.bytes).toBeLessThanOrEqual(PACKET_DATA_SIZE);
      const vtx = VersionedTransaction.deserialize(Buffer.from(out.base64, 'base64'));
      const ixs = TransactionMessage.decompile(vtx.message, {
        addressLookupTableAccounts: [stonkzAlt, ...route.tables],
      }).instructions;
      const jupIdx = ixs.findIndex((ix) => ix.programId.toBase58().startsWith('JUP6'));
      const curveIdx = ixs.findIndex((ix) => ix.programId.equals(programId));
      // buy: native -> base (Jupiter) -> curve; sell: curve -> Jupiter.
      expect(side === 'buy' ? jupIdx < curveIdx : curveIdx < jupIdx).toBe(true);
    });
  }

  it('the direct native pair stays legacy', () => {
    const trader = Keypair.generate().publicKey;
    const out = composeSolanaTradeTransaction(
      {
        side: 'buy',
        programId,
        trader,
        mint: Keypair.generate().publicKey,
        baseMint: NATIVE_MINT,
        curveAmountIn: 1_000n,
        curveMinOut: 1n,
        lookupTables: [stonkzAlt],
      },
      blockhash,
    );
    expect(out.version).toBe('legacy');
    expect(() => Transaction.from(Buffer.from(out.base64, 'base64'))).not.toThrow();
  });
});

describe('confirm-side message re-derivation', () => {
  function signedV0(
    tables = [syntheticLookupTable(Array.from({ length: 5 }, () => Keypair.generate().publicKey))],
  ) {
    const payer = Keypair.generate();
    const keys = tables.flatMap((t) => t.state.addresses);
    const out = compileSolanaTransaction({
      payer: payer.publicKey,
      ...blockhash,
      instructions: [wideIx(payer.publicKey, keys)],
      lookupTables: tables,
      forceV0: true,
    });
    const vtx = VersionedTransaction.deserialize(Buffer.from(out.base64, 'base64'));
    vtx.sign([payer]);
    return { out, wire: Buffer.from(vtx.serialize()) };
  }

  it('reads a signed v0 transaction back to exactly the prepared message', () => {
    const { out, wire } = signedV0();
    expect(wireMessageBase64(wire)).toBe(out.messageBase64);
  });

  it('keeps the legacy encoding for legacy transactions', () => {
    const payer = Keypair.generate();
    const t = new Transaction({ feePayer: payer.publicKey, ...blockhash }).add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: payer.publicKey,
        lamports: 1,
      }),
    );
    t.sign(payer);
    expect(wireMessageBase64(t.serialize())).toBe(
      t.compileMessage().serialize().toString('base64'),
    );
  });

  it('a transaction pointing the same indexes at another table does not match', () => {
    const { out, wire } = signedV0();
    const vtx = VersionedTransaction.deserialize(wire);
    expect(vtx.message.addressTableLookups).toHaveLength(1);
    const swapped = new VersionedTransaction(
      new (vtx.message.constructor as new (a: unknown) => typeof vtx.message)({
        header: vtx.message.header,
        staticAccountKeys: vtx.message.staticAccountKeys,
        recentBlockhash: vtx.message.recentBlockhash,
        compiledInstructions: vtx.message.compiledInstructions,
        addressTableLookups: vtx.message.addressTableLookups.map((l) => ({
          ...l,
          accountKey: Keypair.generate().publicKey,
        })),
      }),
    );
    expect(wireMessageBase64(swapped.serialize())).not.toBe(out.messageBase64);
  });

  it('SolanaRpc.getTransactionOutcome decodes a v0 transaction the node returns', async () => {
    const { out, wire } = signedV0();
    const rpc = new SolanaRpc({
      url: 'http://rpc',
      fetchImpl: rpcReplying({
        result: { transaction: [wire.toString('base64'), 'base64'], meta: { err: null } },
      }),
    });
    expect(await rpc.getTransactionOutcome('sig')).toEqual({
      messageBase64: out.messageBase64,
      failed: false,
    });
  });
});
