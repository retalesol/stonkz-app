use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::*;
use crate::errors::LaunchpadError;
use crate::events::*;
use crate::math::{pending_reward, stake_weight};
use crate::state::*;

const SECS_PER_DAY: i64 = 86_400;

/// Roll everything the position has earned so far into `unclaimed`, then move
/// its debt up to the current accumulators. Must run before any change to the
/// position's weight, otherwise the change would retroactively re-price past
/// accruals.
fn settle(pos: &mut StakePosition, c: &Curve) -> Result<()> {
    if pos.weight > 0 {
        let base = pending_reward(pos.weight, c.acc_base_per_weight, pos.base_debt)
            .ok_or(LaunchpadError::MathOverflow)?;
        let token = pending_reward(pos.weight, c.acc_token_per_weight, pos.token_debt)
            .ok_or(LaunchpadError::MathOverflow)?;
        pos.unclaimed_base = pos
            .unclaimed_base
            .checked_add(base)
            .ok_or(LaunchpadError::MathOverflow)?;
        pos.unclaimed_token = pos
            .unclaimed_token
            .checked_add(token)
            .ok_or(LaunchpadError::MathOverflow)?;
    }
    pos.base_debt = c.acc_base_per_weight;
    pos.token_debt = c.acc_token_per_weight;
    Ok(())
}

/// Recompute a position's weight and fold the delta into the pool totals.
fn reweigh(
    pos: &mut StakePosition,
    c: &mut Curve,
    old_amount: u64,
    old_weight: u128,
) -> Result<()> {
    let new_weight =
        stake_weight(pos.amount, pos.lock_days).ok_or(LaunchpadError::InvalidLockTerm)?;
    pos.weight = new_weight;

    c.total_weight = c
        .total_weight
        .checked_sub(old_weight)
        .and_then(|w| w.checked_add(new_weight))
        .ok_or(LaunchpadError::MathOverflow)?;

    // FLEX is parked, not pooled: it is excluded from `eligible_staked` so a
    // zero-weight position cannot inflate poolFrac and strand rewards.
    if pos.lock_days == 0 {
        c.flex_staked = c
            .flex_staked
            .checked_sub(old_amount)
            .and_then(|v| v.checked_add(pos.amount))
            .ok_or(LaunchpadError::MathOverflow)?;
    } else {
        c.eligible_staked = c
            .eligible_staked
            .checked_sub(old_amount)
            .and_then(|v| v.checked_add(pos.amount))
            .ok_or(LaunchpadError::MathOverflow)?;
    }
    pos.base_debt = c.acc_base_per_weight;
    pos.token_debt = c.acc_token_per_weight;
    Ok(())
}

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(
        mut,
        seeds = [SEED_CURVE, mint.key().as_ref()],
        bump = curve.bump,
        has_one = mint,
    )]
    pub curve: Box<Account<'info, Curve>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + StakePosition::INIT_SPACE,
        seeds = [SEED_STAKE_POSITION, mint.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub position: Box<Account<'info, StakePosition>>,
    #[account(mut, seeds = [SEED_STAKE_ESCROW, mint.key().as_ref()], bump)]
    pub stake_escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, token::mint = mint, token::authority = owner)]
    pub owner_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn stake(ctx: Context<Stake>, amount: u64, lock_days: u16) -> Result<()> {
    require!(amount > 0, LaunchpadError::ZeroAmount);
    require!(
        LOCK_DAYS.contains(&lock_days),
        LaunchpadError::InvalidLockTerm
    );

    let now = Clock::get()?.unix_timestamp;
    let pos = &mut ctx.accounts.position;
    let fresh = pos.owner == Pubkey::default();
    if fresh {
        pos.bump = ctx.bumps.position;
        pos.curve = ctx.accounts.curve.key();
        pos.owner = ctx.accounts.owner.key();
        pos.lock_days = lock_days;
    } else {
        // Mixing terms in one position would make a single weight ambiguous.
        require!(pos.lock_days == lock_days, LaunchpadError::LockTermMismatch);
    }

    settle(pos, &ctx.accounts.curve)?;
    let old_amount = pos.amount;
    let old_weight = pos.weight;

    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.owner_token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.stake_escrow.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;

    pos.amount = pos
        .amount
        .checked_add(amount)
        .ok_or(LaunchpadError::MathOverflow)?;
    // Topping up restarts the clock rather than letting an old position hold a
    // near-expired lock for new tokens.
    pos.lock_until = now + (lock_days as i64) * SECS_PER_DAY;

    let lock_until = pos.lock_until;
    let amount_after = pos.amount;
    reweigh(pos, &mut ctx.accounts.curve, old_amount, old_weight)?;
    let weight = pos.weight;

    emit!(Staked {
        mint: ctx.accounts.mint.key(),
        owner: ctx.accounts.owner.key(),
        amount: amount_after,
        lock_days,
        weight,
        lock_until,
        eligible_staked: ctx.accounts.curve.eligible_staked,
        total_weight: ctx.accounts.curve.total_weight,
        ts: now,
    });
    Ok(())
}

