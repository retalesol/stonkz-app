use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::LaunchpadError;
use crate::state::*;

/// The emergency pauser lives in its own PDA so `Global`'s layout never
/// changes. Admin (the Squads vault on mainnet, behind its timelock) appoints
/// it; the pauser can only ever set pause flags, so a hot key can hold the role.
#[derive(Accounts)]
pub struct SetPauser<'info> {
    #[account(seeds = [SEED_GLOBAL], bump = global.bump, has_one = admin @ LaunchpadError::Unauthorized)]
    pub global: Box<Account<'info, Global>>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + PauserConfig::INIT_SPACE,
        seeds = [SEED_PAUSER],
        bump
    )]
    pub pauser_config: Box<Account<'info, PauserConfig>>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// `Pubkey::default()` removes the role.
pub fn set_pauser(ctx: Context<SetPauser>, pauser: Pubkey) -> Result<()> {
    let p = &mut ctx.accounts.pauser_config;
    p.bump = ctx.bumps.pauser_config;
    p.pauser = pauser;
    Ok(())
}

#[derive(Accounts)]
pub struct Pause<'info> {
    #[account(mut, seeds = [SEED_GLOBAL], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
    #[account(seeds = [SEED_PAUSER], bump = pauser_config.bump)]
    pub pauser_config: Box<Account<'info, PauserConfig>>,
    pub pauser: Signer<'info>,
}

/// Each `true` pauses that switch; `false` leaves it untouched. There is no
/// way to clear a flag here: unpausing is `set_pause`, admin only.
pub fn pause(
    ctx: Context<Pause>,
    trading: bool,
    launch: bool,
    protocol_withdrawals: bool,
    ops_withdrawals: bool,
) -> Result<()> {
    let cfg = &ctx.accounts.pauser_config;
    require!(
        cfg.pauser != Pubkey::default() && cfg.pauser == ctx.accounts.pauser.key(),
        LaunchpadError::Unauthorized
    );
    let g = &mut ctx.accounts.global;
    apply_pause(g, trading, launch, protocol_withdrawals, ops_withdrawals);
    Ok(())
}

/// Set-only: the pure core of `pause`, shared with the unit tests.
pub fn apply_pause(
    g: &mut Global,
    trading: bool,
    launch: bool,
    protocol_withdrawals: bool,
    ops_withdrawals: bool,
) {
    g.trading_paused |= trading;
    g.launch_paused |= launch;
    g.protocol_withdrawals_paused |= protocol_withdrawals;
    g.ops_withdrawals_paused |= ops_withdrawals;
}
