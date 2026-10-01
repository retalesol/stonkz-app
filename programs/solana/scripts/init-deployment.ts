/**
 * Initialize a deployed Stonkz launchpad on Solana.
 *
 * `anchor deploy` puts the program on chain; it does not create the `Global`
 * config account, and until that exists every instruction fails. This script
 * is the second half of a deployment: `initialize`, then `set_meteora_config`
 * so migration has a DLMM CPI target, then `set_params` with the program's
 * built-in defaults so the runtime-params PDA exists from day one (the
 * program behaves identically without it; `scripts/set-params.ts` changes it).
 *
 * Usage (see docs/deployment.md for the full runbook):
 *
 *   ANCHOR_PROVIDER_URL=https://practical-quaint-meme.solana-devnet.quiknode.pro/c8aa47382db29af890d18e52774284dabdb6845a/ \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   STONKZ_CLUSTER=devnet \
 *   STONKZ_ADMIN=... \
 *   STONKZ_PROTOCOL_WITHDRAW_AUTHORITY=... \
 *   STONKZ_OPS_WITHDRAW_AUTHORITY=... \
 *   STONKZ_ORACLE_AUTHORITY=... \
 *   STONKZ_MIGRATION_AUTHORITY=... \
 *   pnpm exec ts-node scripts/init-deployment.ts
 *
 * Pass `--dry-run` to print everything it would do and send nothing.
 */
import * as anchor from '@coral-xyz/anchor';
import { requireMainnetGovernance } from './mainnet-guard';

const { PublicKey, SystemProgram } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;

/**
 * `set_params` payload equal to `constants.rs` — the numbers the program
 * applies while the PDA is absent. Mirrors `scripts/set-params.ts` DEFAULTS.
 */
const DEFAULT_PARAMS = {
  feeProtocolBps: 1500,
  feeOpsBps: 1000,
  feeBurnBps: 600,
  minFeeBps: 100,
  maxFeeBps: 500,
  cbStartFeeBps: 5000,
  cbWindowSecs: 300,
  // Anchor's runtime coder camel-cases `grad_mcap_usd_1e6` as `gradMcapUsd1E6`
  // (its generated types say `gradMcapUsd1e6`); both spellings are set so the
  // u64 is never silently encoded as 0.
  gradMcapUsd1e6: new anchor.BN('69000000000'),
  gradMcapUsd1E6: new anchor.BN('69000000000'),
};

/** Meteora `lb_clmm` — same program id on mainnet and devnet. */
const METEORA_DLMM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');

/**
 * PresetParameter2 index for graduation pools. Index 1 is a widely deployed
 * fee/bin-step tier on both clusters; override with STONKZ_METEORA_PRESET_INDEX.
 */
const DEFAULT_PRESET_INDEX = 1;

type Cluster = 'mainnet-beta' | 'devnet' | 'localnet';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`${name} is required (no default — see docs/deployment.md)`);
  }
  return v.trim();
}

function requirePubkey(name: string): PublicKey {
  const raw = requireEnv(name);
  let key: PublicKey;
  try {
    key = new PublicKey(raw);
  } catch {
    throw new Error(`${name} is not a valid base58 public key: ${raw}`);
  }
  if (key.equals(PublicKey.default)) {
    throw new Error(`${name} must not be the default (all-zero) pubkey`);
  }
  return key;
}

function requireCluster(): Cluster {
  const raw = requireEnv('STONKZ_CLUSTER');
  if (raw !== 'mainnet-beta' && raw !== 'devnet' && raw !== 'localnet') {
    throw new Error(`STONKZ_CLUSTER must be mainnet-beta|devnet|localnet (got ${raw})`);
  }
  return raw;
}

