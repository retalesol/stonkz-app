//! Every number here is mirrored in `programs/curve.json` and in
//! `packages/shared`. Changing one without the other two is a bug.

use anchor_lang::prelude::Pubkey;
use anchor_lang::pubkey;

/// Basis-point denominator.
pub const BPS_DEN: u64 = 10_000;

/* -------------------------------------------------------------------------- */
/* Fee split — see SPEC.md §2                                                  */
/* -------------------------------------------------------------------------- */
// The fee split, the creator fee bounds, the cashback window and the
// graduation cap are the *defaults* of the admin-settable `Params` account
// (`set_params`). Until that account exists the program runs on exactly
// these numbers.

/// Platform revenue share of the curve fee (15%).
pub const FEE_PROTOCOL_BPS: u64 = 1_500;
/// `$STONKZ` buyback share of the curve fee (10%): the keeper buys `$STONKZ`;
/// half of what it buys goes into crates, half is burned.
/// (The vault keeps its historical `ops` name on chain and on the wire.)
pub const FEE_OPS_BPS: u64 = 1_000;
/// RWA crate fund share of the curve fee (6%): buys real-world assets for
/// crates. (The former burn vault; it keeps its historical `burn` name on chain
/// and on the wire.)
pub const FEE_BURN_BPS: u64 = 600;
/// The creator bucket is deliberately *not* a constant: it is the remainder,
/// so the four shares sum to the fee exactly. This value exists only so tests
/// and the IDL can assert the nominal 69%.
pub const FEE_CREATOR_BUCKET_BPS_NOMINAL: u64 = 6_900;

/// Creator-set curve fee bounds, matching the launch slider's 1.0–5.0%.
pub const MIN_FEE_BPS: u16 = 100;
pub const MAX_FEE_BPS: u16 = 500;

/* -------------------------------------------------------------------------- */
/* Curve shape — see SPEC.md §1                                                */
/* -------------------------------------------------------------------------- */

/// Fraction of supply sellable on the curve: 4/5.
pub const TOKENS_FOR_SALE_NUM: u128 = 4;
pub const TOKENS_FOR_SALE_DEN: u128 = 5;

/// Initial virtual token reserves as a multiple of supply: 16/15.
/// Forced by the "LP opens at the curve's closing price" constraint given the
/// 4/5 sale fraction.
pub const VIRTUAL_TOKEN_NUM: u128 = 16;
pub const VIRTUAL_TOKEN_DEN: u128 = 15;

/// Initial virtual base reserves as a fraction of the graduation market cap.
pub const VIRTUAL_BASE_DEN: u128 = 15;

/// $69,000, scaled 1e6.
pub const GRAD_MCAP_USD_1E6: u128 = 69_000_000_000;

/// Launched mints always use 6 decimals.
pub const TOKEN_DECIMALS: u8 = 6;

/// The four supplies the launch stepper offers, in whole tokens.
pub const ALLOWED_SUPPLIES: [u64; 4] = [1_000_000, 500_000_000, 1_000_000_000, 1_000_000_000_000];

/// The binding safety constraint on curve size.
///
/// SPL token amounts are `u64`, and `real_base` reaches `3 · virtual_base` by
/// graduation while `virtual_base` itself reaches `4 · virtual_base_0`. So the
/// real limit is not `k` — which sits four orders of magnitude below the `u128`
/// roof even for the largest supply against the cheapest base — it is that the
/// graduated base reserve still fits a `u64`. `create_token` rejects any
/// (supply, base price, base decimals) combination that would not.
///
/// This is what rules out very low-priced 18-decimal base mints on Solana. The
/// EVM mirror uses `uint256` and is strictly more permissive.
pub const MAX_VIRTUAL_BASE: u128 = (u64::MAX as u128) / 4;

/* -------------------------------------------------------------------------- */
/* Cashback — see SPEC.md §3                                                   */
/* -------------------------------------------------------------------------- */

/// Cashback window, seconds. The UI's `CB_MS` is this × 1000.
pub const CB_WINDOW_SECS: i64 = 300;
/// The fee the window decays down from: 50%.
pub const CB_START_FEE_BPS: u64 = 5_000;

/* -------------------------------------------------------------------------- */
/* Staking — see SPEC.md §2                                                    */
/* -------------------------------------------------------------------------- */

