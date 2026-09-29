/**
 * Create (or top up) the Stonkz address lookup table that `apps/api` compiles
 * v0 launch and trade transactions against (`SOLANA_LAUNCH_ALT`).
 *
 * A launch with a Jupiter-routed dev buy only fits one 1232-byte packet as a
 * v0 transaction, and only once the launchpad's static accounts come from a
 * lookup table too: the global PDA, each base mint's oracle / protocol / ops
 * / burn vault PDAs, the base mints, the token, system, Metaplex and ATA
 * programs, and — for each base mint with a Pyth feed pinned in the program —
 * the sponsored Pyth push-feed account `sync_price_from_pyth` reads. This
 * script writes exactly that list (the same one
 * `apps/api/src/router/solana-alt.ts`'s `stonkzLaunchAltAddresses` builds).
 *
 *   ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com \
 *   ANCHOR_WALLET=/path/to/operator.json \
 *   STONKZ_PROGRAM_ID=FF1f3V47FtApwWWMHX462Gm7NVqNpUJ7K4yqKrYGSMbg \
 *   pnpm exec ts-node scripts/create-launch-alt.ts [--table <ALT>] [--dry-run] [baseMint ...]
 *
 * - Wrapped SOL is always covered. Pass every other base mint the deployment
 *   allows (USDC, USDT, BONK, ... on mainnet).
 * - `--table <ALT>` extends an existing table with whatever it is missing
 *   (e.g. after adding a base mint, or the Pyth feed accounts added with
 *   `sync_price_from_pyth`) instead of creating a new one. Entries are
 *   append-only, so existing transactions keep resolving.
 * - `--dry-run` prints the address list and sends nothing.
 *
 * The wallet becomes the table's authority and pays its rent (~0.0016 SOL
 * plus 0.00022 SOL per address). Addresses become usable one slot after the
 * extend lands. Then set `SOLANA_LAUNCH_ALT=<table>` on the API.
 */
import * as anchor from '@coral-xyz/anchor';
import fs from 'node:fs';

const { AddressLookupTableProgram, Connection, Keypair, PublicKey, Transaction } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');
const TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112');
/** Pyth push-oracle program: sponsored feed accounts are its PDAs `[shard u16 LE, feed_id]`. */
const PYTH_PUSH_ORACLE_PROGRAM_ID = new PublicKey('pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT');
/**
 * Base mint → Pyth feed id pinned by the program (`src/pyth.rs` `PYTH_FEEDS`;
 * mirrored in `apps/api/src/router/solana-idl.ts`).
 */
const PYTH_FEEDS: Record<string, string> = {
  So11111111111111111111111111111111111111112:
    'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:
    'eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB:
    '2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b',
};

/** Shard-0 sponsored feed account for `baseMint`'s pinned feed, if any. */
function pythFeedAccount(baseMint: PublicKey): PublicKey | null {
  const hex = PYTH_FEEDS[baseMint.toBase58()];
  if (!hex) return null;
  return PublicKey.findProgramAddressSync(
    [Buffer.alloc(2), Buffer.from(hex, 'hex')],
    PYTH_PUSH_ORACLE_PROGRAM_ID,
  )[0];
}

/** Addresses per extend transaction — comfortably under the packet limit. */
const EXTEND_CHUNK = 20;

const enc = (s: string) => Buffer.from(s, 'utf8');

function launchAltAddresses(programId: PublicKey, baseMints: PublicKey[]): PublicKey[] {
  const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, programId)[0];
  const out: PublicKey[] = [
    TOKEN_PROGRAM_ID,
    SYSTEM_PROGRAM_ID,
    TOKEN_METADATA_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    NATIVE_MINT,
    pda([enc('global')]),
  ];
  for (const baseMint of baseMints) {
    out.push(
      baseMint,
      pda([enc('oracle'), baseMint.toBuffer()]),
      pda([enc('protocol_vault'), baseMint.toBuffer()]),
      pda([enc('ops_vault'), baseMint.toBuffer()]),
      pda([enc('burn_vault'), baseMint.toBuffer()]),
    );
    const feed = pythFeedAccount(baseMint);
    if (feed) out.push(feed);
  }
  const seen = new Set<string>();
  return out.filter((k) => {
    const s = k.toBase58();
    if (seen.has(s)) return false;
    seen.add(s);
    return true;
  });
}

