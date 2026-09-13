import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  anchorDiscriminator,
  derivePdas,
  deriveMintPda,
  deriveStakePositionPda,
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

/** `create_token(name, ticker, uri, supply, fee_bps, cashback, salt)` — plan step 90. */
export function buildCreateTokenInstruction(
  accounts: CreateTokenAccounts,
  args: CreateTokenArgs,
): { instruction: TransactionInstruction; mint: PublicKey; curve: PublicKey } {
  const [mint] = deriveMintPda(accounts.programId, accounts.creator, accounts.salt);
  const pdas = derivePdas(accounts.programId, mint, accounts.baseMint);

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
  ];

  return {
    instruction: new TransactionInstruction({ programId: accounts.programId, keys, data }),
    mint,
    curve: pdas.curve,
  };
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
    base: getAssociatedTokenAddressSync(accounts.baseMint, accounts.trader, false, TOKEN_PROGRAM_ID),
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
  const data = Buffer.concat([anchorDiscriminator('buy'), encodeU64(amountBase), encodeU64(minOut)]);
  return new TransactionInstruction({ programId: accounts.programId, keys, data });
}

/** `sell(amount_token, min_out)`. */
export function buildSellInstruction(
  accounts: TradeAccounts,
  amountToken: bigint,
  minOut: bigint,
): TransactionInstruction {
  const { keys } = tradeKeys(accounts);
  const data = Buffer.concat([anchorDiscriminator('sell'), encodeU64(amountToken), encodeU64(minOut)]);
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
  const creatorBase = getAssociatedTokenAddressSync(accounts.baseMint, accounts.creator, false, TOKEN_PROGRAM_ID);
  const creatorToken = getAssociatedTokenAddressSync(accounts.mint, accounts.creator, false, TOKEN_PROGRAM_ID);

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
export function buildUnstakeInstruction(accounts: StakeAccounts, amount: bigint): TransactionInstruction {
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
