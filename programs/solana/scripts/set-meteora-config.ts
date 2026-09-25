/**
 * One-shot: write Meteora DLMM program id + PresetParameter2 into Global.
 * Admin-gated; uses ANCHOR_WALLET. Safe to re-run (idempotent overwrite).
 *
 * Env:
 *   STONKZ_METEORA_PRESET — optional base58 PresetParameter2; default = index 1
 *     (`7FEVd6LpxTyKuBpLXYJVAGPhZpE6KrPBLdtx7sBbZ97z` on both clusters when present).
 */
import * as anchor from '@coral-xyz/anchor';

const { PublicKey } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;

/** Meteora `lb_clmm` — same id on mainnet and devnet. */
const METEORA_DLMM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');

/** Default PresetParameter2 index (fee/bin-step tier). Override via env. */
const DEFAULT_PRESET_INDEX = 1;

function derivePresetParameter2(index: number): PublicKey {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(index);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('preset_parameter2'), buf],
    METEORA_DLMM,
  );
  return pda;
}

async function main(): Promise<void> {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Launchpad as anchor.Program;
  const [global] = PublicKey.findProgramAddressSync([Buffer.from('global')], program.programId);

  const preset = process.env.STONKZ_METEORA_PRESET
    ? new PublicKey(process.env.STONKZ_METEORA_PRESET)
    : derivePresetParameter2(DEFAULT_PRESET_INDEX);

  const before = await program.account['global'].fetch(global);
  console.log('wallet', provider.wallet.publicKey.toBase58());
  console.log('before', {
    dexProgram: before['dexProgram']?.toBase58?.() ?? before['raydiumProgram']?.toBase58?.(),
    dexConfig: before['dexConfig']?.toBase58?.() ?? before['raydiumAmmConfig']?.toBase58?.(),
  });

  const sig = await program.methods
    .setMeteoraConfig(METEORA_DLMM, preset)
    .accounts({ global, admin: provider.wallet.publicKey })
    .rpc();
  console.log('setMeteoraConfig', sig);

  const after = await program.account['global'].fetch(global);
  console.log('after', {
    dexProgram: after['dexProgram'].toBase58(),
    dexConfig: after['dexConfig'].toBase58(),
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
