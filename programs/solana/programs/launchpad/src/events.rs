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
    /// Buyback-and-burn leg (10%).
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

/// Matches the indexer's `FeeAccrued` — the 20/10/70 view on its own, for
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
    /// `lock_release_point` written on the position (`u64::MAX` = permanent).
    pub lock_release_point: u64,
    /// Non-zero once the position operator has been cleared to the dead address.
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
