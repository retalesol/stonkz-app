import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AddressLookupTableAccount,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
} from '@solana/spl-token';
import { compileSolanaTransaction } from './solana-alt.js';
import type { JupiterHop } from './solana-tx.js';
import {
  buildBuyInstruction,
  buildCreateTokenInstruction,
  buildSyncPriceFromPythInstruction,
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
 * Price sync: when the base mint has a Pyth feed pinned on chain, the
 * transaction opens with `sync_price_from_pyth`, which copies Pyth's
 * sponsored push-feed price into the base mint's `BaseOracle` (creating it on
 * first use). `create_token` then reads a price at most one Pyth heartbeat
 * old (measured ~35 s devnet, ~55 s mainnet, inside the 90 s default
 * staleness) instead of whatever a keeper last pushed. The sync is a no-op when the stored price is
 * already as new, so bundling it never fails a launch that would otherwise
 * land.
 *
 * Instruction order when a dev buy is present (after the optional sync):
 *  1. Idempotent-create the creator's **base** ATA (needs to exist before
 *     either a native-SOL wrap or a Jupiter swap can land funds in it) —
 *     skipped when Jupiter's setup instructions already create it.
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
 *
 * Message version: a launch without a Jupiter hop stays a legacy
 * transaction whenever it fits — without the Pyth sync it always does (1225
 * bytes at the longest name/ticker/uri with a native dev buy). The sync adds
 * 49 bytes (one 32-byte key and a 17-byte instruction; create-only it nets
 * +8, since it makes the explicit compute limit unnecessary), so with a
 * native dev buy a legacy launch fits while name + ticker + uri ≤ 200 bytes —
 * always, with the pinned Pinata metadata URI (113 bytes). Past that it
 * compiles v0 against `SOLANA_LAUNCH_ALT` (1062 bytes worst case), and with
 * no table `/launch/prepare` drops the sync rather than refuse the launch.
 * See `solana-launch-tx.test.ts`'s size report. A Jupiter hop always
 * compiles to a v0 message against Jupiter's lookup tables plus the
 * operator's `SOLANA_LAUNCH_ALT` — see `solana-alt.ts` — and so does a
 * legacy launch that would not fit, when a table is available.
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
  /** `sync_price_from_pyth`, worst case (first sync creates the BaseOracle). */
  pythSync: 30_000,
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
  /** A `sync_price_from_pyth` precedes `create_token`. */
  pythSync?: boolean;
  /** Jupiter's requested limit; `null` for a Jupiter hop that did not set one. */
  jupiterUnits?: number | null;
}): number {
  const u = LAUNCH_COMPUTE_UNITS;
  let units = u.createToken;
  if (opts.pythSync) units += u.pythSync;
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
  /**
   * The Pyth `PriceUpdateV2` to sync the base mint's `BaseOracle` from ahead
   * of `create_token` (the sponsored push-feed account for the feed the
   * program pins to `baseMint`). Absent: no sync, the launch prices off
   * whatever the `BaseOracle` already holds.
   */
  pythPriceUpdate?: PublicKey;
  /**
   * Loaded lookup tables — Jupiter's `addressLookupTableAddresses` and the
   * operator's `SOLANA_LAUNCH_ALT`, already read from chain. Only used when
   * the transaction compiles as v0.
   */
  lookupTables?: readonly AddressLookupTableAccount[];
}

export interface ComposedSolanaLaunch {
  /** Full wire-format unsigned transaction — what the client's wallet actually signs. */
  base64: string;
  /** Compiled message only (signatures stripped), base64 — what `launch_intents.unsignedPayload` stores and `/launch/confirm` re-derives from the signed, submitted transaction to verify a match. A v0 message includes its version prefix and lookup-table references. */
  messageBase64: string;
  /** `'legacy'` unless a Jupiter hop (or the packet limit) required a v0 message. */
  version: 'legacy' | 0;
  /** Wire size in bytes, at most 1232. */
  bytes: number;
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

/** Whether `ixs` already includes an Associated Token Account create for `ata`. */
function createsAta(ixs: readonly TransactionInstruction[], ata: PublicKey): boolean {
  return ixs.some(
    (ix) => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) && !!ix.keys[1]?.pubkey.equals(ata),
  );
}

export function composeSolanaLaunchTransaction(
  c: SolanaLaunchComposition,
  blockhash: { blockhash: string; lastValidBlockHeight: number },
): ComposedSolanaLaunch {
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
  const pythSync = c.pythPriceUpdate !== undefined;
  if (c.pythPriceUpdate) {
    body.push(
      buildSyncPriceFromPythInstruction({
        programId: c.programId,
        baseMint: c.baseMint,
        priceUpdate: c.pythPriceUpdate,
        payer: c.creator,
      }),
    );
  }
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
      pythSync,
      ...(jup ? { jupiterUnits: jup.units } : {}),
    });

    // Jupiter's own setup usually creates the destination (base) ATA; a
    // second idempotent create is ~10 bytes the v0 packet cannot spare.
    if (!(jup && createsAta(jup.swap, atas.base))) {
      body.push(
        createAssociatedTokenAccountIdempotentInstruction(
          c.creator,
          atas.base,
          c.creator,
          c.baseMint,
        ),
      );
    }
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
    budgetUnits = launchComputeUnitLimit({ devBuy: false, nativeWrap: false, pythSync });
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
  const instructions: TransactionInstruction[] = [];
  if (explicit) {
    instructions.push(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }));
  }
  if (jup) instructions.push(...jup.budget);
  instructions.push(...body);

  const compiled = compileSolanaTransaction({
    payer: c.creator,
    blockhash: blockhash.blockhash,
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
    instructions,
    ...(c.lookupTables ? { lookupTables: c.lookupTables } : {}),
    forceV0: jup !== null,
  });
  return {
    base64: compiled.base64,
    messageBase64: compiled.messageBase64,
    version: compiled.version,
    bytes: compiled.bytes,
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
    mint,
    curve,
    metadata,
    computeUnitLimit,
  };
}
