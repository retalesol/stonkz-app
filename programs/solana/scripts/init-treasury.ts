/**
 * Create (or confirm) the protocol (platform) / ops ($STONKZ buyback) / burn
 * (RWA crate fund; historical name) treasury vaults for one or
 * more base mints. `init_treasury` is `init_if_needed`, so re-running it after
 * the four-leg fee split upgrade adds the missing `burn_vault` PDA next to the
 * two that already exist, without touching them. Trades revert until every
 * base mint a curve uses has its burn vault.
 *
 *   ANCHOR_PROVIDER_URL=https://practical-quaint-meme.solana-devnet.quiknode.pro/c8aa47382db29af890d18e52774284dabdb6845a/ \
 *   ANCHOR_WALLET=/path/to/funded.json \
 *   pnpm exec tsx programs/solana/scripts/init-treasury.ts [mint ...]
 *
 * With no arguments it seeds wrapped SOL (every native-paired curve). Pass the
 * base mints of USDC and any stock-token pairs your deployment allows.
 */
import * as anchor from '@coral-xyz/anchor';
import type { Program } from '@coral-xyz/anchor';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type { Launchpad } from '../target/types/launchpad.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const enc = (s: string) => Buffer.from(s, 'utf8');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const walletPath = process.env.ANCHOR_WALLET;
  if (!walletPath) throw new Error('set ANCHOR_WALLET to a funded keypair json');
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, 'utf8')) as number[]),
  );
  const conn = new anchor.web3.Connection(
    process.env.ANCHOR_PROVIDER_URL || 'https://api.devnet.solana.com',
    'confirmed',
  );
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(payer), {
    commitment: 'confirmed',
  });
  anchor.setProvider(provider);
  const idl = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../target/idl/launchpad.json'), 'utf8'),
  );
  const program = new anchor.Program(idl, provider) as Program<Launchpad>;
  const pid = program.programId;
  const globalPda = PublicKey.findProgramAddressSync([enc('global')], pid)[0];
  const vault = (seed: string, mint: PublicKey) =>
    PublicKey.findProgramAddressSync([enc(seed), mint.toBuffer()], pid)[0];

  const mints = process.argv.slice(2).map((m) => new PublicKey(m));
  if (mints.length === 0) mints.push(NATIVE_MINT);

  console.log('program', pid.toBase58(), 'payer', payer.publicKey.toBase58());
  for (const baseMint of mints) {
    const vaults = {
      protocolVault: vault('protocol_vault', baseMint),
      opsVault: vault('ops_vault', baseMint),
      burnVault: vault('burn_vault', baseMint),
    };
    const before = await conn.getAccountInfo(vaults.burnVault);
    const sig = await program.methods
      .initTreasury()
      .accountsPartial({
        global: globalPda,
        baseMint,
        ...vaults,
        payer: payer.publicKey,
        baseTokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(
      `${baseMint.toBase58()}: ${before ? 'vaults confirmed' : 'burn vault created'} ` +
        `protocol=${vaults.protocolVault.toBase58()} ops=${vaults.opsVault.toBase58()} ` +
        `burn=${vaults.burnVault.toBase58()} tx=${sig}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
