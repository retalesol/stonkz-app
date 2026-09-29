use anchor_lang::prelude::*;

/// Program-wide configuration and the pause switches.
///
/// `admin`, `protocol_withdraw_authority` and `ops_withdraw_authority` are
/// three separate keys on purpose. The admin can pause but cannot move money;
/// the two withdraw authorities can move money but cannot pause. Neither
/// withdraw authority may be a server hot key — see SPEC.md §4.
#[account]
#[derive(InitSpace)]
pub struct Global {
    pub bump: u8,
    pub admin: Pubkey,
    /// Two-step admin handover; `Pubkey::default()` when no handover is open.
    pub pending_admin: Pubkey,
    /// Multisig / cold key. Withdraws protocol revenue.
    pub protocol_withdraw_authority: Pubkey,
    /// Multisig / cold key, distinct from the protocol one. Withdraws ops.
    pub ops_withdraw_authority: Pubkey,
    /// Pushes base-mint USD prices. A Pyth/Switchboard crank in production.
    pub oracle_authority: Pubkey,
    /// Runs migration after a graduation: creates the Meteora DLMM pool and
    /// permanently locks the position. See SPEC.md §5.
    pub migration_authority: Pubkey,
    /// Meteora `lb_clmm` program. Admin-settable via `set_meteora_config`.
    /// Layout-compatible rename of the former `raydium_program` slot.
    pub dex_program: Pubkey,
    /// Meteora `PresetParameter2` (fee / bin-step tier) every graduation pool
    /// is created under. Layout-compatible rename of `raydium_amm_config`.
    pub dex_config: Pubkey,
    /// Halts buy and sell. Does not block claims or unstakes.
    pub trading_paused: bool,
    /// Halts create_token only.
    pub launch_paused: bool,
    /// Runbook switch: stop protocol revenue leaving, trading unaffected.
    pub protocol_withdrawals_paused: bool,
    /// Runbook switch from plan step 141: stop ops funds leaving while trading
    /// and accrual both continue.
    pub ops_withdrawals_paused: bool,
    /// Max age, seconds, of an oracle push before graduation pricing refuses it.
    pub max_oracle_staleness: i64,
    pub token_count: u64,
}

/// A pushed USD price for one base mint.
#[account]
#[derive(InitSpace)]
pub struct BaseOracle {
    pub bump: u8,
    pub base_mint: Pubkey,
    /// USD per whole base token, scaled 1e6.
    pub price_1e6: u64,
    /// Confidence band in the same scale.
    pub conf_1e6: u64,
    pub publish_time: i64,
    pub base_decimals: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum GraduationReason {
    /// The 80% curve allocation sold out. Needs no oracle.
    CurveComplete,
    /// A fresh oracle put the USD cap at or above $69K while tokens remained.
    OraclePrice,
}

/// One launched coin: its curve, its fee ledger, and its stake pool.
#[account]
#[derive(InitSpace)]
pub struct Curve {
    pub bump: u8,
    pub mint: Pubkey,
    pub base_mint: Pubkey,
    pub creator: Pubkey,
    #[max_len(10)]
    pub ticker: String,

    pub supply: u64,
    pub decimals: u8,
    pub base_decimals: u8,
    /// Creator-set curve fee, 100–500 bps.
    pub fee_bps: u16,
    pub cashback: bool,
    /// Set once by the program at creation. No instruction can move it, so the
    /// 5-minute window cannot be extended by any client.
    pub cb_start: i64,

    /* curve state, all in atoms */
    pub virtual_base: u128,
    pub virtual_token: u128,
    pub real_base: u64,
    pub real_token: u64,
    pub k: u128,
    pub init_virtual_base: u128,
    pub init_virtual_token: u128,
    pub tokens_for_sale: u64,
    pub lp_reserve: u64,

