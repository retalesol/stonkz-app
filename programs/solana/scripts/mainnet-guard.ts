/**
 * Mainnet governance guard for operator scripts.
 *
 * On mainnet-beta the launchpad must be governed by a Squads multisig vault:
 * the vault is `Global.admin` and the program's upgrade authority, and an
 * emergency pauser (a separate hot key or small Squads) is appointed. Scripts
 * call `requireMainnetGovernance` before sending anything; it throws naming
 * the first missing piece. Devnet and localnet are unaffected.
 *
 * See docs/governance-handover.md (Solana section).
 */
import * as anchor from '@coral-xyz/anchor';

const { PublicKey } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;
type Connection = anchor.web3.Connection;

const BPF_UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

export interface MainnetGovernance {
  vault: PublicKey;
  pauser: PublicKey;
}

function envPubkey(name: string): PublicKey {
  const raw = process.env[name]?.trim();
  if (!raw) throw new Error(`MainnetGuard: ${name} is required on mainnet-beta`);
  let key: PublicKey;
  try {
    key = new PublicKey(raw);
  } catch {
    throw new Error(`MainnetGuard: ${name} is not a valid public key`);
  }
  if (key.equals(PublicKey.default)) throw new Error(`MainnetGuard: ${name} must not be the default pubkey`);
  return key;
}

/** `null` when the program is immutable (no upgrade authority). */
export async function programUpgradeAuthority(
  connection: Connection,
  programId: PublicKey,
): Promise<PublicKey | null> {
  const [programData] = PublicKey.findProgramAddressSync([programId.toBuffer()], BPF_UPGRADEABLE_LOADER);
  const info = await connection.getAccountInfo(programData);
  if (!info) throw new Error(`MainnetGuard: no ProgramData account for ${programId.toBase58()}`);
  // UpgradeableLoaderState::ProgramData { slot: u64, upgrade_authority: Option<Pubkey> }
  // = 4-byte enum tag, 8-byte slot, 1-byte option tag, 32-byte key.
  if (info.data[12] === 0) return null;
  return new PublicKey(info.data.subarray(13, 45));
}

export async function requireMainnetGovernance(opts: {
  cluster: string;
  connection: Connection;
  programId: PublicKey;
  admin: PublicKey;
  deployer: PublicKey;
}): Promise<MainnetGovernance | null> {
  if (opts.cluster !== 'mainnet-beta') return null;
  const vault = envPubkey('STONKZ_SQUADS_VAULT');
  const pauser = envPubkey('STONKZ_PAUSER');
  if (!opts.admin.equals(vault)) {
    throw new Error('MainnetGuard: STONKZ_ADMIN must be the Squads vault (STONKZ_SQUADS_VAULT) on mainnet-beta');
  }
  if (pauser.equals(vault) || pauser.equals(opts.deployer)) {
    throw new Error('MainnetGuard: STONKZ_PAUSER must be a separate key from the vault and the deployer');
  }
  const authority = await programUpgradeAuthority(opts.connection, opts.programId);
  if (!authority || !authority.equals(vault)) {
    throw new Error(
      'MainnetGuard: the program upgrade authority must be the Squads vault. Run ' +
        '`solana program set-upgrade-authority <PROGRAM_ID> --new-upgrade-authority <VAULT>` first',
    );
  }
  return { vault, pauser };
}
