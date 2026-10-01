/**
 * Turn on self-serve referral payouts on Solana: create the wrapped-SOL
 * referral vault (permissionless, `init_if_needed`-style — safe to re-run)
 * and register the API's Ed25519 voucher signer with a daily cap (admin).
 *
 *   ANCHOR_PROVIDER_URL=https://practical-quaint-meme.solana-devnet.quiknode.pro/c8aa47382db29af890d18e52774284dabdb6845a/ \
 *   ANCHOR_WALLET=/path/to/admin.json \
 *   REFERRAL_SIGNER=<pubkey of REFERRAL_SIGNER_KEY_SOL> \
 *   REFERRAL_MAX_PER_DAY_SOL=1 \
 *   STONKZ_CLUSTER=devnet \
 *   pnpm exec tsx programs/solana/scripts/setup-referral.ts [base mint ...]
 *
 * The cluster tag must match the API's `solClusterTag` (`mainnet` for
 * mainnet-beta, else the cluster name), zero-padded to 8 bytes.
 */
import * as anchor from '@coral-xyz/anchor';
import type { Program } from '@coral-xyz/anchor';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type { Launchpad } from '../target/types/launchpad.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const enc = (s: string) => Buffer.from(s, 'utf8');

function clusterTag(cluster: string): number[] {
  const word = cluster === 'mainnet-beta' ? 'mainnet' : cluster;
  const out = Buffer.alloc(8);
  out.write(word, 'utf8');
  return [...out];
}

async function main(): Promise<void> {
  const walletPath = process.env.ANCHOR_WALLET;
  if (!walletPath) throw new Error('set ANCHOR_WALLET to the admin keypair json');
  const signerRaw = process.env.REFERRAL_SIGNER;
  if (!signerRaw) throw new Error('set REFERRAL_SIGNER to the voucher signer pubkey');
  const signer = new PublicKey(signerRaw);
  const capSol = Number(process.env.REFERRAL_MAX_PER_DAY_SOL ?? '1');
  if (!(capSol > 0)) throw new Error('REFERRAL_MAX_PER_DAY_SOL must be > 0');
  const cluster = process.env.STONKZ_CLUSTER ?? 'devnet';
  if (cluster === 'mainnet-beta' && !process.env.STONKZ_SQUADS_VAULT) {
    throw new Error('mainnet-beta: governance is required (STONKZ_SQUADS_VAULT); see docs/governance-handover.md');
  }

  const admin = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, 'utf8')) as number[]),
  );
  const conn = new anchor.web3.Connection(
    process.env.ANCHOR_PROVIDER_URL || 'https://api.devnet.solana.com',
    'confirmed',
  );
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(admin), {
    commitment: 'confirmed',
  });
  anchor.setProvider(provider);
  const idl = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../target/idl/launchpad.json'), 'utf8'),
  );
  const program = new anchor.Program(idl, provider) as Program<Launchpad>;
  const pid = program.programId;
  const pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, pid)[0];
  const globalPda = pda(enc('global'));
  const configPda = pda(enc('referral_config'));
  const authorityPda = pda(enc('referral_authority'));

  const mints = process.argv.slice(2).map((m) => new PublicKey(m));
  if (mints.length === 0) mints.push(NATIVE_MINT);
  console.log('program', pid.toBase58(), 'admin', admin.publicKey.toBase58());

  for (const baseMint of mints) {
    const vaultPda = pda(enc('referral_vault'), baseMint.toBuffer());
    if (await conn.getAccountInfo(vaultPda)) {
      console.log(`${baseMint.toBase58()}: referral vault exists ${vaultPda.toBase58()}`);
      continue;
    }
    const sig = await program.methods
      .initReferralVault()
      .accountsPartial({
        global: globalPda,
        baseMint,
        referralVault: vaultPda,
        referralAuthority: authorityPda,
        payer: admin.publicKey,
        baseTokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`${baseMint.toBase58()}: referral vault created ${vaultPda.toBase58()} tx=${sig}`);
  }

  const capLamports = new anchor.BN(Math.round(capSol * 1e9));
  const sig = await program.methods
    .setReferralSigner(signer, capLamports, clusterTag(cluster))
    .accountsPartial({
      global: globalPda,
      referralConfig: configPda,
      admin: admin.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log(
    `referral signer set: ${signer.toBase58()} cap=${capSol} SOL/day cluster=${cluster} config=${configPda.toBase58()} tx=${sig}`,
  );
  console.log('fund the vault: withdraw_treasury(Protocol) to', pda(enc('referral_vault'), NATIVE_MINT.toBuffer()).toBase58(), '(or fund_referral_vault)');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