/// Selectable lock terms, days.
pub const LOCK_DAYS: [u16; 7] = [0, 1, 7, 30, 90, 180, 365];

/// Pool weight per lock term, basis points of the staked amount.
///
/// FLEX (index 0) is **zero**: a 0-day position parks tokens but earns no share
/// of the creator bucket. The UI's `LOCKS` table shows 1× for FLEX — that is
/// display chrome for the lock grid, not pool weight. Anti-wash, plan step 134.
pub const LOCK_WEIGHT_BPS: [u64; 7] = [0, 11_000, 12_500, 15_000, 25_000, 50_000, 80_000];

/// Fixed-point scale for the reward-per-weight accumulators.
///
/// The accumulator divides a reward in *base* atoms by a weight in *launched
/// token* atoms, so the scale has to span the gap between two unrelated
/// magnitudes. `1e12` is not enough: the largest allowed supply is 1e12 tokens,
/// which at 6 decimals and the 365-day multiplier gives a fully-staked weight
/// of 8e18, and `reward · 1e12 / 8e18` truncates to **zero** for any reward
/// under 8 million atoms. Stakers on such a coin would accrue nothing at all
/// while the pool banked their entire share as dust — silent, with no error
/// anywhere. Even a 1e9-supply coin only resolved to about 1 part in 125.
///
/// `1e18` gives every allowed supply at least five significant digits per
/// accrual, and the products stay inside `u128`: `amount · ACC_PRECISION` peaks
/// near 1.8e37, and `weight · (acc − debt)` is bounded by total rewards times
/// the scale — also about 1.8e37 — against a 3.4e38 ceiling.
///
/// The EVM mirror uses `1e36` for the same reason and by the same argument; its
/// launched tokens are 18 decimals rather than 6, so its gap is twelve orders
/// wider. This is the one constant the two chains are allowed to disagree on,
/// because it is a function of token decimals and not of the fee model.
pub const ACC_PRECISION: u128 = 1_000_000_000_000_000_000;

/* -------------------------------------------------------------------------- */
/* Oracle                                                                      */
/* -------------------------------------------------------------------------- */

/// Default max age of an oracle push before it is considered stale, seconds.
pub const DEFAULT_MAX_ORACLE_STALENESS: i64 = 90;

/// Reject an oracle read whose confidence exceeds this fraction of the price.
pub const MAX_ORACLE_CONF_BPS: u64 = 200;

/* -------------------------------------------------------------------------- */
/* PDA seeds                                                                   */
/* -------------------------------------------------------------------------- */

pub const SEED_GLOBAL: &[u8] = b"global";
pub const SEED_ORACLE: &[u8] = b"oracle";
pub const SEED_CURVE: &[u8] = b"curve";
pub const SEED_MINT: &[u8] = b"mint";
pub const SEED_CURVE_BASE_VAULT: &[u8] = b"curve_base";
pub const SEED_CURVE_TOKEN_VAULT: &[u8] = b"curve_token";
pub const SEED_LP_VAULT: &[u8] = b"lp_vault";
pub const SEED_BUCKET_BASE_VAULT: &[u8] = b"bucket_base";
pub const SEED_BUCKET_TOKEN_VAULT: &[u8] = b"bucket_token";
pub const SEED_STAKE_ESCROW: &[u8] = b"stake_escrow";
pub const SEED_STAKE_POSITION: &[u8] = b"stake";
pub const SEED_PROTOCOL_VAULT: &[u8] = b"protocol_vault";
pub const SEED_OPS_VAULT: &[u8] = b"ops_vault";
pub const SEED_BURN_VAULT: &[u8] = b"burn_vault";

/* -------------------------------------------------------------------------- */
/* Graduation migration (Meteora DLMM) — see SPEC.md §5 and §6                */
/* -------------------------------------------------------------------------- */

/// Program-derived escrow per mint. Signs as DLMM funder / position base /
/// liquidity sender via `invoke_signed`. Holds temporary ATAs for the deposit.
/// No wallet — not even `migration_authority` — controls this key.
pub const SEED_METEORA_ESCROW: &[u8] = b"meteora_escrow";

