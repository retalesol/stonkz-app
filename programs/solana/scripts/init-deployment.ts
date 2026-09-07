/**
 * Initialize a deployed Stonkz launchpad on Solana.
 *
 * `anchor deploy` puts the program on chain; it does not create the `Global`
 * config account, and until that exists every instruction fails. This script
 * is the second half of a deployment: `initialize`, then `set_raydium_config`
 * so `migrate_liquidity` has a CPI target.
 *
 * Every privileged key is a required env var with no default. A deployment
 * that quietly pointed the protocol treasury at whatever keypair happened to
 * be in `~/.config/solana/id.json` is the failure mode this refuses to have,
 * so a missing or malformed var is a hard exit before anything is sent.
 *
 * Usage (see docs/deployment.md for the full runbook):
 *
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
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

// Via anchor's own re-export rather than a direct `@solana/web3.js` import:
// this package does not declare web3.js as a dependency (it arrives through
// anchor), and a script should not rely on a transitive hoist.
const { PublicKey, SystemProgram } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;

/** Raydium CPMM ("Standard AMM"), verified against docs.raydium.io and raydium-cp-swap's own `declare_id!`. */
const RAYDIUM_CPMM = {
  'mainnet-beta': new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C'),
  devnet: new PublicKey('DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb'),
  localnet: new PublicKey('DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb'),
} as const;

/**
 * Raydium's `AmmConfig` index to migrate every graduation into. Index 0 is the
 * permissionless default tier with no OpenBook market requirement — the reason
 * CPMM was chosen over AMM v4 in the first place (see programs/SPEC.md §6).
 */
const AMM_CONFIG_INDEX = 0;

/**
 * Known-good `AmmConfig` index 0 addresses, used only as a self-check on the
 * PDA derivation below. If the derivation ever stops matching these, the seed
 * layout has changed and this script must stop rather than write a wrong
 * address into `Global`.
 */
const KNOWN_AMM_CONFIG_0 = {
  devnet: '5MxLgy9oPdTC3YgkiePHqr3EoCRD9uLVYRQS2ANAs7wy',
  localnet: '5MxLgy9oPdTC3YgkiePHqr3EoCRD9uLVYRQS2ANAs7wy',
} as const;

type Cluster = keyof typeof RAYDIUM_CPMM;

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
  if (!(raw in RAYDIUM_CPMM)) {
    throw new Error(`STONKZ_CLUSTER must be one of ${Object.keys(RAYDIUM_CPMM).join(', ')} (got ${raw})`);
  }
  return raw as Cluster;
}

/**
 * `["amm_config", index_be_u16]` under the CPMM program — derived rather than
 * hardcoded so a cluster whose config account this script has never seen still
 * works, with the derivation itself checked against `KNOWN_AMM_CONFIG_0`.
 */
function deriveAmmConfig(cpmmProgram: PublicKey, index: number): PublicKey {
  const indexBe = Buffer.alloc(2);
  indexBe.writeUInt16BE(index);
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('amm_config'), indexBe], cpmmProgram);
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

  // The protocol treasury (20%) and the $STONKZ ops vault (10%) are separate
  // PDAs on-chain specifically so an ops spend can never reach protocol
  // revenue. One shared signer would defeat that off-chain, so refuse it.
  if (protocolWithdrawAuthority.equals(opsWithdrawAuthority)) {
    throw new Error('STONKZ_PROTOCOL_WITHDRAW_AUTHORITY and STONKZ_OPS_WITHDRAW_AUTHORITY must differ (SPEC.md §4)');
  }
  // The admin can pause but must not be able to move money, and neither
  // withdraw authority should be a server hot key.
  if (admin.equals(protocolWithdrawAuthority) || admin.equals(opsWithdrawAuthority)) {
    throw new Error('STONKZ_ADMIN must differ from both withdraw authorities (SPEC.md §4)');
  }

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Launchpad as anchor.Program;

  const [globalPda] = PublicKey.findProgramAddressSync([Buffer.from('global')], program.programId);

  const cpmmProgram = RAYDIUM_CPMM[cluster];
  const ammConfig = deriveAmmConfig(cpmmProgram, AMM_CONFIG_INDEX);

  const known = KNOWN_AMM_CONFIG_0[cluster as keyof typeof KNOWN_AMM_CONFIG_0];
  if (known && ammConfig.toBase58() !== known) {
    throw new Error(
      `AmmConfig derivation mismatch on ${cluster}: derived ${ammConfig.toBase58()}, expected ${known}. ` +
        "Raydium's seed layout may have changed — stop and re-verify before writing this into Global.",
    );
  }

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
  console.log('raydium cpmm program         :', cpmmProgram.toBase58());
  console.log(`raydium amm config (index ${AMM_CONFIG_INDEX}) :`, ammConfig.toBase58());

  const existing = await provider.connection.getAccountInfo(globalPda);

  if (dryRun) {
    console.log('');
    console.log('--dry-run: nothing sent.');
    console.log(existing ? 'global already exists; initialize would fail' : 'global does not exist; would initialize');
    return;
  }

  if (existing) {
    // `initialize` uses `init`, not `init_if_needed`, so re-running would
    // fail anyway. Say so clearly instead of surfacing a raw Anchor error,
    // and still set the Raydium config, which is idempotent and is the one
    // step a re-run legitimately wants.
    console.log('');
    console.log('global already initialized — skipping initialize, refreshing raydium config only');
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

  // `set_raydium_config` is admin-gated. The deployer is only able to send it
  // when the deployer *is* the admin (a devnet convenience); on mainnet the
  // admin is a cold key/multisig, so print the instruction for that signer
  // instead of failing with an opaque `Unauthorized`.
  if (provider.wallet.publicKey.equals(admin)) {
    console.log('sending setRaydiumConfig...');
    const sig = await program.methods
      .setRaydiumConfig(cpmmProgram, ammConfig)
      .accounts({ global: globalPda, admin })
      .rpc();
    console.log('  setRaydiumConfig:', sig);
  } else {
    console.log('');
    console.log('=== Admin must execute (deployer is not admin) ===');
    console.log('launchpad.setRaydiumConfig(program, ammConfig) signed by', admin.toBase58());
    console.log('  program   :', cpmmProgram.toBase58());
    console.log('  ammConfig :', ammConfig.toBase58());
    console.log('Until this lands, migrate_liquidity fails closed and nothing can graduate.');
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
