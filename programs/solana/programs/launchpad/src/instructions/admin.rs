use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::*;
use crate::errors::LaunchpadError;
use crate::events::*;
use crate::state::*;

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + Global::INIT_SPACE,
        seeds = [SEED_GLOBAL],
        bump
    )]
    pub global: Box<Account<'info, Global>>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn initialize(
    ctx: Context<Initialize>,
    admin: Pubkey,
    protocol_withdraw_authority: Pubkey,
    ops_withdraw_authority: Pubkey,
    oracle_authority: Pubkey,
    migration_authority: Pubkey,
) -> Result<()> {
    let g = &mut ctx.accounts.global;
    g.bump = ctx.bumps.global;
    g.admin = admin;
    g.pending_admin = Pubkey::default();
    g.protocol_withdraw_authority = protocol_withdraw_authority;
    g.ops_withdraw_authority = ops_withdraw_authority;
    g.oracle_authority = oracle_authority;
    g.migration_authority = migration_authority;
    g.trading_paused = false;
    g.launch_paused = false;
    g.protocol_withdrawals_paused = false;
    g.ops_withdrawals_paused = false;
    g.max_oracle_staleness = DEFAULT_MAX_ORACLE_STALENESS;
    g.token_count = 0;
    Ok(())
}

/* -------------------------------------------------------------------------- */
/* Pause switches                                                              */
/* -------------------------------------------------------------------------- */

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, seeds = [SEED_GLOBAL], bump = global.bump, has_one = admin @ LaunchpadError::Unauthorized)]
    pub global: Box<Account<'info, Global>>,
    pub admin: Signer<'info>,
}

/// Each switch is independent. Pausing ops withdrawals is the plan's step-141
/// runbook: money stops leaving, trading and accrual carry on.
pub fn set_pause(
    ctx: Context<AdminOnly>,
    trading: Option<bool>,
    launch: Option<bool>,
    protocol_withdrawals: Option<bool>,
    ops_withdrawals: Option<bool>,
) -> Result<()> {
    let g = &mut ctx.accounts.global;
    if let Some(v) = trading {
        g.trading_paused = v;
    }
    if let Some(v) = launch {
        g.launch_paused = v;
    }
    if let Some(v) = protocol_withdrawals {
        g.protocol_withdrawals_paused = v;
    }
    if let Some(v) = ops_withdrawals {
        g.ops_withdrawals_paused = v;
    }
    Ok(())
}

pub fn set_oracle_authority(ctx: Context<AdminOnly>, authority: Pubkey) -> Result<()> {
    ctx.accounts.global.oracle_authority = authority;
    Ok(())
}

pub fn set_max_oracle_staleness(ctx: Context<AdminOnly>, secs: i64) -> Result<()> {
    require!(secs > 0, LaunchpadError::OracleInvalid);
    ctx.accounts.global.max_oracle_staleness = secs;
    Ok(())
}

/// The withdraw authorities are the keys that can actually move treasury money,
/// so they rotate through the same two-step shape as the admin: propose here,
/// and the new key proves itself by signing the first withdrawal.
pub fn set_withdraw_authorities(
    ctx: Context<AdminOnly>,
    protocol: Option<Pubkey>,
    ops: Option<Pubkey>,
) -> Result<()> {
    let g = &mut ctx.accounts.global;
    if let Some(p) = protocol {
        require!(p != Pubkey::default(), LaunchpadError::Unauthorized);
        g.protocol_withdraw_authority = p;
    }
    if let Some(o) = ops {
        require!(o != Pubkey::default(), LaunchpadError::Unauthorized);
        g.ops_withdraw_authority = o;
    }
    Ok(())
}

pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
    ctx.accounts.global.pending_admin = new_admin;
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    #[account(mut, seeds = [SEED_GLOBAL], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
    pub pending_admin: Signer<'info>,
}

pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let g = &mut ctx.accounts.global;
    require!(
        g.pending_admin != Pubkey::default() && g.pending_admin == ctx.accounts.pending_admin.key(),
        LaunchpadError::Unauthorized
    );
    g.admin = g.pending_admin;
    g.pending_admin = Pubkey::default();
    Ok(())
}

/* -------------------------------------------------------------------------- */
/* Oracle                                                                      */
/* -------------------------------------------------------------------------- */

#[derive(Accounts)]
pub struct PushPrice<'info> {
    #[account(seeds = [SEED_GLOBAL], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
    #[account(
        init_if_needed,
        payer = oracle_authority,
        space = 8 + BaseOracle::INIT_SPACE,
        seeds = [SEED_ORACLE, base_mint.key().as_ref()],
        bump
    )]
    pub oracle: Box<Account<'info, BaseOracle>>,
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = global.oracle_authority @ LaunchpadError::Unauthorized)]
    pub oracle_authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// Publish a USD price for one base mint.