    /* graduation */
    /// Base atoms equal to $69,000 at the price read when the coin launched.
    pub grad_mcap_base: u128,
    pub creation_base_price_1e6: u64,
    /// Allocation exhausted: no further buys, awaiting `graduate`.
    pub complete: bool,
    pub graduated: bool,
    pub graduation_reason: Option<GraduationReason>,
    pub graduated_at: i64,
    /// Set once `migrate_seed_liquidity` has deposited reserves into the
    /// escrow-owned Meteora DLMM position. Once true, `real_base` /
    /// `lp_reserve` are zero and seeding refuses to run again.
    pub migrated: bool,
    /// Meteora DLMM `LbPair` address. Set by `migrate_create_pool`; verifiable
    /// independently on a block explorer. Layout-compatible rename of
    /// `raydium_pool`.
    pub dex_pool: Pubkey,
    /// Packed migration meta: lower 32 bits = `lower_bin_id` as u32 bit pattern,
    /// upper 32 bits = position `width` as u32. Enough to re-derive the DLMM
    /// position PDA with the escrow as base. Replaces `raydium_lp_burned`.
    pub dex_position_meta: u64,

    /* fee ledger — lifetime totals, for the indexer to reconcile against */
    pub protocol_accrued: u64,
    pub ops_accrued: u64,
    pub creator_bucket_accrued: u64,
    /// Claimable by the creator, base mint. Never includes protocol or ops.
    pub creator_claimable_base: u64,
    /// Claimable by the creator, launched token. Cashback window only.
    pub creator_claimable_token: u64,

    /* stake pool — funded exclusively out of the creator bucket */
    /// Staked amount with a lock of at least 1 day. FLEX is excluded so a
    /// zero-weight position cannot dilute `poolFrac`.
    pub eligible_staked: u64,
    /// FLEX escrow. Parked, zero weight, excluded from `poolFrac`.
    pub flex_staked: u64,
    pub total_weight: u128,
    pub acc_base_per_weight: u128,
    pub acc_token_per_weight: u128,
    /// Rewards accrued but not yet divisible across the pool. Held, not lost.
    pub pool_dust_base: u64,
    pub pool_dust_token: u64,
    pub staker_accrued_base: u64,
    pub staker_accrued_token: u64,
}

/// One staker's position in one coin. Seeds bind it to that coin's mint, so
/// weight in one pool can never settle against another's accumulator.
#[account]
#[derive(InitSpace)]
pub struct StakePosition {
    pub bump: u8,
    pub curve: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub lock_days: u16,
    pub weight: u128,
    pub lock_until: i64,
    pub base_debt: u128,
    pub token_debt: u128,
    pub unclaimed_base: u64,
    pub unclaimed_token: u64,
}

/// Who may pause. Separate from `Global` so appointing a pauser never
/// reallocates the account every instruction reads.
#[account]
#[derive(InitSpace)]
pub struct PauserConfig {
    pub bump: u8,
    pub pauser: Pubkey,
}

/// Referral payout configuration, appended in its own PDA
/// (`["referral_config"]`) so no existing account layout changes. Admin sets
/// `signer` (the API's Ed25519 voucher key), `max_per_day` (base atoms, the
/// blast radius of a leaked signer; `0` refuses every claim, `u64::MAX`
/// uncapped) and `cluster_tag`; admin or the pauser sets `paused`.
#[account]
#[derive(InitSpace)]
pub struct ReferralConfig {
    pub bump: u8,
    pub signer: Pubkey,
    pub paused: bool,
    pub max_per_day: u64,
    /// Start of the rolling day `claimed_today` counts against.
    pub day_start: i64,
    pub claimed_today: u64,
    /// 8-byte cluster marker every voucher carries (`b"mainnet\0"`, …).
    pub cluster_tag: [u8; 8],
}

/// Lifetime referral amount already paid to one recipient for one base mint
/// (`["referral_claim", base_mint, recipient]`). A voucher pays
/// `cumulative_amount - claimed`.
#[account]
#[derive(InitSpace)]
pub struct ReferralClaimState {
    pub bump: u8,
    pub base_mint: Pubkey,
    pub recipient: Pubkey,
    pub claimed: u64,
}