/// Legacy seed kept so existing PDA addresses from the Raydium path remain
/// documented; new migrations use `SEED_METEORA_ESCROW` only.
pub const SEED_RAYDIUM_ESCROW: &[u8] = b"raydium_escrow";

/// Meteora `lb_clmm` seeds (from the published IDL / commons crate). Copied
/// here rather than depending on a foreign Anchor CPI crate — see `graduate.rs`.
pub const METEORA_BIN_ARRAY_SEED: &[u8] = b"bin_array";
pub const METEORA_ORACLE_SEED: &[u8] = b"oracle";
pub const METEORA_BITMAP_SEED: &[u8] = b"bitmap";
pub const METEORA_POSITION_SEED: &[u8] = b"position";
pub const METEORA_EVENT_AUTHORITY_SEED: &[u8] = b"__event_authority";

/// ILM base key for customizable permissionless LB pair PDAs (reference).
#[allow(dead_code)]
pub const METEORA_ILM_BASE: Pubkey = pubkey!("MFGQxwAmB91SwuYX36okv2Qmdc9aMuHTwWGUrp4AtB1");

/// DLMM has no fungible LP mint. The graduation position is owned by the
/// per-mint escrow PDA (`SEED_METEORA_ESCROW`), which only this program can
/// sign for, and no instruction of this program removes its liquidity. DLMM's
/// operator timelock (`initialize_position_by_operator`, `lock_release_point`)
/// is whitelisted to Meteora-approved operators and unavailable here — see
/// `graduate.rs` step 4.

/// Bins per bin-array / default position width.
pub const METEORA_MAX_BIN_PER_ARRAY: i32 = 70;
pub const METEORA_DEFAULT_BIN_PER_POSITION: i32 = 70;

/// Q64.64 scale used by DLMM bin prices.
pub const METEORA_SCALE_OFFSET: u8 = 64;
pub const METEORA_ONE_Q64: u128 = 1u128 << 64;
pub const METEORA_BASIS_POINT_MAX: i32 = 10_000;

/// `initialize_lb_pair2` discriminator (`sha256("global:initialize_lb_pair2")[..8]`).
pub const METEORA_INIT_LB_PAIR2_DISCRIMINATOR: [u8; 8] = [73, 59, 36, 120, 237, 83, 108, 198];
/// `initialize_bin_array`
pub const METEORA_INIT_BIN_ARRAY_DISCRIMINATOR: [u8; 8] = [35, 86, 19, 185, 78, 212, 75, 211];
/// `initialize_position_pda` (`sha256("global:initialize_position_pda")[..8]`).
pub const METEORA_INIT_POSITION_PDA_DISCRIMINATOR: [u8; 8] = [46, 82, 125, 146, 85, 141, 228, 153];
/// `add_liquidity2` (explicit per-bin distribution; bin arrays as remaining accounts).
pub const METEORA_ADD_LIQUIDITY2_DISCRIMINATOR: [u8; 8] = [228, 162, 78, 28, 70, 219, 116, 115];
/// `BinLiquidityDistribution.distribution_{x,y}` for "all of it", in bps.
pub const METEORA_BPS_ALL: u16 = 10_000;


/// Rent the escrow PDA must front inside `migrate_seed_liquidity`: the bin
/// array (10,136 B ≈ 0.0715 SOL) and the `PositionV2` (8,128 B ≈ 0.0574 SOL),
/// ≈ 0.129 SOL together. Moved from `migration_authority` to the escrow before
/// the CPIs and refunded net of what was spent afterwards, so the exact figure
/// only needs to be an upper bound. (Was 0.08 SOL, which covered the bin array
/// and then failed the position with "insufficient lamports".)
pub const METEORA_MIGRATION_RENT_BUFFER_LAMPORTS: u64 = 150_000_000; // 0.15 SOL

