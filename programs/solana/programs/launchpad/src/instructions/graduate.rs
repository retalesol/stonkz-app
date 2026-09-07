use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    burn, transfer_checked, Burn, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::*;
use crate::errors::LaunchpadError;
use crate::events::Graduated;
use crate::instructions::admin::read_fresh_price;
use crate::math::{mcap_base, mcap_usd_1e6, CurveState};
use crate::state::*;

/// Graduation is permissionless: anyone may call it once a trigger is met, so
/// no operator can hold a coin hostage on the curve.
#[derive(Accounts)]
pub struct Graduate<'info> {
    #[account(seeds = [SEED_GLOBAL], bump = global.bump)]
    pub global: Account<'info, Global>,
    #[account(
        mut,
        seeds = [SEED_CURVE, mint.key().as_ref()],
        bump = curve.bump,
        has_one = mint,
        has_one = base_mint @ LaunchpadError::BaseMintMismatch,
    )]
    pub curve: Account<'info, Curve>,
    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,
    pub base_mint: InterfaceAccount<'info, Mint>,
    /// Optional. Without it only the curve-exhaustion trigger is available,
    /// which is exactly the intended behaviour when the oracle is down.
    pub oracle: Option<Account<'info, BaseOracle>>,
    #[account(mut, seeds = [SEED_CURVE_TOKEN_VAULT, mint.key().as_ref()], bump)]
    pub curve_token_vault: InterfaceAccount<'info, TokenAccount>,
    pub caller: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn graduate(ctx: Context<Graduate>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let c = &ctx.accounts.curve;
    require!(!c.graduated, LaunchpadError::AlreadyGraduated);

    let state = CurveState {
        virtual_base: c.virtual_base,
        virtual_token: c.virtual_token,
        real_base: c.real_base,
        real_token: c.real_token,
        k: c.k,
    };
    let mcap = mcap_base(&state, c.supply).ok_or(LaunchpadError::MathOverflow)?;

    // Trigger 1 needs no oracle at all. By SPEC.md §1 an exhausted allocation
    // *is* $69,000 at the price recorded when the coin launched.
    let exhausted = c.real_token == 0 || c.complete;

    let (reason, usd) = if exhausted {
        let usd = match &ctx.accounts.oracle {
            Some(o) if o.base_mint == c.base_mint => {
                mcap_usd_1e6(mcap, o.price_1e6, c.base_decimals).unwrap_or(0)
            }
            _ => mcap_usd_1e6(mcap, c.creation_base_price_1e6, c.base_decimals).unwrap_or(0),
        };
        (GraduationReason::CurveComplete, usd)
    } else {
        // Trigger 2: the base appreciated enough that the coin is already worth
        // $69K with tokens still unsold. Requires a fresh, tight oracle.
        let oracle = ctx
            .accounts
            .oracle
            .as_ref()
            .ok_or(LaunchpadError::NotGraduable)?;
        require!(
            oracle.base_mint == c.base_mint,
            LaunchpadError::BaseMintMismatch
        );
        let price = read_fresh_price(oracle, &ctx.accounts.global, now)?;
        let usd = mcap_usd_1e6(mcap, price, c.base_decimals).ok_or(LaunchpadError::MathOverflow)?;
        require!(usd >= GRAD_MCAP_USD_1E6, LaunchpadError::NotGraduable);
        (GraduationReason::OraclePrice, usd)
    };

    // Unsold allocation is burned rather than folded into the pool: adding it
    // would push the pool's opening price below the curve's closing price, and
    // the whole parameter choice in SPEC.md §1 exists to avoid that gap.
    let to_burn = ctx.accounts.curve.real_token;
    if to_burn > 0 {
        let mint_key = ctx.accounts.mint.key();
        let bump = [ctx.accounts.curve.bump];
        let seeds: &[&[&[u8]]] = &[&[SEED_CURVE, mint_key.as_ref(), &bump]];
        burn(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.curve_token_vault.to_account_info(),
                    authority: ctx.accounts.curve.to_account_info(),
                },
                seeds,
            ),
            to_burn,
        )?;
    }

    let c = &mut ctx.accounts.curve;
    c.real_token = 0;
    c.complete = true;
    c.graduated = true;
    c.graduation_reason = Some(reason);
    c.graduated_at = now;

    emit!(Graduated {
        mint: c.mint,
        base_mint: c.base_mint,
        reason: match reason {
            GraduationReason::CurveComplete => 0,
            GraduationReason::OraclePrice => 1,
        },
        base_migrated: c.real_base,
        tokens_migrated: c.lp_reserve,
        tokens_burned: to_burn,
        mcap_base: mcap,
        mcap_usd_1e6: usd,
        ts: now,
    });
    Ok(())
}

/// Hand the graduated reserves to the pool-creation crank.
///
/// The Raydium/Meteora pool CPI itself is **not** implemented here — see
/// SPEC.md §5 and `programs/solana/README.md`. This instruction is the seam:
/// it releases exactly `real_base` and `lp_reserve`, only after `graduate` has
/// run, only to `global.migration_authority`, and it zeroes the curve's
/// balances so the release cannot be repeated.
#[derive(Accounts)]
pub struct MigrateLiquidity<'info> {
    #[account(seeds = [SEED_GLOBAL], bump = global.bump)]
    pub global: Account<'info, Global>,
    #[account(
        mut,
        seeds = [SEED_CURVE, mint.key().as_ref()],
        bump = curve.bump,
        has_one = mint,
        has_one = base_mint @ LaunchpadError::BaseMintMismatch,
    )]
    pub curve: Account<'info, Curve>,
    pub mint: InterfaceAccount<'info, Mint>,
    pub base_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [SEED_CURVE_BASE_VAULT, mint.key().as_ref()], bump)]
    pub curve_base_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [SEED_LP_VAULT, mint.key().as_ref()], bump)]
    pub lp_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = base_mint)]
    pub destination_base: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint)]
    pub destination_token: InterfaceAccount<'info, TokenAccount>,
    #[account(address = global.migration_authority @ LaunchpadError::Unauthorized)]
    pub migration_authority: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub base_token_program: Interface<'info, TokenInterface>,
}

pub fn migrate_liquidity(ctx: Context<MigrateLiquidity>) -> Result<()> {
    require!(ctx.accounts.curve.graduated, LaunchpadError::NotGraduable);
    let base = ctx.accounts.curve.real_base;
    let tokens = ctx.accounts.curve.lp_reserve;
    require!(base > 0 || tokens > 0, LaunchpadError::NothingToClaim);

    let mint_key = ctx.accounts.mint.key();
    let bump = [ctx.accounts.curve.bump];
    let seeds: &[&[&[u8]]] = &[&[SEED_CURVE, mint_key.as_ref(), &bump]];

    if base > 0 {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.base_token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.curve_base_vault.to_account_info(),
                    mint: ctx.accounts.base_mint.to_account_info(),
                    to: ctx.accounts.destination_base.to_account_info(),
                    authority: ctx.accounts.curve.to_account_info(),
                },
                seeds,
            ),
            base,
            ctx.accounts.base_mint.decimals,
        )?;
    }
    if tokens > 0 {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.lp_vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.destination_token.to_account_info(),
                    authority: ctx.accounts.curve.to_account_info(),
                },
                seeds,
            ),
            tokens,
            ctx.accounts.mint.decimals,
        )?;
    }

    let c = &mut ctx.accounts.curve;
    c.real_base = 0;
    c.lp_reserve = 0;
    Ok(())
}
