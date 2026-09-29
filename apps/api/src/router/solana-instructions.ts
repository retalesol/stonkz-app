import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  anchorDiscriminator,
  derivePdas,
  deriveMetadataPda,
  deriveMintPda,
  deriveStakePositionPda,
  TOKEN_METADATA_PROGRAM_ID,
  encodeBool,
  encodeString,
  encodeU16,
  encodeU64,
} from './solana-idl.js';

/**
 * Every mint this router builds instructions against is assumed to live on
 * the legacy SPL Token program, never Token-2022. `create_token`'s
 * `token_program`/`base_token_program` accounts are generic
 * (`Interface<TokenInterface>`) so the Rust program itself does not enforce
 * this — a base mint that is genuinely Token-2022 (none of `router/base-mints.ts`'s
 * configured SOL majors are) would need this module extended to resolve the
 * owning program per mint before it could trade. Flagged in the phase report
 * as a known limitation, not silently assumed safe.
 */
export { TOKEN_PROGRAM_ID };

export interface CreateTokenAccounts {
  programId: PublicKey;
  creator: PublicKey;
  baseMint: PublicKey;
  /** u64 salt for the mint PDA — unique per creator launch. */
  salt: bigint;
}

export interface CreateTokenArgs {
  name: string;
  ticker: string;
  uri: string;
  supply: bigint;
  feeBps: number;
  cashback: boolean;
  salt: bigint;
}

/**
 * `create_token(name, ticker, uri, supply, fee_bps, cashback, salt)` — plan step 90.
 *
 * The program also CPIs Metaplex `CreateMetadataAccountV3` (name / ticker as
 * symbol / uri, immutable, curve PDA as update authority), so the last two
 * accounts are the Metaplex metadata PDA and the Metaplex program. They are
 * appended after the original fifteen, so every earlier index is unchanged.
 * The launched mint must be classic SPL Token — the program rejects
 * Token-2022 for `token_program` with `UnsupportedTokenProgram`.
 */
