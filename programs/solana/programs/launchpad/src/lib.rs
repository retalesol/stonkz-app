//! Stonkz launchpad — Solana half of Phase 2.A and Phase 4.A/4.B/4.C.
//!
//! The curve is denominated in the **base mint** and never touches native SOL
//! unless the base mint is wrapped SOL. Native-in routing is the router's job,
//! in front of this instruction, in the same transaction.
//!
//! Read `programs/SPEC.md` before changing the arithmetic. The short version:
//!
//! - Virtual reserves are `16/15·supply` and `grad_mcap_base/15`, with 4/5 of
//!   supply sellable. Those three numbers make the curve close at exactly $69K
//!   and make the graduation pool open at the curve's closing price.
//! - Every fee splits 15% platform / 10% `$STONKZ` buyback (`ops`) / 6% RWA
//!   crate fund (`burn`) / remainder (69%) to the creator bucket. The
//!   remainder form is what makes the split exact.
//! - The staker peel happens strictly inside the creator bucket, after the
//!   other three shares have already left for their own vaults.

use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod math;
pub mod metaplex;
pub mod pyth;
pub mod state;

#[cfg(test)]
mod parity;
#[cfg(test)]
mod tests;

use instructions::*;

declare_id!("FF1f3V47FtApwWWMHX462Gm7NVqNpUJ7K4yqKrYGSMbg");

#[program]
pub mod launchpad {
    use super::*;

    /* ---------------------------------------------------------------- admin */

    pub fn initialize(
        ctx: Context<Initialize>,
        admin: Pubkey,
        protocol_withdraw_authority: Pubkey,
        ops_withdraw_authority: Pubkey,
        oracle_authority: Pubkey,
        migration_authority: Pubkey,
    ) -> Result<()> {
        instructions::admin::initialize(
            ctx,
            admin,
            protocol_withdraw_authority,
            ops_withdraw_authority,
            oracle_authority,
            migration_authority,
        )
    }

    pub fn set_pause(
        ctx: Context<AdminOnly>,
        trading: Option<bool>,
        launch: Option<bool>,
        protocol_withdrawals: Option<bool>,
        ops_withdrawals: Option<bool>,
    ) -> Result<()> {
        instructions::admin::set_pause(ctx, trading, launch, protocol_withdrawals, ops_withdrawals)
    }

    pub fn set_oracle_authority(ctx: Context<AdminOnly>, authority: Pubkey) -> Result<()> {
        instructions::admin::set_oracle_authority(ctx, authority)
    }

    pub fn set_max_oracle_staleness(ctx: Context<AdminOnly>, secs: i64) -> Result<()> {
        instructions::admin::set_max_oracle_staleness(ctx, secs)
    }

    /// Which Meteora DLMM program and `PresetParameter2` migration CPIs into.
    pub fn set_meteora_config(
        ctx: Context<AdminOnly>,
        program: Pubkey,
        preset: Pubkey,
    ) -> Result<()> {
        instructions::admin::set_meteora_config(ctx, program, preset)
    }

    /// Deprecated alias — same Global slots as `set_meteora_config`.
    pub fn set_raydium_config(
        ctx: Context<AdminOnly>,
        program: Pubkey,
        amm_config: Pubkey,
    ) -> Result<()> {
        instructions::admin::set_meteora_config(ctx, program, amm_config)
    }

    pub fn set_withdraw_authorities(
        ctx: Context<AdminOnly>,
        protocol: Option<Pubkey>,
        ops: Option<Pubkey>,
    ) -> Result<()> {
        instructions::admin::set_withdraw_authorities(ctx, protocol, ops)
    }

    pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        instructions::admin::propose_admin(ctx, new_admin)
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        instructions::admin::accept_admin(ctx)
    }

    pub fn push_price(ctx: Context<PushPrice>, price_1e6: u64, conf_1e6: u64) -> Result<()> {
        instructions::admin::push_price(ctx, price_1e6, conf_1e6)
    }

    /* ------------------------------------------------------------ treasuries */

    pub fn init_treasury(ctx: Context<InitTreasury>) -> Result<()> {
        instructions::admin::init_treasury(ctx)
    }

    pub fn withdraw_treasury(
        ctx: Context<WithdrawTreasury>,
        which: Treasury,
        amount: u64,
    ) -> Result<()> {
        instructions::admin::withdraw_treasury(ctx, which, amount)
    }

    /* -------------------------------------------------------------- launchpad */

    pub fn create_token(
        ctx: Context<CreateToken>,
        name: String,
        ticker: String,
        uri: String,
        supply: u64,
        fee_bps: u16,
        cashback: bool,
        salt: u64,
    ) -> Result<()> {
        instructions::create_token::create_token(
            ctx, name, ticker, uri, supply, fee_bps, cashback, salt,
        )
    }

    /// `amount_base` in, at least `min_out` tokens back. Slippage is enforced
    /// on this hop alone; the aggregator hop carries its own bound.
    pub fn buy(ctx: Context<TradeCtx>, amount_base: u64, min_out: u64) -> Result<()> {
        instructions::trade::buy(ctx, amount_base, min_out)
    }

    /// `amount_token` in, at least `min_out` base back **after** the curve fee.
    pub fn sell(ctx: Context<TradeCtx>, amount_token: u64, min_out: u64) -> Result<()> {
        instructions::trade::sell(ctx, amount_token, min_out)
    }

    pub fn graduate(ctx: Context<Graduate>) -> Result<()> {
        instructions::graduate::graduate(ctx)
    }

    /// Step 1 of migration: create the Meteora DLMM LB pair at curve close price.
    pub fn migrate_create_pool(ctx: Context<MigrateCreatePool>) -> Result<()> {
        instructions::graduate::migrate_create_pool(ctx)
    }

    /// Step 2 of migration: seed liquidity, lock the position permanently.
    pub fn migrate_seed_liquidity(ctx: Context<MigrateSeedLiquidity>) -> Result<()> {
        instructions::graduate::migrate_seed_liquidity(ctx)
    }

    /// Permissionless crank: claim the locked DLMM position's swap fees into
    /// the curve's own 15 / 10 / 6 / 69 split, so post-bond fees keep flowing
    /// to the protocol, the buyback, the crate fund, the creator and stakers.
    pub fn claim_dex_fees(ctx: Context<ClaimDexFees>) -> Result<()> {
        instructions::graduate::claim_dex_fees(ctx)
    }

    /// Creator bucket only. Cannot reach the protocol or ops vaults.
    pub fn claim_creator_fees(ctx: Context<ClaimCreatorFees>) -> Result<()> {
        instructions::claim::claim_creator_fees(ctx)
    }

    /* ----------------------------------------------------------- 4.B staking */

    pub fn stake(ctx: Context<Stake>, amount: u64, lock_days: u16) -> Result<()> {
        instructions::stake::stake(ctx, amount, lock_days)
    }

    pub fn unstake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        instructions::stake::unstake(ctx, amount)
    }

    pub fn claim_stake(ctx: Context<ClaimStake>) -> Result<()> {
        instructions::stake::claim_stake(ctx)
    }

    /* ------------------------------------------------------------- oracle */

    /// Permissionless: copy the base mint's pinned Pyth feed (a verified
    /// `PriceUpdateV2`) into its `BaseOracle`. A not-newer update is a no-op.
    /// Appended last so every existing instruction keeps its position.
    pub fn sync_price_from_pyth(ctx: Context<SyncPriceFromPyth>) -> Result<()> {
        instructions::sync_price::sync_price_from_pyth(ctx)
    }

    /* ------------------------------------------------------------- pauser */

    /// Admin appoints the emergency pauser (default pubkey removes it).
    pub fn set_pauser(ctx: Context<SetPauser>, pauser: Pubkey) -> Result<()> {
        instructions::pauser::set_pauser(ctx, pauser)
    }

    /// The pauser can set pause flags and nothing else; unpausing is admin's
    /// `set_pause`.
    pub fn pause(
        ctx: Context<Pause>,
        trading: bool,
        launch: bool,
        protocol_withdrawals: bool,
        ops_withdrawals: bool,
    ) -> Result<()> {
        instructions::pauser::pause(ctx, trading, launch, protocol_withdrawals, ops_withdrawals)
    }
}
