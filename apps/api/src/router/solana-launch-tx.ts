import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  NATIVE_MINT,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
} from '@solana/spl-token';
import { JupiterAltRequiredError } from './errors.js';
import type { JupiterHop } from './solana-tx.js';
import {
  buildBuyInstruction,
  buildCreateTokenInstruction,
  traderAtas,
  type CreateTokenArgs,
} from './solana-instructions.js';

/**
 * `POST /launch/prepare` on Solana — `create_token`, optionally followed
 * atomically by a dev buy (plan step 90's "unsigned create (+ optional atomic
 * native \u2192 base \u2192 dev_buy)"). One transaction either way: Solana's
 * account model lets `buy` reference the mint/curve `create_token` creates
 * earlier in the *same* transaction, since only ordering — not confirmation —
 * matters within one atomic tx.
 *
 * Instruction order when a dev buy is present:
 *  1. Idempotent-create the creator's **base** ATA (needs to exist before
 *     either a native-SOL wrap or a Jupiter swap can land funds in it).
 *  2. Fund it — either a direct SOL wrap (base is native) or a Jupiter
 *     swap (base is anything else; `jupiter.ts`'s `wrapAndUnwrapSol: true`
 *     already handles unwrapping the *input* SOL on that path).
 *  3. `create_token` — creates the mint, the curve, and every PDA vault.
 *  4. Idempotent-create the creator's **token** ATA — only possible now,
 *     since the mint does not exist before step 3 runs.
 *  5. `buy` — the dev buy itself, against the curve `create_token` just made.
 *
 * Compute budget: `create_token` now also CPIs Metaplex
 * `CreateMetadataAccountV3`, which takes a create-only launch close to the
 * runtime's implicit 200k single-instruction default. Every composed launch
 * therefore runs under at least {@link launchComputeUnitLimit}'s budget —
 * written as one `SetComputeUnitLimit` only where the implicit default would
 * fall short (see {@link implicitComputeUnitLimit}), because the native
 * dev-buy path has no bytes to spare. Jupiter's own `SetComputeUnitLimit` (if
 * it sent one) is folded into ours rather than kept: the runtime rejects a
 * transaction carrying two, and Jupiter's figure alone would cap the whole
 * launch at the swap's estimate. Its `SetComputeUnitPrice` is kept as-is.
 */

/**
 * Compute-unit budget per instruction, with headroom over what the local
 * validator measured (`programs/solana/.anchor/program-logs`: `create_token`
 * ≤ 106k before the Metaplex CPI, `buy` ≤ 56k including the cashback swap).
 * The Metaplex `CreateMetadataAccountV3` CPI plus the extra PDA check are
 * budgeted at up to ~90k on top. `/launch/prepare` simulates the composed
 * transaction before returning it, so an under-budget would surface there,
 * not in the wallet.
 */
export const LAUNCH_COMPUTE_UNITS = {
  createToken: 250_000,
  /** Idempotent ATA create, worst case (the account does not exist yet). */
  ataCreate: 35_000,
  /** SystemProgram.transfer + SyncNative. */
  nativeWrap: 10_000,
  devBuy: 100_000,
  /** Used only if Jupiter's response carries no `SetComputeUnitLimit`. */
  jupiterFallback: 400_000,
} as const;

/** Per-transaction ceiling enforced by the runtime. */
export const MAX_TRANSACTION_COMPUTE_UNITS = 1_400_000;

/** `ComputeBudgetInstruction::SetComputeUnitLimit` tag. */
const SET_COMPUTE_UNIT_LIMIT_TAG = 2;

/**
 * What the runtime grants a transaction that carries no `SetComputeUnitLimit`:
 * 200k per instruction, except builtins (System, ComputeBudget), which get
 * 3k each since SIMD-0170 and are counted at that lower figure here so the
 * estimate stays conservative on clusters either side of the feature.
 */
const DEFAULT_INSTRUCTION_UNITS = 200_000;
const DEFAULT_BUILTIN_UNITS = 3_000;

export function implicitComputeUnitLimit(ixs: readonly TransactionInstruction[]): number {
  let units = 0;
  for (const ix of ixs) {
    if (ix.programId.equals(ComputeBudgetProgram.programId)) continue;
    units += ix.programId.equals(SystemProgram.programId)
      ? DEFAULT_BUILTIN_UNITS
      : DEFAULT_INSTRUCTION_UNITS;
  }
  return Math.min(units, MAX_TRANSACTION_COMPUTE_UNITS);
}

export function launchComputeUnitLimit(opts: {
  devBuy: boolean;
  nativeWrap: boolean;
  /** Jupiter's requested limit; `null` for a Jupiter hop that did not set one. */
  jupiterUnits?: number | null;
}): number {
  const u = LAUNCH_COMPUTE_UNITS;
  let units = u.createToken;
  if (opts.devBuy) {
    units += 2 * u.ataCreate + u.devBuy;
    if (opts.nativeWrap) units += u.nativeWrap;
    if (opts.jupiterUnits !== undefined) units += opts.jupiterUnits ?? u.jupiterFallback;
  }
  return Math.min(units, MAX_TRANSACTION_COMPUTE_UNITS);
}
export interface SolanaLaunchDevBuy {
  /** Base atoms the dev buy spends — already net of nothing; this is `amount_base`. */
  curveAmountIn: bigint;
  curveMinOut: bigint;
  /** Present when the base asset is not native/wrapped-native. */
  jupiter?: JupiterHop;
}

export interface SolanaLaunchComposition {
  programId: PublicKey;
  creator: PublicKey;
  baseMint: PublicKey;
  createArgs: CreateTokenArgs;
  devBuy?: SolanaLaunchDevBuy;
}