export function buildCreateTokenInstruction(
  accounts: CreateTokenAccounts,
  args: CreateTokenArgs,
): { instruction: TransactionInstruction; mint: PublicKey; curve: PublicKey; metadata: PublicKey } {
  const [mint] = deriveMintPda(accounts.programId, accounts.creator, accounts.salt);
  const pdas = derivePdas(accounts.programId, mint, accounts.baseMint);
  const [metadata] = deriveMetadataPda(mint);

  const data = Buffer.concat([
    anchorDiscriminator('create_token'),
    encodeString(args.name),
    encodeString(args.ticker),
    encodeString(args.uri),
    encodeU64(args.supply),
    encodeU16(args.feeBps),
    encodeBool(args.cashback),
    encodeU64(args.salt),
  ]);

  const keys = [
    { pubkey: pdas.global, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: true },
    { pubkey: pdas.curve, isSigner: false, isWritable: true },
    { pubkey: accounts.baseMint, isSigner: false, isWritable: false },
    { pubkey: pdas.oracle, isSigner: false, isWritable: false },
    { pubkey: pdas.curveTokenVault, isSigner: false, isWritable: true },
    { pubkey: pdas.lpVault, isSigner: false, isWritable: true },
    { pubkey: pdas.curveBaseVault, isSigner: false, isWritable: true },
    { pubkey: pdas.bucketBaseVault, isSigner: false, isWritable: true },
    { pubkey: pdas.bucketTokenVault, isSigner: false, isWritable: true },
    { pubkey: pdas.stakeEscrow, isSigner: false, isWritable: true },
    { pubkey: accounts.creator, isSigner: true, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    // Appended in the Metaplex metadata upgrade.
    { pubkey: metadata, isSigner: false, isWritable: true },
    { pubkey: TOKEN_METADATA_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  return {
    instruction: new TransactionInstruction({ programId: accounts.programId, keys, data }),
    mint,
    curve: pdas.curve,
    metadata,
  };
}

export interface SyncPriceFromPythAccounts {
  programId: PublicKey;
  baseMint: PublicKey;
  /** The `PriceUpdateV2` to copy — normally the sponsored push-feed account. */
  priceUpdate: PublicKey;
  /** Pays the `BaseOracle`'s rent if this is its first write (the launch creator). */
  payer: PublicKey;
}

/**
 * `sync_price_from_pyth()` — permissionless: copies the base mint's pinned
 * Pyth feed into its `BaseOracle` (creating it on first use), and is a no-op
 * when the update is not newer than what is stored, so it is always safe to
 * bundle in front of `create_token`.
 */
export function buildSyncPriceFromPythInstruction(
  accounts: SyncPriceFromPythAccounts,
): TransactionInstruction {
  const pdas = derivePdas(accounts.programId, PublicKey.default, accounts.baseMint);
  const keys = [
    { pubkey: pdas.global, isSigner: false, isWritable: false },
    { pubkey: pdas.oracle, isSigner: false, isWritable: true },
    { pubkey: accounts.baseMint, isSigner: false, isWritable: false },
    { pubkey: accounts.priceUpdate, isSigner: false, isWritable: false },
    { pubkey: accounts.payer, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({
    programId: accounts.programId,
    keys,
    data: anchorDiscriminator('sync_price_from_pyth'),
  });
}

export interface TradeAccounts {
  programId: PublicKey;
  mint: PublicKey;
  baseMint: PublicKey;
  trader: PublicKey;
}

/** Trader's ATAs for both legs — `getOrCreateAssociatedTokenAccount` without the RPC round trip; existence is handled by an idempotent create instruction in `solana-tx.ts`. */
export function traderAtas(accounts: TradeAccounts): { base: PublicKey; token: PublicKey } {
  return {
    base: getAssociatedTokenAddressSync(
      accounts.baseMint,
      accounts.trader,
      false,
      TOKEN_PROGRAM_ID,
    ),
    token: getAssociatedTokenAddressSync(accounts.mint, accounts.trader, false, TOKEN_PROGRAM_ID),
  };
}

function tradeKeys(accounts: TradeAccounts) {
  const pdas = derivePdas(accounts.programId, accounts.mint, accounts.baseMint);
  const atas = traderAtas(accounts);
  return {
    pdas,
    atas,
    keys: [
      { pubkey: pdas.global, isSigner: false, isWritable: false },
      { pubkey: pdas.curve, isSigner: false, isWritable: true },
      { pubkey: accounts.mint, isSigner: false, isWritable: false },
      { pubkey: accounts.baseMint, isSigner: false, isWritable: false },
      { pubkey: pdas.curveBaseVault, isSigner: false, isWritable: true },
      { pubkey: pdas.curveTokenVault, isSigner: false, isWritable: true },
      { pubkey: pdas.bucketBaseVault, isSigner: false, isWritable: true },
      { pubkey: pdas.bucketTokenVault, isSigner: false, isWritable: true },
      { pubkey: pdas.protocolVault, isSigner: false, isWritable: true },
      { pubkey: pdas.opsVault, isSigner: false, isWritable: true },
      { pubkey: pdas.burnVault, isSigner: false, isWritable: true },
      { pubkey: accounts.trader, isSigner: true, isWritable: true },
      { pubkey: atas.base, isSigner: false, isWritable: true },
      { pubkey: atas.token, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  };
}

/** `buy(amount_base, min_out)`. */
export function buildBuyInstruction(
  accounts: TradeAccounts,
  amountBase: bigint,
  minOut: bigint,
): TransactionInstruction {
  const { keys } = tradeKeys(accounts);
  const data = Buffer.concat([
    anchorDiscriminator('buy'),
    encodeU64(amountBase),
    encodeU64(minOut),
  ]);
  return new TransactionInstruction({ programId: accounts.programId, keys, data });
}

/** `sell(amount_token, min_out)`. */
export function buildSellInstruction(
  accounts: TradeAccounts,
  amountToken: bigint,
  minOut: bigint,
): TransactionInstruction {
  const { keys } = tradeKeys(accounts);
  const data = Buffer.concat([
    anchorDiscriminator('sell'),
    encodeU64(amountToken),
    encodeU64(minOut),
  ]);
  return new TransactionInstruction({ programId: accounts.programId, keys, data });
}

export interface ClaimAccounts {
  programId: PublicKey;
  mint: PublicKey;
  baseMint: PublicKey;
  creator: PublicKey;
}

/** `claim_creator_fees()` — creator vault only, plan step 92/GET-fees. */
export function buildClaimCreatorFeesInstruction(accounts: ClaimAccounts): TransactionInstruction {
  const pdas = derivePdas(accounts.programId, accounts.mint, accounts.baseMint);
  const creatorBase = getAssociatedTokenAddressSync(
    accounts.baseMint,
    accounts.creator,
    false,
    TOKEN_PROGRAM_ID,
  );
  const creatorToken = getAssociatedTokenAddressSync(
    accounts.mint,
    accounts.creator,
    false,
    TOKEN_PROGRAM_ID,
  );

  const data = anchorDiscriminator('claim_creator_fees');
  const keys = [
    { pubkey: pdas.curve, isSigner: false, isWritable: true },
    { pubkey: accounts.mint, isSigner: false, isWritable: false },
    { pubkey: accounts.baseMint, isSigner: false, isWritable: false },
    { pubkey: pdas.bucketBaseVault, isSigner: false, isWritable: true },
    { pubkey: pdas.bucketTokenVault, isSigner: false, isWritable: true },
    { pubkey: accounts.creator, isSigner: true, isWritable: false },
    { pubkey: creatorBase, isSigner: false, isWritable: true },
    { pubkey: creatorToken, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId: accounts.programId, keys, data });
}

export interface StakeAccounts {
  programId: PublicKey;
  mint: PublicKey;
  owner: PublicKey;
}

/**
 * Shared account metas for `stake` / `unstake`. Position is `init_if_needed`
 * on stake, so the system program is required; unstake reuses the same layout.
 */
function stakeKeys(accounts: StakeAccounts) {
  // Stake/unstake PDAs key only off mint; protocol/ops vaults from derivePdas
  // are unused here — dummy baseMint is fine.
  const pdas = derivePdas(accounts.programId, accounts.mint, PublicKey.default);
  const [position] = deriveStakePositionPda(accounts.programId, accounts.mint, accounts.owner);
  const ownerToken = getAssociatedTokenAddressSync(
    accounts.mint,
    accounts.owner,
    false,
    TOKEN_PROGRAM_ID,
  );
  return {
    keys: [
      { pubkey: pdas.curve, isSigner: false, isWritable: true },
      { pubkey: accounts.mint, isSigner: false, isWritable: false },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: pdas.stakeEscrow, isSigner: false, isWritable: true },
      { pubkey: accounts.owner, isSigner: true, isWritable: true },
      { pubkey: ownerToken, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  };
}

/** `stake(amount, lock_days)`. */
export function buildStakeInstruction(
  accounts: StakeAccounts,
  amount: bigint,
  lockDays: number,
): TransactionInstruction {
  const { keys } = stakeKeys(accounts);
  const data = Buffer.concat([
    anchorDiscriminator('stake'),
    encodeU64(amount),
    encodeU16(lockDays),
  ]);
  return new TransactionInstruction({ programId: accounts.programId, keys, data });
}

/** `unstake(amount)`. */
export function buildUnstakeInstruction(
  accounts: StakeAccounts,
  amount: bigint,
): TransactionInstruction {
  const { keys } = stakeKeys(accounts);
  const data = Buffer.concat([anchorDiscriminator('unstake'), encodeU64(amount)]);
  return new TransactionInstruction({ programId: accounts.programId, keys, data });
}

export interface ClaimStakeAccounts {
  programId: PublicKey;
  mint: PublicKey;
  baseMint: PublicKey;
  owner: PublicKey;
}

/** `claim_stake()`. */
export function buildClaimStakeInstruction(accounts: ClaimStakeAccounts): TransactionInstruction {
  const pdas = derivePdas(accounts.programId, accounts.mint, accounts.baseMint);
  const [position] = deriveStakePositionPda(accounts.programId, accounts.mint, accounts.owner);
  const ownerBase = getAssociatedTokenAddressSync(
    accounts.baseMint,
    accounts.owner,
    false,
    TOKEN_PROGRAM_ID,
  );
  const ownerToken = getAssociatedTokenAddressSync(
    accounts.mint,
    accounts.owner,
    false,
    TOKEN_PROGRAM_ID,
  );
  const data = anchorDiscriminator('claim_stake');
  const keys = [
    { pubkey: pdas.curve, isSigner: false, isWritable: true },
    { pubkey: accounts.mint, isSigner: false, isWritable: false },
    { pubkey: accounts.baseMint, isSigner: false, isWritable: false },
    { pubkey: position, isSigner: false, isWritable: true },
    { pubkey: pdas.bucketBaseVault, isSigner: false, isWritable: true },
    { pubkey: pdas.bucketTokenVault, isSigner: false, isWritable: true },
    { pubkey: accounts.owner, isSigner: true, isWritable: false },
    { pubkey: ownerBase, isSigner: false, isWritable: true },
    { pubkey: ownerToken, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId: accounts.programId, keys, data });
}

export interface GraduateAccounts {
  programId: PublicKey;
  mint: PublicKey;
  baseMint: PublicKey;
  /** Any wallet: `graduate` is permissionless. Pays the transaction fee only. */
  caller: PublicKey;
  /**
   * Pass the `BaseOracle` PDA to arm the oracle trigger; `false` omits it,
   * which leaves only the curve-exhaustion trigger (the program treats the
   * account as `Option<BaseOracle>` and a stale oracle must not be able to
   * block an exhausted curve).
   */
  withOracle: boolean;
}

/**
 * `graduate()` — permissionless. Either trigger: the 80% allocation sold out
 * (no oracle read), or a fresh `BaseOracle` prices the cap at/over $69K.
 * Prepend `sync_price_from_pyth` when a Pyth feed is pinned so the oracle
 * trigger reads a price seconds old, exactly as `/launch/prepare` does.
 */
export function buildGraduateInstruction(accounts: GraduateAccounts): TransactionInstruction {
  const pdas = derivePdas(accounts.programId, accounts.mint, accounts.baseMint);
  const keys = [
    { pubkey: pdas.global, isSigner: false, isWritable: false },
    { pubkey: pdas.curve, isSigner: false, isWritable: true },
    { pubkey: accounts.mint, isSigner: false, isWritable: true },
    { pubkey: accounts.baseMint, isSigner: false, isWritable: false },
    // Anchor encodes an absent `Option<Account>` as the program id itself.
    {
      pubkey: accounts.withOracle ? pdas.oracle : accounts.programId,
      isSigner: false,
      isWritable: false,
    },
    { pubkey: pdas.curveTokenVault, isSigner: false, isWritable: true },
    { pubkey: accounts.caller, isSigner: true, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({
    programId: accounts.programId,
    keys,
    data: anchorDiscriminator('graduate'),
  });
}
