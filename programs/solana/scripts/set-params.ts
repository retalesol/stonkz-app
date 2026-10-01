/**
 * Set the launchpad's runtime parameters on Solana (`set_params`): the fee
 * split, the creator fee bounds, the cashback window and the graduation cap.
 * The `["params"]` PDA is created on first use; until then the program runs
 * on the `constants.rs` defaults, which are also this script's defaults — so
 * running it with no overrides simply materialises the account.
 *
 *   ANCHOR_PROVIDER_URL=https://practical-quaint-meme.solana-devnet.quiknode.pro/c8aa47382db29af890d18e52774284dabdb6845a/ \
 *   ANCHOR_WALLET=/path/to/admin.json \
 *   STONKZ_CLUSTER=devnet \
 *   STONKZ_FEE_PROTOCOL_BPS=1500 STONKZ_FEE_OPS_BPS=1000 STONKZ_FEE_BURN_BPS=600 \
 *   STONKZ_MIN_FEE_BPS=100 STONKZ_MAX_FEE_BPS=500 \
 *   STONKZ_CB_START_FEE_BPS=5000 STONKZ_CB_WINDOW_SECS=300 \
 *   STONKZ_GRAD_MCAP_USD=69000 \
 *   pnpm exec tsx programs/solana/scripts/set-params.ts [--dry-run]
 *
 * Every STONKZ_* value is optional and defaults to the number shown. The
 * wallet must be `Global.admin`; on mainnet-beta that is the Squads vault, so
 * the script refuses to run without `STONKZ_SQUADS_VAULT` and, when the wallet
 * is not admin, prints the instruction for the multisig instead of sending.
 */
import * as anchor from '@coral-xyz/anchor';
import type { Program } from '@coral-xyz/anchor';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import type { Launchpad } from '../target/types/launchpad.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const enc = (s: string) => Buffer.from(s, 'utf8');

type Args = {
  feeProtocolBps: number;
  feeOpsBps: number;
  feeBurnBps: number;
  minFeeBps: number;
  maxFeeBps: number;
  cbStartFeeBps: number;
  cbWindowSecs: number;
  gradMcapUsd1e6: anchor.BN;
};

/**
 * Anchor's generated types spell `grad_mcap_usd_1e6` as `gradMcapUsd1e6`, but
 * its runtime coder reads `gradMcapUsd1E6` (digit-then-letter is a word
 * boundary for the `camelcase` package) and encodes a missing key as 0. Send
 * both spellings; read the account back through whichever is present.
 */
const wire = (a: Args) => ({ ...a, gradMcapUsd1E6: a.gradMcapUsd1e6 }) as unknown as Args;
const gradOf = (p: unknown): anchor.BN =>
  ((p as { gradMcapUsd1E6?: anchor.BN }).gradMcapUsd1E6 ??
    (p as { gradMcapUsd1e6?: anchor.BN }).gradMcapUsd1e6)!;

/** `constants.rs` — the numbers the program applies while the PDA is absent. */
const DEFAULTS = {
  feeProtocolBps: 1500,
  feeOpsBps: 1000,
  feeBurnBps: 600,
  minFeeBps: 100,
  maxFeeBps: 500,
  cbStartFeeBps: 5000,
  cbWindowSecs: 300,
  gradMcapUsd: 69_000,
} as const;

function intEnv(name: string, fallback: number, max = 10_000): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 0 || v > max) {
    throw new Error(`${name} must be an integer in 0..=${max} (got ${raw})`);
  }
  return v;
}