/// Byte offset of `LbPair.active_id` (i32), including the 8-byte Anchor discriminator.
pub const METEORA_LB_PAIR_ACTIVE_ID_OFFSET: usize = 76;
/// Byte offset of `LbPair.bin_step` (u16).
pub const METEORA_LB_PAIR_BIN_STEP_OFFSET: usize = 80;
/// Byte offset of `PresetParameter2.bin_step` (u16) after the 8-byte discriminator.
pub const METEORA_PRESET2_BIN_STEP_OFFSET: usize = 8;
/// `PositionV2` layout (lb_clmm IDL 0.12.0), byte offsets including the 8-byte
/// Anchor discriminator. The three big arrays come first:
/// `liquidity_shares: [u128; 70]` (1120 B), `reward_infos: [UserRewardInfo; 70]`
/// (70 × 48 B) and `fee_infos: [FeeInfo; 70]` (70 × 48 B), so the scalar tail
/// starts at 7912. `claim_dex_fees` verifies the position against these.
pub const METEORA_POSITION_LB_PAIR_OFFSET: usize = 8;
pub const METEORA_POSITION_OWNER_OFFSET: usize = 8 + 32;
/// `lower_bin_id: i32` at 7912, `upper_bin_id` 7916, `last_updated_at` 7920,
/// `total_claimed_fee_{x,y}` 7928 / 7936, `total_claimed_rewards` 7944.
pub const METEORA_POSITION_OPERATOR_OFFSET: usize = 7960;
pub const METEORA_POSITION_LOCK_RELEASE_OFFSET: usize = 7992;
/// `_padding_0: u8` at 8000, then `fee_owner`.
pub const METEORA_POSITION_FEE_OWNER_OFFSET: usize = 8001;
pub const METEORA_POSITION_MIN_LEN: usize = 8001 + 32;

/// `claim_fee2` discriminator (`sha256("global:claim_fee2")[..8]`).
pub const METEORA_CLAIM_FEE2_DISCRIMINATOR: [u8; 8] = [112, 191, 101, 171, 28, 144, 127, 187];
/// SPL Memo v2, a required (unused) account of every DLMM v2 instruction.
pub const SPL_MEMO_PROGRAM_ID: Pubkey = pubkey!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/* -------------------------------------------------------------------------- */
/* Metaplex Token Metadata — written once by `create_token`                   */
/* -------------------------------------------------------------------------- */

/// Metaplex Token Metadata program. `create_token` pins it with `address =`,
/// so the CPI can never be pointed at a look-alike program.
pub const TOKEN_METADATA_PROGRAM_ID: Pubkey =
    pubkey!("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
/// Metaplex metadata PDA seed: `["metadata", program, mint]` under the
/// Metaplex program.
pub const SEED_METADATA: &[u8] = b"metadata";
/// The emergency pauser config PDA.
pub const SEED_PAUSER: &[u8] = b"pauser";
/// Runtime-tunable parameters (`Params`). Empty / absent means the defaults
/// in this file — see `state::load_params`.
pub const SEED_PARAMS: &[u8] = b"params";
/// `CreateMetadataAccountV3` — Metaplex's native (non-Anchor) one-byte
/// instruction tag.
pub const METAPLEX_CREATE_METADATA_V3_IX: u8 = 33;
/// Metaplex's own field limits (`MAX_NAME_LENGTH` / `MAX_SYMBOL_LENGTH` /
/// `MAX_URI_LENGTH`). `create_token` enforces the same bounds up front so a
/// bad launch fails with a launchpad error rather than a Metaplex one.
pub const METAPLEX_MAX_NAME_LEN: usize = 32;
pub const METAPLEX_MAX_SYMBOL_LEN: usize = 10;
pub const METAPLEX_MAX_URI_LEN: usize = 200;

/* ------------------------------------------------------ referral payouts */

/// Per-base-mint referral payout vault: `["referral_vault", base_mint]`, a
/// token account whose authority is the data-less `SEED_REFERRAL_AUTHORITY`
/// PDA (never `global`, so `withdraw_treasury` cannot reach it).
pub const SEED_REFERRAL_VAULT: &[u8] = b"referral_vault";
pub const SEED_REFERRAL_AUTHORITY: &[u8] = b"referral_authority";
/// Signer / pause / daily cap for referral claims (`ReferralConfig`).
pub const SEED_REFERRAL_CONFIG: &[u8] = b"referral_config";
/// One recipient's lifetime-claimed counter per base mint (`ReferralClaimState`).
pub const SEED_REFERRAL_CLAIM: &[u8] = b"referral_claim";
/// Leading bytes of every referral voucher the API signs.
pub const REFERRAL_MESSAGE_PREFIX: &[u8] = b"STONKZ_REFERRAL_V1";
