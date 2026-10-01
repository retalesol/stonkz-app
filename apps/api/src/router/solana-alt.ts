import {
  AddressLookupTableAccount,
  PublicKey,
  type MessageV0,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type { SolanaAccountDataSource } from '../chain/types.js';
import { SolanaTransactionTooLargeError } from './errors.js';
import {
  TOKEN_METADATA_PROGRAM_ID,
  derivePdas,
  pinnedPythFeedId,
  pythPriceFeedAccount,
} from './solana-idl.js';

/**
 * Address lookup tables (ALTs) and the one legacy-or-v0 compile step every
 * Solana composer in this router shares.
 *
 * A legacy message spells every account out as 32 bytes. `create_token`
 * alone names 17, so a launch with a Jupiter-routed dev buy (another ~20-30
 * accounts) cannot fit the 1232-byte packet as a legacy transaction. A v0
 * message instead references accounts held in on-chain lookup tables by a
 * one-byte index: Jupiter returns the tables its route was built against
 * (`addressLookupTableAddresses`), and the operator can add a Stonkz table
 * (`SOLANA_LAUNCH_ALT`) holding the launchpad's static accounts.
 *
 * What cannot come from a table, whatever is configured: signers (the
 * creator/trader) and the program id of every top-level instruction. Those
 * stay static keys — `TransactionMessage.compileToV0Message` enforces both.
 */

/** Solana's wire limit for one transaction (IPv6 MTU minus headers). */
export const PACKET_DATA_SIZE = 1232;

/**
 * Reads each lookup table through the same raw account read the BaseOracle
 * uses. A table that does not exist (closed, wrong cluster, a typo in env)
 * is skipped: the compiler then writes those accounts as static keys, which
 * is always *correct*, only larger — the size check decides whether that
 * still fits. Transport failures propagate (`RpcError`) like any other RPC
 * read on the prepare path.
 */
export async function fetchAddressLookupTables(
  source: SolanaAccountDataSource,
  addresses: readonly string[],
  onMissing?: (address: string) => void,
): Promise<AddressLookupTableAccount[]> {
  const unique = [...new Set(addresses)];
  const read = await Promise.all(
    unique.map(async (address) => {
      const b64 = await source.getAccountDataBase64(address);
      if (!b64) {
        onMissing?.(address);
        return null;
      }
      try {
        const state = AddressLookupTableAccount.deserialize(Buffer.from(b64, 'base64'));
        const table = new AddressLookupTableAccount({ key: new PublicKey(address), state });
        // A deactivated table cannot be used by a new transaction.
        if (!table.isActive()) {
          onMissing?.(address);
          return null;
        }
        return table;
      } catch {
        // Not a lookup table account at all.
        onMissing?.(address);
        return null;
      }
    }),
  );
  return read.filter((t): t is AddressLookupTableAccount => t !== null);
}

/**
 * What the operator's Stonkz lookup table should hold: every account a
 * launch or trade names that is the same across launches. The per-launch
 * accounts (mint, curve, its vaults, metadata, the creator's ATAs) differ
 * every time and are never worth a table slot. Programs that are invoked
 * directly (launchpad, ATA, compute budget) cannot be loaded from a table,
 * but `create_token` also passes the token, system and Metaplex programs as
 * plain accounts, which can.
 *
 * For every base mint with a Pyth feed pinned on chain, the sponsored
 * push-feed account `sync_price_from_pyth` reads is included too. The Pyth
 * programs themselves are never named by a launch transaction (the launchpad
 * checks the feed account's owner against a constant), so they get no slot.
 *
 * `programs/solana/scripts/create-launch-alt.ts` writes this same list.
 */
export function stonkzLaunchAltAddresses(
  programId: PublicKey,
  baseMints: readonly PublicKey[],
): PublicKey[] {
  const out: PublicKey[] = [
    TOKEN_PROGRAM_ID,
    SystemProgram.programId,
    TOKEN_METADATA_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    NATIVE_MINT,
    derivePdas(programId, PublicKey.default, NATIVE_MINT).global,
    derivePdas(programId, PublicKey.default, NATIVE_MINT).params,
  ];
  for (const baseMint of baseMints) {
    // Mint-keyed PDAs are unused; any mint works for the base-keyed ones.
    const pdas = derivePdas(programId, PublicKey.default, baseMint);
    out.push(baseMint, pdas.oracle, pdas.protocolVault, pdas.opsVault, pdas.burnVault);
    const feed = pinnedPythFeedId(baseMint);
    if (feed) out.push(pythPriceFeedAccount(feed));
  }
  const seen = new Set<string>();
  return out.filter((k) => {
    const s = k.toBase58();
    if (seen.has(s)) return false;
    seen.add(s);
    return true;
  });
}

export interface CompiledSolanaTransaction {
  /** Full wire-format unsigned transaction (empty signature slots). */
  base64: string;
  /** Compiled message only — a v0 message's bytes include its version prefix and table lookups. */
  messageBase64: string;
  version: 'legacy' | 0;
  /** Wire size in bytes. */
  bytes: number;
}

/** Bytes of a compact-u16 ("shortvec") length prefix. */
function shortVecLength(n: number): number {
  return n < 0x80 ? 1 : n < 0x4000 ? 2 : 3;
}

/**
 * Wire size of an unsigned v0 transaction, computed rather than serialized —
 * `MessageV0.serialize` cannot report how far past the limit it would go.
 */
export function v0WireSize(message: MessageV0): number {
  const sigs = message.header.numRequiredSignatures;
  let n = shortVecLength(sigs) + 64 * sigs;
  n += 1 + 3; // version prefix + header
  n += shortVecLength(message.staticAccountKeys.length) + 32 * message.staticAccountKeys.length;
  n += 32; // recent blockhash
  n += shortVecLength(message.compiledInstructions.length);
  for (const ix of message.compiledInstructions) {
    n += 1;
    n += shortVecLength(ix.accountKeyIndexes.length) + ix.accountKeyIndexes.length;
    n += shortVecLength(ix.data.length) + ix.data.length;
  }
  n += shortVecLength(message.addressTableLookups.length);
  for (const l of message.addressTableLookups) {
    n += 32;
    n += shortVecLength(l.writableIndexes.length) + l.writableIndexes.length;
    n += shortVecLength(l.readonlyIndexes.length) + l.readonlyIndexes.length;
  }
  return n;
}

/**
 * `compileToV0Message` takes each key from the first table holding it, and
 * references a table as soon as one key comes from it — 34 bytes of overhead
 * for a table that might save a single 31-byte key. Greedily drop any table
 * whose removal makes the message smaller. Deterministic: same inputs, same
 * tables, same bytes.
 */
function compileSmallestV0(
  payer: PublicKey,
  blockhash: string,
  instructions: readonly TransactionInstruction[],
  tables: readonly AddressLookupTableAccount[],
): MessageV0 {
  const compile = (ts: readonly AddressLookupTableAccount[]) =>
    new TransactionMessage({
      payerKey: payer,
      recentBlockhash: blockhash,
      instructions: [...instructions],
    }).compileToV0Message([...ts]);
  let current = [...tables];
  let best = compile(current);
  let bestSize = v0WireSize(best);
  for (;;) {
    let next: { tables: AddressLookupTableAccount[]; message: MessageV0; size: number } | null =
      null;
    for (const lookup of best.addressTableLookups) {
      const subset = current.filter((t) => !t.key.equals(lookup.accountKey));
      const message = compile(subset);
      const size = v0WireSize(message);
      if (size < bestSize && (!next || size < next.size)) next = { tables: subset, message, size };
    }
    if (!next) return best;
    current = next.tables;
    best = next.message;
    bestSize = next.size;
  }
}

const TOO_LARGE_RE = /Transaction too large: (\d+)/;

/**
 * Legacy when it fits and nothing asks for v0, so every flow that works
 * today keeps byte-identical output; otherwise a v0 message against
 * `lookupTables`. `forceV0` is set whenever a Jupiter hop is present: its
 * routes are built against Jupiter's tables, and composing them into a
 * legacy message is what used to overflow.
 */
export function compileSolanaTransaction(opts: {
  payer: PublicKey;
  blockhash: string;
  lastValidBlockHeight: number;
  instructions: readonly TransactionInstruction[];
  lookupTables?: readonly AddressLookupTableAccount[];
  forceV0?: boolean;
}): CompiledSolanaTransaction {
  const tables = opts.lookupTables ?? [];
  if (!opts.forceV0) {
    const tx = new Transaction({
      feePayer: opts.payer,
      blockhash: opts.blockhash,
      lastValidBlockHeight: opts.lastValidBlockHeight,
    });
    if (opts.instructions.length > 0) tx.add(...opts.instructions);
    let wire: Buffer | null = null;
    let legacyBytes: number | null = null;
    try {
      wire = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    } catch (err) {
      const m = TOO_LARGE_RE.exec(String(err));
      if (!m) throw err;
      legacyBytes = Number(m[1]);
    }
    if (wire) {
      return {
        base64: wire.toString('base64'),
        messageBase64: tx.compileMessage().serialize().toString('base64'),
        version: 'legacy',
        bytes: wire.length,
      };
    }
    // Only a table can make the v0 form smaller than the legacy one.
    if (tables.length === 0) throw new SolanaTransactionTooLargeError(legacyBytes);
  }

  const message = compileSmallestV0(opts.payer, opts.blockhash, opts.instructions, tables);
  let messageBytes: Uint8Array;
  try {
    // `MessageV0.serialize` writes into a PACKET_DATA_SIZE buffer and throws
    // a RangeError past it.
    messageBytes = message.serialize();
  } catch (err) {
    if (err instanceof RangeError) throw new SolanaTransactionTooLargeError(v0WireSize(message));
    throw err;
  }
  const wire = new VersionedTransaction(message).serialize();
  if (wire.length > PACKET_DATA_SIZE) throw new SolanaTransactionTooLargeError(wire.length);
  return {
    base64: Buffer.from(wire).toString('base64'),
    messageBase64: Buffer.from(messageBytes).toString('base64'),
    version: 0,
    bytes: wire.length,
  };
}

/**
 * The compiled message of a wire-format transaction, legacy or v0, in the
 * same encoding `compileSolanaTransaction` stores: legacy re-compiled through
 * `Transaction` exactly as before, v0 as its message bytes verbatim (version
 * prefix and lookup-table references included, so a transaction pointing the
 * same indexes at a different table cannot match).
 */
export function wireMessageBase64(raw: Uint8Array): string {
  const vtx = VersionedTransaction.deserialize(raw);
  if (vtx.message.version === 'legacy') {
    return Transaction.from(raw).compileMessage().serialize().toString('base64');
  }
  return Buffer.from(vtx.message.serialize()).toString('base64');
}

/**
 * Runs a composer with the lookup tables it needs, reading them only when
 * they can matter:
 * - a Jupiter hop (`jupiterAlts` defined): its tables plus the operator's,
 *   always — the composer compiles v0;
 * - otherwise legacy first, with no table read at all, and only a legacy
 *   message over the packet limit retries against the operator's tables.
 */
export async function composeWithLookupTables<T>(
  compose: (lookupTables?: readonly AddressLookupTableAccount[]) => T,
  opts: {
    source: SolanaAccountDataSource | undefined;
    /** Jupiter's `addressLookupTableAddresses`; `undefined` when there is no Jupiter hop. */
    jupiterAlts?: readonly string[];
    /** `env.solanaLaunchAlts`. */
    stonkzAlts: readonly string[];
    onMissing?: (address: string) => void;
  },
): Promise<T> {
  const load = async (addresses: readonly string[]) =>
    opts.source && addresses.length > 0
      ? fetchAddressLookupTables(opts.source, addresses, opts.onMissing)
      : [];
  if (opts.jupiterAlts !== undefined) {
    // Operator tables first: keys both hold (the base mint, WSOL) then come
    // from the table the launchpad accounts need anyway.
    return compose(await load([...opts.stonkzAlts, ...opts.jupiterAlts]));
  }
  try {
    return compose();
  } catch (err) {
    if (!(err instanceof SolanaTransactionTooLargeError) || opts.stonkzAlts.length === 0) throw err;
    return compose(await load(opts.stonkzAlts));
  }
}