///
/// The account layout, not this instruction, is the interface the rest of the
/// program depends on: swapping to a direct Pyth/Switchboard read means
/// replacing this writer, not touching the curve.
pub fn push_price(ctx: Context<PushPrice>, price_1e6: u64, conf_1e6: u64) -> Result<()> {
    require!(price_1e6 > 0, LaunchpadError::OracleInvalid);
    let o = &mut ctx.accounts.oracle;
    o.bump = ctx.bumps.oracle;
    o.base_mint = ctx.accounts.base_mint.key();
    o.price_1e6 = price_1e6;
    o.conf_1e6 = conf_1e6;
    o.publish_time = Clock::get()?.unix_timestamp;
    o.base_decimals = ctx.accounts.base_mint.decimals;
    Ok(())
}

/// Read an oracle, refusing stale or wide-banded prices.
pub fn read_fresh_price(
    oracle: &BaseOracle,
    global: &Global,
    now: i64,
) -> Result<u64> {
    require!(oracle.price_1e6 > 0, LaunchpadError::OracleInvalid);
    require!(
        now.saturating_sub(oracle.publish_time) <= global.max_oracle_staleness,
        LaunchpadError::OracleStale
    );
    let conf_bps = (oracle.conf_1e6 as u128)
        .saturating_mul(BPS_DEN as u128)
        .checked_div(oracle.price_1e6 as u128)
        .unwrap_or(u128::MAX);
    require!(
        conf_bps <= MAX_ORACLE_CONF_BPS as u128,
        LaunchpadError::OracleUnreliable
    );
    Ok(oracle.price_1e6)
}

/* -------------------------------------------------------------------------- */
/* Treasuries                                                                  */
/* -------------------------------------------------------------------------- */

/// Both treasury vaults for one base mint. Permissionless and idempotent —
/// anyone may pay rent to open the vaults a base mint needs, because opening
/// them grants no authority over what lands in them.
#[derive(Accounts)]
pub struct InitTreasury<'info> {
    #[account(seeds = [SEED_GLOBAL], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init_if_needed,
        payer = payer,
        seeds = [SEED_PROTOCOL_VAULT, base_mint.key().as_ref()],
        bump,
        token::mint = base_mint,
        token::authority = global,
        token::token_program = base_token_program,
    )]
    pub protocol_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = payer,
        seeds = [SEED_OPS_VAULT, base_mint.key().as_ref()],
        bump,
        token::mint = base_mint,
        token::authority = global,
        token::token_program = base_token_program,
    )]
    pub ops_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub base_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn init_treasury(_ctx: Context<InitTreasury>) -> Result<()> {
    Ok(())
}

/// Which treasury a withdrawal targets.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum Treasury {
    Protocol,
    Ops,
}

#[derive(Accounts)]
#[instruction(which: Treasury)]
pub struct WithdrawTreasury<'info> {
    #[account(seeds = [SEED_GLOBAL], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = base_mint)]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Must equal `global.protocol_withdraw_authority` or
    /// `global.ops_withdraw_authority` depending on `which`. Documented to be a
    /// multisig or cold key; the API process holds neither.
    pub authority: Signer<'info>,
    pub base_token_program: Interface<'info, TokenInterface>,
}

pub fn withdraw_treasury(
    ctx: Context<WithdrawTreasury>,
    which: Treasury,
    amount: u64,
) -> Result<()> {
    let g = &ctx.accounts.global;
    let base_mint = ctx.accounts.base_mint.key();

    let (expected_authority, paused, seed, which_tag) = match which {
        Treasury::Protocol => (
            g.protocol_withdraw_authority,
            g.protocol_withdrawals_paused,
            SEED_PROTOCOL_VAULT,
            0u8,
        ),
        Treasury::Ops => (
            g.ops_withdraw_authority,
            g.ops_withdrawals_paused,
            SEED_OPS_VAULT,
            1u8,
        ),
    };

    require!(
        ctx.accounts.authority.key() == expected_authority,
        LaunchpadError::Unauthorized
    );
    require!(!paused, LaunchpadError::WithdrawalsPaused);
    require!(amount > 0, LaunchpadError::ZeroAmount);

    // The vault must be *the* PDA for this treasury and base mint, so a caller
    // cannot point the protocol authority at the ops vault or vice versa.
    let (expected_vault, _) =
        Pubkey::find_program_address(&[seed, base_mint.as_ref()], ctx.program_id);
    require!(
        ctx.accounts.vault.key() == expected_vault,
        LaunchpadError::Unauthorized
    );

    let bump = [g.bump];
    let signer: &[&[&[u8]]] = &[&[SEED_GLOBAL, &bump]];
    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.base_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.base_mint.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
                authority: ctx.accounts.global.to_account_info(),
            },
            signer,
        ),
        amount,
        ctx.accounts.base_mint.decimals,
    )?;

    emit!(TreasuryWithdrawn {
        base_mint,
        which: which_tag,
        amount,
        destination: ctx.accounts.destination.key(),
        ts: Clock::get()?.unix_timestamp,
    });
    Ok(())
}
