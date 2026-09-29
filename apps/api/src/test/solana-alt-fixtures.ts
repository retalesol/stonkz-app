import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import type { JupiterInstruction, JupiterSwapInstructionsResponse } from '../router/jupiter.js';

/**
 * Synthetic address lookup tables and a Jupiter `swap-instructions` response
 * shaped like a real SOL → base route, for tests that cannot reach mainnet.
 */

export const JUPITER_PROGRAM_ID = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
export const JUPITER_EVENT_AUTHORITY = new PublicKey(
  'D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf',
);

/** Raw account bytes of an active lookup table, the layout the ALT program writes. */
export function encodeLookupTableAccount(
  addresses: readonly PublicKey[],
  authority: PublicKey | null = null,
): Buffer {
  const meta = Buffer.alloc(56);
  meta.writeUInt32LE(1, 0); // ProgramState::LookupTable
  meta.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, 4); // deactivation_slot = u64::MAX (active)
  meta.writeBigUInt64LE(1n, 12); // last_extended_slot
  meta.writeUInt8(0, 20); // last_extended_slot_start_index
  meta.writeUInt8(authority ? 1 : 0, 21);
  if (authority) authority.toBuffer().copy(meta, 22);
  return Buffer.concat([meta, ...addresses.map((a) => a.toBuffer())]);
}

export function syntheticLookupTable(
  addresses: readonly PublicKey[],
  key: PublicKey = Keypair.generate().publicKey,
): AddressLookupTableAccount {
  return new AddressLookupTableAccount({
    key,
    state: AddressLookupTableAccount.deserialize(encodeLookupTableAccount(addresses)),
  });
}

function toJupiter(ix: TransactionInstruction): JupiterInstruction {
  return {
    programId: ix.programId.toBase58(),
    accounts: ix.keys.map((k) => ({
      pubkey: k.pubkey.toBase58(),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
    data: Buffer.from(ix.data).toString('base64'),
  };
}

export interface SyntheticJupiterRoute {
  response: JupiterSwapInstructionsResponse;
  /** The tables `response.addressLookupTableAddresses` names, already loaded. */
  tables: AddressLookupTableAccount[];
  /** Total accounts the swap instruction itself names. */
  swapAccounts: number;
}

/**
 * A SOL → `baseMint` route as Jupiter's `/swap-instructions` returns it with
 * `wrapAndUnwrapSol: true`: compute budget (limit + price), setup (WSOL ATA
 * create, wrap, sync, base ATA create), a `route` swap over `poolAccounts`
 * AMM accounts, and a WSOL close. Pool accounts, the event authority and the
 * two mints sit in `tableCount` Jupiter lookup tables; the user's own
 * accounts cannot, exactly as on mainnet.
 */
export function syntheticJupiterRoute(opts: {
  user: PublicKey;
  baseMint: PublicKey;
  inLamports?: bigint;
  poolAccounts?: number;
  tableCount?: number;
  unitLimit?: number;
}): SyntheticJupiterRoute {
  const poolAccounts = opts.poolAccounts ?? 18;
  const tableCount = opts.tableCount ?? 2;
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, opts.user, false, TOKEN_PROGRAM_ID);
  const baseAta = getAssociatedTokenAddressSync(opts.baseMint, opts.user, false, TOKEN_PROGRAM_ID);
  const pools = Array.from({ length: poolAccounts }, () => Keypair.generate().publicKey);

  const swapKeys = [
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: opts.user, isSigner: true, isWritable: false },
    { pubkey: wsolAta, isSigner: false, isWritable: true },
    { pubkey: baseAta, isSigner: false, isWritable: true },
    { pubkey: JUPITER_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: opts.baseMint, isSigner: false, isWritable: false },
    { pubkey: JUPITER_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: JUPITER_EVENT_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: JUPITER_PROGRAM_ID, isSigner: false, isWritable: false },
    // AMM legs alternate writable pool state / vaults and readonly programs/config.
    ...pools.map((pubkey, i) => ({ pubkey, isSigner: false, isWritable: i % 3 !== 2 })),
  ];

  const response: JupiterSwapInstructionsResponse = {
    computeBudgetInstructions: [
      toJupiter(ComputeBudgetProgram.setComputeUnitLimit({ units: opts.unitLimit ?? 300_000 })),
      toJupiter(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 12_345 })),
    ],
    setupInstructions: [
      toJupiter(
        createAssociatedTokenAccountIdempotentInstruction(
          opts.user,
          wsolAta,
          opts.user,
          NATIVE_MINT,
        ),
      ),
      toJupiter(
        SystemProgram.transfer({
          fromPubkey: opts.user,
          toPubkey: wsolAta,
          lamports: opts.inLamports ?? 50_000_000n,
        }),
      ),
      toJupiter(createSyncNativeInstruction(wsolAta)),
      toJupiter(
        createAssociatedTokenAccountIdempotentInstruction(
          opts.user,
          baseAta,
          opts.user,
          opts.baseMint,
        ),
      ),
    ],
    swapInstruction: {
      programId: JUPITER_PROGRAM_ID.toBase58(),
      accounts: swapKeys.map((k) => ({
        pubkey: k.pubkey.toBase58(),
        isSigner: k.isSigner,
        isWritable: k.isWritable,
      })),
      // `route` discriminator + a two-step route plan + in/quoted-out/slippage/fee.
      data: Buffer.alloc(8 + 4 + 2 * 4 + 8 + 8 + 2 + 1).toString('base64'),
    },
    cleanupInstruction: toJupiter(createCloseAccountInstruction(wsolAta, opts.user, opts.user)),
    addressLookupTableAddresses: [],
  };

  // Spread the shared + pool accounts across the tables the way Jupiter's
  // big shared tables do: some keys in one table, the rest in another.
  const shared = [JUPITER_EVENT_AUTHORITY, NATIVE_MINT, opts.baseMint, TOKEN_PROGRAM_ID, ...pools];
  const tables: AddressLookupTableAccount[] = [];
  const per = Math.ceil(shared.length / tableCount);
  for (let t = 0; t < tableCount; t++) {
    // Pad each table with unrelated keys so indexes are not trivially 0..n.
    const filler = Array.from({ length: 40 }, () => Keypair.generate().publicKey);
    tables.push(syntheticLookupTable([...filler, ...shared.slice(t * per, (t + 1) * per)]));
  }
  response.addressLookupTableAddresses = tables.map((t) => t.key.toBase58());
  return { response, tables, swapAccounts: swapKeys.length };
}