function derivePresetParameter2(index: number): PublicKey {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(index);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('preset_parameter2'), buf],
    METEORA_DLMM,
  );
  return pda;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const cluster = requireCluster();

  const admin = requirePubkey('STONKZ_ADMIN');
  const protocolWithdrawAuthority = requirePubkey('STONKZ_PROTOCOL_WITHDRAW_AUTHORITY');
  const opsWithdrawAuthority = requirePubkey('STONKZ_OPS_WITHDRAW_AUTHORITY');
  const oracleAuthority = requirePubkey('STONKZ_ORACLE_AUTHORITY');
  const migrationAuthority = requirePubkey('STONKZ_MIGRATION_AUTHORITY');

  if (protocolWithdrawAuthority.equals(opsWithdrawAuthority)) {
    throw new Error('STONKZ_PROTOCOL_WITHDRAW_AUTHORITY and STONKZ_OPS_WITHDRAW_AUTHORITY must differ (SPEC.md §4)');
  }
  if (admin.equals(protocolWithdrawAuthority) || admin.equals(opsWithdrawAuthority)) {
    throw new Error('STONKZ_ADMIN must differ from both withdraw authorities (SPEC.md §4)');
  }

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Launchpad as anchor.Program;

  const [globalPda] = PublicKey.findProgramAddressSync([Buffer.from('global')], program.programId);

  // Mainnet: refuses unless a Squads vault is admin and upgrade authority and
  // a separate pauser is named. Devnet/localnet return null and carry on.
  const governance = await requireMainnetGovernance({
    cluster,
    connection: provider.connection,
    programId: program.programId,
    admin,
    deployer: provider.wallet.publicKey,
  });

  const presetIndex = Number(process.env.STONKZ_METEORA_PRESET_INDEX ?? DEFAULT_PRESET_INDEX);
  const preset = process.env.STONKZ_METEORA_PRESET
    ? new PublicKey(process.env.STONKZ_METEORA_PRESET)
    : derivePresetParameter2(presetIndex);

  console.log('cluster                      :', cluster);
  console.log('rpc                          :', provider.connection.rpcEndpoint);
  console.log('payer (deployer)             :', provider.wallet.publicKey.toBase58());
  console.log('program id                   :', program.programId.toBase58());
  console.log('global pda                   :', globalPda.toBase58());
  console.log('admin                        :', admin.toBase58());
  console.log('protocol withdraw authority  :', protocolWithdrawAuthority.toBase58());
  console.log('ops withdraw authority       :', opsWithdrawAuthority.toBase58());
  console.log('oracle authority             :', oracleAuthority.toBase58());
  console.log('migration authority          :', migrationAuthority.toBase58());
  console.log('meteora dlmm program         :', METEORA_DLMM.toBase58());
  console.log(`meteora preset (index ${presetIndex}) :`, preset.toBase58());

  const existing = await provider.connection.getAccountInfo(globalPda);

  if (dryRun) {
    console.log('');
    console.log('--dry-run: nothing sent.');
    console.log(existing ? 'global already exists; initialize would fail' : 'global does not exist; would initialize');
    return;
  }

  if (existing) {
    console.log('');
    console.log('global already initialized — skipping initialize, refreshing meteora config only');
  } else {
    console.log('');
    console.log('sending initialize...');
    const sig = await program.methods
      .initialize(admin, protocolWithdrawAuthority, opsWithdrawAuthority, oracleAuthority, migrationAuthority)
      .accounts({
        global: globalPda,
        payer: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log('  initialize:', sig);
  }

  if (provider.wallet.publicKey.equals(admin)) {
    console.log('sending setMeteoraConfig...');
    const sig = await program.methods
      .setMeteoraConfig(METEORA_DLMM, preset)
      .accounts({ global: globalPda, admin })
      .rpc();
    console.log('  setMeteoraConfig:', sig);
  } else {
    console.log('');
    console.log('=== Admin must execute (deployer is not admin) ===');
    console.log('launchpad.setMeteoraConfig(program, preset) signed by', admin.toBase58());
    console.log('  program :', METEORA_DLMM.toBase58());
    console.log('  preset  :', preset.toBase58());
    console.log('Until this lands, migrate_create_pool fails closed and nothing can graduate.');
  }

  // Runtime params: materialise the PDA with the defaults on a fresh
  // deployment. Skipped when it already exists so a re-run never silently
  // resets numbers an admin tuned later (use scripts/set-params.ts for that).
  const [paramsPda] = PublicKey.findProgramAddressSync([Buffer.from('params')], program.programId);
  const paramsInfo = await provider.connection.getAccountInfo(paramsPda);
  if (paramsInfo) {
    console.log('params PDA exists; leaving runtime params as they are:', paramsPda.toBase58());
  } else if (provider.wallet.publicKey.equals(admin)) {
    console.log('sending setParams (defaults)...');
    const sig = await program.methods
      .setParams(DEFAULT_PARAMS)
      .accounts({ global: globalPda, params: paramsPda, admin, systemProgram: SystemProgram.programId })
      .rpc();
    console.log('  setParams:', sig);
  } else {
    console.log('');
    console.log('=== Admin (Squads vault) should execute (optional: the program runs on these defaults until then) ===');
    console.log('launchpad.setParams(1500/1000/600 bps, fee 100..500 bps, cashback 5000 bps / 300 s, $69,000) signed by', admin.toBase58());
    console.log('  or: pnpm exec tsx programs/solana/scripts/set-params.ts');
  }

  const pauser = governance?.pauser ?? (process.env.STONKZ_PAUSER ? new PublicKey(process.env.STONKZ_PAUSER) : null);
  if (pauser) {
    const [pauserPda] = PublicKey.findProgramAddressSync([Buffer.from('pauser')], program.programId);
    if (provider.wallet.publicKey.equals(admin)) {
      const sig = await program.methods
        .setPauser(pauser)
        .accounts({ global: globalPda, pauserConfig: pauserPda, admin, systemProgram: SystemProgram.programId })
        .rpc();
      console.log('  setPauser:', sig);
    } else {
      console.log('');
      console.log('=== Admin (Squads vault) must execute ===');
      console.log('launchpad.setPauser(' + pauser.toBase58() + ') signed by', admin.toBase58());
    }
  }

  console.log('');
  console.log('=== apps/api env ===');
  console.log('SOLANA_LAUNCHPAD_PROGRAM_ID=' + program.programId.toBase58());
  console.log('');
  console.log('=== apps/indexer env ===');
  console.log('INDEXER_SOL_LAUNCHPAD_PROGRAM_ID=' + program.programId.toBase58());
  console.log('');
  console.log('Remaining, per base mint (oracle authority key): push_base_price before any launch on that base.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
