use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::LaunchpadError;
use crate::events::ParamsSet;
use crate::state::*;

/// Everything on `Params` an admin can set. Same field order as the account
/// minus `bump` / `_reserved`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct ParamsArgs {
    pub fee_protocol_bps: u16,
    pub fee_ops_bps: u16,
    pub fee_burn_bps: u16,
    pub min_fee_bps: u16,
    pub max_fee_bps: u16,
    pub cb_start_fee_bps: u16,
    pub cb_window_secs: u32,
    pub grad_mcap_usd_1e6: u64,
}

impl From<&Params> for ParamsArgs {
    fn from(p: &Params) -> Self {
        ParamsArgs {
            fee_protocol_bps: p.fee_protocol_bps,
            fee_ops_bps: p.fee_ops_bps,
            fee_burn_bps: p.fee_burn_bps,
            min_fee_bps: p.min_fee_bps,
            max_fee_bps: p.max_fee_bps,
            cb_start_fee_bps: p.cb_start_fee_bps,
            cb_window_secs: p.cb_window_secs,
            grad_mcap_usd_1e6: p.grad_mcap_usd_1e6,
        }
    }
}

/// Runtime parameters live in their own PDA, like the pauser, so `Global`'s
/// layout never changes and no existing account needs a migration. Admin
/// (the Squads vault on mainnet, behind its timelock) is the only writer;
/// every reader tolerates the account not existing yet (`load_params`).
#[derive(Accounts)]
pub struct SetParams<'info> {
    #[account(seeds = [SEED_GLOBAL], bump = global.bump, has_one = admin @ LaunchpadError::Unauthorized)]
    pub global: Box<Account<'info, Global>>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + Params::INIT_SPACE,
        seeds = [SEED_PARAMS],
        bump
    )]
    pub params: Box<Account<'info, Params>>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// The pure validation, shared with the unit tests.
///
/// - the three treasury shares must leave room for the creator bucket
///   (`<= 10_000`; the bucket is the remainder, so it may be zero);
/// - `min_fee_bps <= max_fee_bps <= cb_start_fee_bps <= 10_000`, which is
///   what keeps `eff_fee_bps`'s `u16` arithmetic sound for every creator fee;
/// - a cashback window and a graduation cap of zero make no sense.
pub fn validate_params(a: &ParamsArgs) -> Result<()> {
    let split = a.fee_protocol_bps as u64 + a.fee_ops_bps as u64 + a.fee_burn_bps as u64;
    require!(split <= BPS_DEN, LaunchpadError::ParamsFeeSplitTooLarge);
    require!(
        a.min_fee_bps <= a.max_fee_bps,
        LaunchpadError::ParamsFeeBoundsInvalid
    );
    require!(
        a.max_fee_bps <= a.cb_start_fee_bps && a.cb_start_fee_bps as u64 <= BPS_DEN,
        LaunchpadError::ParamsCashbackStartInvalid
    );
    require!(a.cb_window_secs > 0, LaunchpadError::ParamsCashbackWindowInvalid);
    require!(a.grad_mcap_usd_1e6 > 0, LaunchpadError::ParamsGradMcapInvalid);
    Ok(())
}

/// Apply `args` to `p` (no validation — callers go through
/// [`validate_params`] first).
pub fn apply_params(p: &mut Params, a: &ParamsArgs) {
    p.fee_protocol_bps = a.fee_protocol_bps;
    p.fee_ops_bps = a.fee_ops_bps;
    p.fee_burn_bps = a.fee_burn_bps;
    p.min_fee_bps = a.min_fee_bps;
    p.max_fee_bps = a.max_fee_bps;
    p.cb_start_fee_bps = a.cb_start_fee_bps;
    p.cb_window_secs = a.cb_window_secs;
    p.grad_mcap_usd_1e6 = a.grad_mcap_usd_1e6;
}

pub fn set_params(ctx: Context<SetParams>, args: ParamsArgs) -> Result<()> {
    validate_params(&args)?;
    let p = &mut ctx.accounts.params;
    p.bump = ctx.bumps.params;
    apply_params(p, &args);
    emit!(ParamsSet {
        fee_protocol_bps: p.fee_protocol_bps,
        fee_ops_bps: p.fee_ops_bps,
        fee_burn_bps: p.fee_burn_bps,
        min_fee_bps: p.min_fee_bps,
        max_fee_bps: p.max_fee_bps,
        cb_start_fee_bps: p.cb_start_fee_bps,
        cb_window_secs: p.cb_window_secs,
        grad_mcap_usd_1e6: p.grad_mcap_usd_1e6,
        ts: Clock::get()?.unix_timestamp,
    });
    Ok(())
}