function gradUsd1e6(): anchor.BN {
  const raw = process.env.STONKZ_GRAD_MCAP_USD;
  const usd = raw === undefined || raw.trim() === '' ? DEFAULTS.gradMcapUsd : Number(raw);
  if (!(usd > 0) || !Number.isFinite(usd)) throw new Error('STONKZ_GRAD_MCAP_USD must be > 0');
  return new anchor.BN(Math.round(usd * 1e6).toString());
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const walletPath = process.env.ANCHOR_WALLET;
  if (!walletPath) throw new Error('set ANCHOR_WALLET to the admin keypair json');
  const cluster = process.env.STONKZ_CLUSTER ?? 'devnet';
  if (cluster === 'mainnet-beta' && !process.env.STONKZ_SQUADS_VAULT) {
    throw new Error('mainnet-beta: governance is required (STONKZ_SQUADS_VAULT); see docs/governance-handover.md');
  }

  const args: Args = {
    feeProtocolBps: intEnv('STONKZ_FEE_PROTOCOL_BPS', DEFAULTS.feeProtocolBps),
    feeOpsBps: intEnv('STONKZ_FEE_OPS_BPS', DEFAULTS.feeOpsBps),
    feeBurnBps: intEnv('STONKZ_FEE_BURN_BPS', DEFAULTS.feeBurnBps),
    minFeeBps: intEnv('STONKZ_MIN_FEE_BPS', DEFAULTS.minFeeBps),
    maxFeeBps: intEnv('STONKZ_MAX_FEE_BPS', DEFAULTS.maxFeeBps),
    cbStartFeeBps: intEnv('STONKZ_CB_START_FEE_BPS', DEFAULTS.cbStartFeeBps),
    cbWindowSecs: intEnv('STONKZ_CB_WINDOW_SECS', DEFAULTS.cbWindowSecs, 0xffff_ffff),
    gradMcapUsd1e6: gradUsd1e6(),
  };
  // The same checks `validate_params` applies on chain, so a typo fails here.
  if (args.feeProtocolBps + args.feeOpsBps + args.feeBurnBps > 10_000) {
    throw new Error('fee_protocol + fee_ops + fee_burn must be <= 10000 bps');
  }
  if (args.minFeeBps > args.maxFeeBps) throw new Error('min_fee_bps must be <= max_fee_bps');
  if (args.maxFeeBps > args.cbStartFeeBps) throw new Error('max_fee_bps must be <= cb_start_fee_bps');
  if (args.cbWindowSecs === 0) throw new Error('cb_window_secs must be > 0');

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
  const paramsPda = pda(enc('params'));

  const global = await program.account.global.fetch(globalPda);
  const before = await program.account.params.fetchNullable(paramsPda);
  console.log('cluster  :', cluster);
  console.log('program  :', pid.toBase58());
  console.log('admin    :', global.admin.toBase58(), admin.publicKey.equals(global.admin) ? '(this wallet)' : '(NOT this wallet)');
  console.log('params   :', paramsPda.toBase58(), before ? '' : '(absent — program is on built-in defaults)');
  console.log('current  :', before ? show(before) : show({ ...DEFAULTS, gradMcapUsd1e6: new anchor.BN(DEFAULTS.gradMcapUsd * 1e6) }));
  console.log('new      :', show(args));

  if (dryRun) {
    console.log('--dry-run: nothing sent.');
    return;
  }

  if (!admin.publicKey.equals(global.admin)) {
    const ix = await program.methods
      .setParams(wire(args))
      .accountsPartial({
        global: globalPda,
        params: paramsPda,
        admin: global.admin,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    console.log('');
    console.log('=== Admin (Squads vault) must execute ===');
    console.log('program  :', pid.toBase58());
    console.log('accounts :', ix.keys.map((k) => `${k.pubkey.toBase58()}${k.isSigner ? ' (signer)' : ''}${k.isWritable ? ' (writable)' : ''}`).join('\n           '));
    console.log('data b64 :', Buffer.from(ix.data).toString('base64'));
    process.exitCode = 2;
    return;
  }

  const sig = await program.methods
    .setParams(wire(args))
    .accountsPartial({
      global: globalPda,
      params: paramsPda,
      admin: admin.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log('set_params tx:', sig);
  const after = await program.account.params.fetch(paramsPda);
  console.log('on chain :', show(after));
}

function show(p: Omit<Args, 'gradMcapUsd1e6'> & { gradMcapUsd1e6?: anchor.BN }): string {
  const bucket = 10_000 - p.feeProtocolBps - p.feeOpsBps - p.feeBurnBps;
  const grad = gradOf(p);
  return (
    `split protocol/ops/burn/creator = ${p.feeProtocolBps}/${p.feeOpsBps}/${p.feeBurnBps}/${bucket} bps, ` +
    `creator fee ${p.minFeeBps}..${p.maxFeeBps} bps, cashback ${p.cbStartFeeBps} bps over ${p.cbWindowSecs}s, ` +
    `graduation $${(Number(grad.toString()) / 1e6).toLocaleString('en-US')}`
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
