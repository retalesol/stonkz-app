use anchor_lang::prelude::*;

/// Matches the indexer's `TokenCreated`.
#[event]
pub struct TokenCreated {
    pub mint: Pubkey,
    pub base_mint: Pubkey,
    pub creator: Pubkey,
    pub ticker: String,
    pub supply: u64,
    pub fee_bps: u16,
    pub cashback: bool,
    pub cb_start: i64,
    pub virtual_base: u128,
    pub virtual_token: u128,
    pub tokens_for_sale: u64,
    pub lp_reserve: u64,
    pub grad_mcap_base: u128,
    pub base_price_1e6: u64,
    pub ts: i64,
}

/// Matches the indexer's `Trade`. `fee_*` fields carry the settled split, so
/// the indexer never has to recompute it.
#[event]
pub struct Trade {
    pub mint: Pubkey,
    pub trader: Pubkey,
    pub is_buy: bool,
    pub base_amount: u64,
    pub token_amount: u64,
    pub eff_fee_bps: u16,
    pub in_cashback: bool,
    pub fee_total: u64,
    pub fee_protocol: u64,
    pub fee_ops: u64,
    /// RWA crate fund leg (6%). Historical `burn` name.
    pub fee_burn: u64,
    pub fee_creator_bucket: u64,
    /// The slice of the creator bucket peeled off to this coin's stakers.
    pub fee_stakers: u64,
    /// The rest of the bucket, credited to the creator.
    pub fee_creator: u64,
    /// Non-zero only during cashback: the bucket converted to the token.
    pub cashback_tokens: u64,
    pub virtual_base: u128,
    pub virtual_token: u128,
    pub real_base: u64,
    pub real_token: u64,
    pub circulating: u64,
    pub ts: i64,
}

/// Matches the indexer's `FeeAccrued` — the 15/10/6/69 view on its own, for
/// reconciliation against `Trade`.
#[event]
pub struct FeeAccrued {
    pub mint: Pubkey,
    pub base_mint: Pubkey,
    pub fee_total: u64,
    pub protocol: u64,
    pub ops: u64,
    pub burn: u64,
    pub creator_bucket: u64,
    pub ts: i64,
}

/// Matches the indexer's `TreasuryCredit`.
#[event]
pub struct TreasuryCredit {
    pub base_mint: Pubkey,
    pub protocol_delta: u64,
    pub ops_delta: u64,
    pub burn_delta: u64,
    pub ts: i64,
}

#[event]
pub struct Graduated {
    pub mint: Pubkey,
    pub base_mint: Pubkey,
    pub reason: u8,
    pub base_migrated: u64,
    pub tokens_migrated: u64,
    /// Unsold curve tokens burned on an early oracle-triggered graduation.
    pub tokens_burned: u64,
    pub mcap_base: u128,
    pub mcap_usd_1e6: u128,
    pub ts: i64,
}

/// Emitted once per coin, when `migrate_seed_liquidity` deposits into a Meteora
/// DLMM position and permanently locks it (owner → dead / lock_release = max).
/// DLMM has no fungible LP mint; `position` is the PositionV2 account.
#[event]
pub struct LiquidityMigrated {
    pub mint: Pubkey,
    pub base_mint: Pubkey,
    pub pool: Pubkey,
    /// DLMM PositionV2 account (replaces the former Raydium `lp_mint` field).
    pub position: Pubkey,
    pub base_deposited: u64,
    pub token_deposited: u64,
    /// `lock_release_point` on the position. `0`: DLMM's operator timelock is
    /// not available to a non-whitelisted operator (see `graduate.rs` step 4);
    /// permanence is the program escrow owning the position with no withdraw
    /// instruction.
    pub lock_release_point: u64,
    /// `1` once the position is held by the per-mint escrow PDA.
    pub position_locked: u64,
    pub ts: i64,
}

#[event]
pub struct CreatorFeesClaimed {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub base_amount: u64,
    pub token_amount: u64,
    pub ts: i64,
}

#[event]
pub struct Staked {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub lock_days: u16,
    pub weight: u128,
    pub lock_until: i64,
    pub eligible_staked: u64,
    pub total_weight: u128,
    pub ts: i64,
}

#[event]
pub struct Unstaked {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub eligible_staked: u64,
    pub total_weight: u128,
    pub ts: i64,
}

#[event]
pub struct StakeClaimed {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub base_amount: u64,
    pub token_amount: u64,
    pub ts: i64,
}

#[event]
pub struct TreasuryWithdrawn {
    pub base_mint: Pubkey,
    /// 0 = protocol revenue, 1 = `$STONKZ` ops.
    pub which: u8,
    pub amount: u64,
    pub destination: Pubkey,
    pub ts: i64,
}

/// Fees claimed from the escrow-held Meteora DLMM position and routed
/// through the curve's own split. Base-side legs go to the same per-base-mint
/// treasuries as curve fees; the launched-token side has no treasury, so its
/// non-bucket legs are burned and only the 69% bucket (creator + stakers) is
/// credited in tokens.
#[event]
pub struct DexFeesClaimed {
    pub mint: Pubkey,
    pub base_mint: Pubkey,
    pub pool: Pubkey,
    pub position: Pubkey,
    /// Whoever cranked it. Permissionless.
    pub caller: Pubkey,
    pub fee_base: u64,
    pub fee_token: u64,
    pub protocol: u64,
    pub ops: u64,
    pub burn: u64,
    pub creator_bucket_base: u64,
    pub creator_bucket_token: u64,
    pub to_creator_base: u64,
    pub to_stakers_base: u64,
    pub to_creator_token: u64,
    pub to_stakers_token: u64,
    pub tokens_burned: u64,
    pub ts: i64,
}

/// A referral voucher was redeemed: `amount` left the referral vault for
/// `recipient`, whose lifetime claimed is now `cumulative_amount`.
#[event]
pub struct ReferralClaimed {
    pub base_mint: Pubkey,
    pub vault: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub cumulative_amount: u64,
    pub ts: i64,
}

/// `fund_referral_vault` (a `withdraw_treasury` into the vault emits
/// `TreasuryWithdrawn` instead).
#[event]
pub struct ReferralVaultFunded {
    pub base_mint: Pubkey,
    pub vault: Pubkey,
    pub funder: Pubkey,
    pub amount: u64,
    pub ts: i64,
}

/// `set_referral_signer` / `set_referral_paused`: the config after the change.
#[event]
pub struct ReferralConfigSet {
    pub signer: Pubkey,
    pub max_per_day: u64,
    pub cluster_tag: [u8; 8],
    pub paused: bool,
    pub ts: i64,
}

/// `set_params`: the runtime parameters after the change.
#[event]
pub struct ParamsSet {
    pub fee_protocol_bps: u16,
    pub fee_ops_bps: u16,
    pub fee_burn_bps: u16,
    pub min_fee_bps: u16,
    pub max_fee_bps: u16,
    pub cb_start_fee_bps: u16,
    pub cb_window_secs: u32,
    pub grad_mcap_usd_1e6: u64,
    pub ts: i64,
}