function parseArgs(argv: string[]): { table: string | null; dryRun: boolean; mints: string[] } {
  let table: string | null = null;
  let dryRun = false;
  const mints: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--dry-run') dryRun = true;
    else if (a === '--table') table = argv[++i] ?? null;
    else mints.push(a);
  }
  return { table, dryRun, mints };
}

async function main(): Promise<void> {
  const { table, dryRun, mints } = parseArgs(process.argv.slice(2));
  const programIdRaw = process.env.STONKZ_PROGRAM_ID;
  if (!programIdRaw) throw new Error('set STONKZ_PROGRAM_ID to the deployed launchpad program id');
  const programId = new PublicKey(programIdRaw);
  const baseMints = mints.map((m) => new PublicKey(m));
  // Wrapped SOL is always a base; its PDAs lead the list.
  if (!baseMints.some((m) => m.equals(NATIVE_MINT))) baseMints.unshift(NATIVE_MINT);
  const wanted = launchAltAddresses(programId, baseMints);

  console.log('program', programId.toBase58());
  console.log(`${wanted.length} addresses:`);
  for (const k of wanted) console.log('  ' + k.toBase58());
  if (dryRun) {
    console.log('--dry-run: nothing sent');
    return;
  }

  const walletPath = process.env.ANCHOR_WALLET;
  if (!walletPath) throw new Error('set ANCHOR_WALLET to the operator keypair json');
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, 'utf8')) as number[]),
  );
  const conn = new Connection(
    process.env.ANCHOR_PROVIDER_URL || 'https://api.devnet.solana.com',
    'confirmed',
  );
  const send = async (ixs: anchor.web3.TransactionInstruction[]) => {
    const tx = new Transaction().add(...ixs);
    return anchor.web3.sendAndConfirmTransaction(conn, tx, [payer], { commitment: 'confirmed' });
  };

  let tableKey: PublicKey;
  let existing: string[] = [];
  if (table) {
    tableKey = new PublicKey(table);
    const res = await conn.getAddressLookupTable(tableKey);
    if (!res.value) throw new Error(`lookup table ${table} not found on this cluster`);
    if (!res.value.state.authority?.equals(payer.publicKey)) {
      throw new Error(`ANCHOR_WALLET is not the authority of ${table}`);
    }
    existing = res.value.state.addresses.map((a) => a.toBase58());
  } else {
    const recentSlot = await conn.getSlot('finalized');
    const [createIx, key] = AddressLookupTableProgram.createLookupTable({
      authority: payer.publicKey,
      payer: payer.publicKey,
      recentSlot,
    });
    tableKey = key;
    const sig = await send([createIx]);
    console.log('created', key.toBase58(), 'tx', sig);
  }

  const have = new Set(existing);
  const missing = wanted.filter((k) => !have.has(k.toBase58()));
  for (let i = 0; i < missing.length; i += EXTEND_CHUNK) {
    const chunk = missing.slice(i, i + EXTEND_CHUNK);
    const sig = await send([
      AddressLookupTableProgram.extendLookupTable({
        lookupTable: tableKey,
        authority: payer.publicKey,
        payer: payer.publicKey,
        addresses: chunk,
      }),
    ]);
    console.log(`extended +${chunk.length}`, 'tx', sig);
  }
  if (missing.length === 0) console.log('table already holds every address');

  console.log(`\nSOLANA_LAUNCH_ALT=${tableKey.toBase58()}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