export interface ComposedSolanaLaunch {
  /** Full wire-format unsigned transaction — what the client's wallet actually signs. */
  base64: string;
  /** Compiled message only (signatures stripped), base64 — what `launch_intents.unsignedPayload` stores and `/launch/confirm` re-derives from the signed, submitted transaction to verify a match. */
  messageBase64: string;
  lastValidBlockHeight: number;
  mint: PublicKey;
  curve: PublicKey;
  /** Metaplex metadata PDA `create_token` creates for `mint`. */
  metadata: PublicKey;
  /**
   * The compute-unit limit the transaction runs under: the explicit
   * `SetComputeUnitLimit` when one is written, otherwise the runtime's
   * implicit default (which is then already at least the budget).
   */
  computeUnitLimit: number;
}

function toIx(ix: {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: Buffer.from(ix.data, 'base64'),
  });
}

function isSetComputeUnitLimit(ix: TransactionInstruction): boolean {
  return (
    ix.programId.equals(ComputeBudgetProgram.programId) &&
    ix.data.length >= 5 &&
    ix.data[0] === SET_COMPUTE_UNIT_LIMIT_TAG
  );
}

/**
 * Jupiter's instructions split into the compute-budget part (hoisted to the
 * front of the launch transaction, minus any `SetComputeUnitLimit`, whose
 * units are returned so they can be folded into ours) and the swap itself.
 */
function jupiterInstructions(hop: JupiterHop): {
  budget: TransactionInstruction[];
  swap: TransactionInstruction[];
  units: number | null;
} {
  const r = hop.response;
  if (r.addressLookupTableAddresses.length > 0) {
    throw new JupiterAltRequiredError();
  }
  let units: number | null = null;
  const budget: TransactionInstruction[] = [];
  for (const ix of r.computeBudgetInstructions.map(toIx)) {
    if (isSetComputeUnitLimit(ix)) units = (units ?? 0) + ix.data.readUInt32LE(1);
    else budget.push(ix);
  }
  const swap: TransactionInstruction[] = [];
  if (r.tokenLedgerInstruction) swap.push(toIx(r.tokenLedgerInstruction));
  swap.push(...r.setupInstructions.map(toIx));
  swap.push(toIx(r.swapInstruction));
  if (r.cleanupInstruction) swap.push(toIx(r.cleanupInstruction));
  return { budget, swap, units };
}

export function composeSolanaLaunchTransaction(
  c: SolanaLaunchComposition,
  blockhash: { blockhash: string; lastValidBlockHeight: number },
): ComposedSolanaLaunch {
  const tx = new Transaction({
    feePayer: c.creator,
    blockhash: blockhash.blockhash,
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
  });

  const {
    instruction: createIx,
    mint,
    curve,
    metadata,
  } = buildCreateTokenInstruction(
    {
      programId: c.programId,
      creator: c.creator,
      baseMint: c.baseMint,
      salt: c.createArgs.salt,
    },
    c.createArgs,
  );

  // Everything after the compute-budget prefix, in execution order.
  const body: TransactionInstruction[] = [];
  let jup: ReturnType<typeof jupiterInstructions> | null = null;
  let budgetUnits: number;
  if (c.devBuy) {
    const atas = traderAtas({
      programId: c.programId,
      mint,
      baseMint: c.baseMint,
      trader: c.creator,
    });
    const isDirectNativePair = !c.devBuy.jupiter && c.baseMint.equals(NATIVE_MINT);
    jup = c.devBuy.jupiter ? jupiterInstructions(c.devBuy.jupiter) : null;
    budgetUnits = launchComputeUnitLimit({
      devBuy: true,
      nativeWrap: isDirectNativePair,
      ...(jup ? { jupiterUnits: jup.units } : {}),
    });

    body.push(
      createAssociatedTokenAccountIdempotentInstruction(
        c.creator,
        atas.base,
        c.creator,
        c.baseMint,
      ),
    );
    if (isDirectNativePair) {
      body.push(
        SystemProgram.transfer({
          fromPubkey: c.creator,
          toPubkey: atas.base,
          lamports: c.devBuy.curveAmountIn,
        }),
        createSyncNativeInstruction(atas.base),
      );
    } else if (jup) {
      body.push(...jup.swap);
    }

    body.push(
      createIx,
      createAssociatedTokenAccountIdempotentInstruction(c.creator, atas.token, c.creator, mint),
      buildBuyInstruction(
        { programId: c.programId, mint, baseMint: c.baseMint, trader: c.creator },
        c.devBuy.curveAmountIn,
        c.devBuy.curveMinOut,
      ),
    );
  } else {
    budgetUnits = launchComputeUnitLimit({ devBuy: false, nativeWrap: false });
    body.push(createIx);
  }

  // An explicit limit costs ~41 bytes (the ComputeBudget program key plus the
  // instruction), and the native dev-buy path with a maximal name/uri has
  // under 10 bytes to spare. So the limit is only written when it is needed:
  // when Jupiter sent one (it must be replaced — on its own it would cap the
  // whole transaction at the swap's estimate), or when the runtime's implicit
  // default would fall short of the budget.
  const implicit = implicitComputeUnitLimit(body);
  const explicit = (jup !== null && jup.units !== null) || implicit < budgetUnits;
  const computeUnitLimit = explicit ? budgetUnits : implicit;
  if (explicit) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }));
  // `Transaction.add()` throws on an empty spread, and Jupiter often sends no budget ixs.
  if (jup && jup.budget.length > 0) tx.add(...jup.budget);
  tx.add(...body);

  const base64 = tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString('base64');
  const messageBase64 = tx.compileMessage().serialize().toString('base64');
  return {
    base64,
    messageBase64,
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
    mint,
    curve,
    metadata,
    computeUnitLimit,
  };
}
