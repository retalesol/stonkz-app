import { PublicKey } from '@solana/web3.js';
import { derivePdas, LAUNCHPAD_SEEDS } from '../router/solana-idl.js';

/**
 * String-typed views of the launchpad's Solana account layout, for callers
 * outside this package (the indexer's reconciliation CLI) that do not depend
 * on `@solana/web3.js` themselves. Read-only helpers; nothing here signs.
 */

/** The `Curve` PDA for a mint — the signer on every fill, claim and stake of that coin. */
export function solCurvePda(programId: string, mint: string): string {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(LAUNCHPAD_SEEDS.curve), new PublicKey(mint).toBuffer()],
    new PublicKey(programId),
  )[0].toBase58();
}

export interface SolCurveVaults {
  protocolVault: string;
  opsVault: string;
  burnVault: string;
  bucketBaseVault: string;
  bucketTokenVault: string;
  stakeEscrow: string;
}

/** The per-base treasury vaults and the coin's bucket / escrow vaults. */
export function solCurveVaults(programId: string, mint: string, baseMint: string): SolCurveVaults {
  const p = derivePdas(new PublicKey(programId), new PublicKey(mint), new PublicKey(baseMint));
  return {
    protocolVault: p.protocolVault.toBase58(),
    opsVault: p.opsVault.toBase58(),
    burnVault: p.burnVault.toBase58(),
    bucketBaseVault: p.bucketBaseVault.toBase58(),
    bucketTokenVault: p.bucketTokenVault.toBase58(),
    stakeEscrow: p.stakeEscrow.toBase58(),
  };
}

/** A 32-byte pubkey slice of an account's data, as base58. */
export function pubkeyAt(data: Uint8Array, offset: number): string {
  return new PublicKey(data.subarray(offset, offset + 32)).toBase58();
}