pub fn unstake(ctx: Context<Stake>, amount: u64) -> Result<()> {
    require!(amount > 0, LaunchpadError::ZeroAmount);
    let now = Clock::get()?.unix_timestamp;

    {
        let pos = &ctx.accounts.position;
        require!(pos.amount >= amount, LaunchpadError::InsufficientStake);
        // FLEX has a zero-day term, so `lock_until` is `now` at stake time and
        // this passes immediately. Every other term is held to the second.
        require!(now >= pos.lock_until, LaunchpadError::StillLocked);
    }

    let pos = &mut ctx.accounts.position;
    settle(pos, &ctx.accounts.curve)?;
    let old_amount = pos.amount;
    let old_weight = pos.weight;
    pos.amount -= amount;
    reweigh(pos, &mut ctx.accounts.curve, old_amount, old_weight)?;

    let mint_key = ctx.accounts.mint.key();
    let bump = [ctx.accounts.curve.bump];
    let seeds: &[&[&[u8]]] = &[&[SEED_CURVE, mint_key.as_ref(), &bump]];
    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.stake_escrow.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.owner_token_account.to_account_info(),
                authority: ctx.accounts.curve.to_account_info(),
            },
            seeds,
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;

    emit!(Unstaked {
        mint: mint_key,
        owner: ctx.accounts.owner.key(),
        amount,
        eligible_staked: ctx.accounts.curve.eligible_staked,
        total_weight: ctx.accounts.curve.total_weight,
        ts: now,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ClaimStake<'info> {
    #[account(
        mut,
        seeds = [SEED_CURVE, mint.key().as_ref()],
        bump = curve.bump,
        has_one = mint,
        has_one = base_mint @ LaunchpadError::BaseMintMismatch,
    )]
    pub curve: Box<Account<'info, Curve>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        seeds = [SEED_STAKE_POSITION, mint.key().as_ref(), owner.key().as_ref()],
        bump = position.bump,
        has_one = owner @ LaunchpadError::Unauthorized,
    )]
    pub position: Box<Account<'info, StakePosition>>,
    /// The pool's money and the creator's money live in the same vault, told
    /// apart by the `Curve` ledger. Neither can overdraw the other.
    #[account(mut, seeds = [SEED_BUCKET_BASE_VAULT, mint.key().as_ref()], bump)]
    pub bucket_base_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [SEED_BUCKET_TOKEN_VAULT, mint.key().as_ref()], bump)]
    pub bucket_token_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub owner: Signer<'info>,
    #[account(mut, token::mint = base_mint, token::authority = owner)]
    pub owner_base_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::authority = owner)]
    pub owner_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub base_token_program: Interface<'info, TokenInterface>,
}

pub fn claim_stake(ctx: Context<ClaimStake>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let pos = &mut ctx.accounts.position;
    settle(pos, &ctx.accounts.curve)?;

    let base = pos.unclaimed_base;
    let token = pos.unclaimed_token;
    require!(base > 0 || token > 0, LaunchpadError::NothingToClaim);
    pos.unclaimed_base = 0;
    pos.unclaimed_token = 0;

    let mint_key = ctx.accounts.mint.key();
    let bump = [ctx.accounts.curve.bump];
    let seeds: &[&[&[u8]]] = &[&[SEED_CURVE, mint_key.as_ref(), &bump]];

    if base > 0 {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.base_token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.bucket_base_vault.to_account_info(),
                    mint: ctx.accounts.base_mint.to_account_info(),
                    to: ctx.accounts.owner_base_account.to_account_info(),
                    authority: ctx.accounts.curve.to_account_info(),
                },
                seeds,
            ),
            base,
            ctx.accounts.base_mint.decimals,
        )?;
    }
    if token > 0 {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.bucket_token_vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.owner_token_account.to_account_info(),
                    authority: ctx.accounts.curve.to_account_info(),
                },
                seeds,
            ),
            token,
            ctx.accounts.mint.decimals,
        )?;
    }

    emit!(StakeClaimed {
        mint: mint_key,
        owner: ctx.accounts.owner.key(),
        base_amount: base,
        token_amount: token,
        ts: now,
    });
    Ok(())
}
