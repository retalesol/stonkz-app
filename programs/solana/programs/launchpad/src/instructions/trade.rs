use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::*;
use crate::errors::LaunchpadError;
use crate::events::*;
use crate::math::*;
use crate::state::*;

/// One account set serves both sides of the curve hop. Fifteen accounts is
/// deliberately lean: this instruction has to fit inside a transaction that
/// already carries a Jupiter route in front of it.
#[derive(Accounts)]
pub struct TradeCtx<'info> {
    #[account(seeds = [SEED_GLOBAL], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,

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

    #[account(mut, seeds = [SEED_CURVE_BASE_VAULT, mint.key().as_ref()], bump)]
    pub curve_base_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [SEED_CURVE_TOKEN_VAULT, mint.key().as_ref()], bump)]
    pub curve_token_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [SEED_BUCKET_BASE_VAULT, mint.key().as_ref()], bump)]
    pub bucket_base_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [SEED_BUCKET_TOKEN_VAULT, mint.key().as_ref()], bump)]
    pub bucket_token_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut, seeds = [SEED_PROTOCOL_VAULT, base_mint.key().as_ref()], bump)]
    pub protocol_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [SEED_OPS_VAULT, base_mint.key().as_ref()], bump)]
    pub ops_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [SEED_BURN_VAULT, base_mint.key().as_ref()], bump)]
    pub burn_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub trader: Signer<'info>,
    #[account(mut, token::mint = base_mint, token::authority = trader)]
    pub trader_base_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::authority = trader)]
    pub trader_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub base_token_program: Interface<'info, TokenInterface>,
}

impl<'info> TradeCtx<'info> {
    fn curve_signer(&self) -> [Vec<u8>; 3] {
        [
            SEED_CURVE.to_vec(),
            self.mint.key().to_bytes().to_vec(),
            vec![self.curve.bump],
        ]
    }

    /// base mint, trader-signed.
    fn pull_base(&self, to: &InterfaceAccount<'info, TokenAccount>, amount: u64) -> Result<()> {
        if amount == 0 {
            return Ok(());
        }
        transfer_checked(
            CpiContext::new(
                self.base_token_program.to_account_info(),
                TransferChecked {
                    from: self.trader_base_account.to_account_info(),
                    mint: self.base_mint.to_account_info(),
                    to: to.to_account_info(),
                    authority: self.trader.to_account_info(),
                },
            ),
            amount,
            self.base_mint.decimals,
        )
    }

    /// base mint, curve-PDA-signed.
    fn push_base(
        &self,
        from: &InterfaceAccount<'info, TokenAccount>,
        to: &InterfaceAccount<'info, TokenAccount>,
        amount: u64,
    ) -> Result<()> {
        if amount == 0 {
            return Ok(());
        }
        let seeds = self.curve_signer();
        let refs: [&[u8]; 3] = [&seeds[0], &seeds[1], &seeds[2]];
        transfer_checked(
            CpiContext::new_with_signer(
                self.base_token_program.to_account_info(),
                TransferChecked {
                    from: from.to_account_info(),
                    mint: self.base_mint.to_account_info(),
                    to: to.to_account_info(),
                    authority: self.curve.to_account_info(),
                },
                &[&refs],
            ),
            amount,
            self.base_mint.decimals,
        )
    }

    /// launched mint, curve-PDA-signed.
    fn push_token(
        &self,
        from: &InterfaceAccount<'info, TokenAccount>,
        to: &InterfaceAccount<'info, TokenAccount>,
        amount: u64,
    ) -> Result<()> {
        if amount == 0 {
            return Ok(());
        }
        let seeds = self.curve_signer();
        let refs: [&[u8]; 3] = [&seeds[0], &seeds[1], &seeds[2]];
        transfer_checked(
            CpiContext::new_with_signer(
                self.token_program.to_account_info(),
                TransferChecked {
                    from: from.to_account_info(),
                    mint: self.mint.to_account_info(),
                    to: to.to_account_info(),
                    authority: self.curve.to_account_info(),
                },
                &[&refs],
            ),
            amount,
            self.mint.decimals,
        )
    }
}

fn live_state(c: &Curve) -> CurveState {
    CurveState {
        virtual_base: c.virtual_base,
        virtual_token: c.virtual_token,
        real_base: c.real_base,
        real_token: c.real_token,
        k: c.k,
    }
}

fn guard(c: &Curve, g: &Global) -> Result<()> {
    require!(!g.trading_paused, LaunchpadError::TradingPaused);
    require!(!c.graduated, LaunchpadError::AlreadyGraduated);
    // Once the allocation is gone the coin is awaiting migration. `graduate` is
    // permissionless, so this is a handful of seconds, not a lockup.
    require!(!c.complete, LaunchpadError::CurveComplete);
    Ok(())
}

/// Credit the creator bucket, peeling the staker share off it first.
///
/// Called only with the bucket amount. Protocol and ops have already been sent
/// to their own vaults by the time this runs, so there is no code path by which
/// they could reach the pool.
fn accrue_bucket_base(c: &mut Curve, bucket: u64, circulating: u64) -> Result<(u64, u64)> {
    let sp = split_creator_bucket(bucket, c.eligible_staked, circulating);
    c.creator_claimable_base = c
        .creator_claimable_base
        .checked_add(sp.creator)
        .ok_or(LaunchpadError::MathOverflow)?;
    if sp.stakers > 0 {
        let carried = sp
            .stakers
            .checked_add(c.pool_dust_base)
            .ok_or(LaunchpadError::MathOverflow)?;
        let (acc, dust) = advance_acc(c.acc_base_per_weight, carried, c.total_weight)
            .ok_or(LaunchpadError::MathOverflow)?;
        c.acc_base_per_weight = acc;
        c.pool_dust_base = dust;
        c.staker_accrued_base = c.staker_accrued_base.saturating_add(sp.stakers);
    }
    Ok((sp.creator, sp.stakers))
}

fn accrue_bucket_token(c: &mut Curve, tokens: u64, circulating: u64) -> Result<(u64, u64)> {
    let sp = split_creator_bucket(tokens, c.eligible_staked, circulating);
    c.creator_claimable_token = c
        .creator_claimable_token
        .checked_add(sp.creator)
        .ok_or(LaunchpadError::MathOverflow)?;
    if sp.stakers > 0 {
        let carried = sp
            .stakers
            .checked_add(c.pool_dust_token)
            .ok_or(LaunchpadError::MathOverflow)?;
        let (acc, dust) = advance_acc(c.acc_token_per_weight, carried, c.total_weight)
            .ok_or(LaunchpadError::MathOverflow)?;
        c.acc_token_per_weight = acc;
        c.pool_dust_token = dust;
        c.staker_accrued_token = c.staker_accrued_token.saturating_add(sp.stakers);
    }
    Ok((sp.creator, sp.stakers))
}

/* -------------------------------------------------------------------------- */
/* Buy                                                                         */
/* -------------------------------------------------------------------------- */

pub fn buy(ctx: Context<TradeCtx>, amount_base: u64, min_out: u64) -> Result<()> {
    guard(&ctx.accounts.curve, &ctx.accounts.global)?;
    require!(amount_base > 0, LaunchpadError::ZeroAmount);

    let now = Clock::get()?.unix_timestamp;
    let c = &ctx.accounts.curve;
    let bps = eff_fee_bps(c.fee_bps, c.cashback, c.cb_start, now);
    let in_cashback = bps > c.fee_bps;

    let fill = buy_quote(&live_state(c), bps, amount_base).ok_or(LaunchpadError::MathOverflow)?;
    require!(fill.tokens_out >= min_out, LaunchpadError::SlippageExceeded);

    let shares = split_fee(fill.fee);
    // The identity the whole fee model rests on. Cheap to assert, so assert it
    // on every fill rather than trusting the unit tests alone.
    require!(shares.total() == fill.fee, LaunchpadError::MathOverflow);

    // Move the trader's base: pool, protocol, game (ops), burn. The bucket is
    // routed below, because during cashback it goes back through the curve.
    ctx.accounts
        .pull_base(&ctx.accounts.curve_base_vault, fill.net_base)?;
    ctx.accounts
        .pull_base(&ctx.accounts.protocol_vault, shares.protocol)?;
    ctx.accounts
        .pull_base(&ctx.accounts.ops_vault, shares.stonkz_ops)?;
    ctx.accounts
        .pull_base(&ctx.accounts.burn_vault, shares.burn)?;

    // Apply the main fill before anything reads reserves again.
    let c = &mut ctx.accounts.curve;
    c.virtual_base = c
        .virtual_base
        .checked_add(fill.net_base as u128)
        .ok_or(LaunchpadError::MathOverflow)?;
    c.virtual_token = c
        .virtual_token
        .checked_sub(fill.tokens_out as u128)
        .ok_or(LaunchpadError::MathOverflow)?;
    c.real_base = c
        .real_base
        .checked_add(fill.net_base)
        .ok_or(LaunchpadError::MathOverflow)?;
    c.real_token = c
        .real_token
        .checked_sub(fill.tokens_out)
        .ok_or(LaunchpadError::MathOverflow)?;

    let circ = circulating(c.tokens_for_sale, c.real_token).max(1);

    // Cashback: convert the bucket — and only the bucket — into the token, at
    // zero fee, through this same curve. Protocol and ops stay in base.
    let mut cashback_tokens = 0u64;
    let (to_creator, to_stakers) = if in_cashback && shares.creator_bucket > 0 {
        match zero_fee_buy(&live_state(c), shares.creator_bucket) {
            Some(out) => {
                cashback_tokens = out;
                ctx.accounts
                    .pull_base(&ctx.accounts.curve_base_vault, shares.creator_bucket)?;
                ctx.accounts.push_token(
                    &ctx.accounts.curve_token_vault,
                    &ctx.accounts.bucket_token_vault,
                    out,
                )?;
                let c = &mut ctx.accounts.curve;
                c.virtual_base += shares.creator_bucket as u128;
                c.virtual_token -= out as u128;
                c.real_base += shares.creator_bucket;
                c.real_token -= out;
                accrue_bucket_token(c, out, circ)?
            }
            // Not enough allocation left to convert. Fall back to base rather
            // than partially filling.
            None => {
                ctx.accounts
                    .pull_base(&ctx.accounts.bucket_base_vault, shares.creator_bucket)?;
                accrue_bucket_base(&mut ctx.accounts.curve, shares.creator_bucket, circ)?
            }
        }
    } else {
        ctx.accounts
            .pull_base(&ctx.accounts.bucket_base_vault, shares.creator_bucket)?;
        accrue_bucket_base(&mut ctx.accounts.curve, shares.creator_bucket, circ)?
    };

    ctx.accounts.push_token(
        &ctx.accounts.curve_token_vault,
        &ctx.accounts.trader_token_account,
        fill.tokens_out,
    )?;

    let c = &mut ctx.accounts.curve;
    c.protocol_accrued = c.protocol_accrued.saturating_add(shares.protocol);
    c.ops_accrued = c.ops_accrued.saturating_add(shares.stonkz_ops);
    c.creator_bucket_accrued = c.creator_bucket_accrued.saturating_add(shares.creator_bucket);
    if c.real_token == 0 {
        c.complete = true;
    }

    emit_fill(
        c,
        &ctx.accounts.trader.key(),
        true,
        fill.gross_base,
        fill.tokens_out,
        bps,
        in_cashback,
        &shares,
        to_creator,
        to_stakers,
        cashback_tokens,
        now,
    );
    Ok(())
}

/* -------------------------------------------------------------------------- */
/* Sell                                                                        */
/* -------------------------------------------------------------------------- */

pub fn sell(ctx: Context<TradeCtx>, amount_token: u64, min_out: u64) -> Result<()> {
    guard(&ctx.accounts.curve, &ctx.accounts.global)?;
    require!(amount_token > 0, LaunchpadError::ZeroAmount);

    let now = Clock::get()?.unix_timestamp;
    let c = &ctx.accounts.curve;
    let bps = eff_fee_bps(c.fee_bps, c.cashback, c.cb_start, now);
    let in_cashback = bps > c.fee_bps;

    let fill = sell_quote(&live_state(c), bps, amount_token).ok_or(LaunchpadError::MathOverflow)?;
    require!(fill.net_base >= min_out, LaunchpadError::SlippageExceeded);

    let shares = split_fee(fill.fee);
    require!(shares.total() == fill.fee, LaunchpadError::MathOverflow);

    // Tokens in first, then base out of the pool.
    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.trader_token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.curve_token_vault.to_account_info(),
                authority: ctx.accounts.trader.to_account_info(),
            },
        ),
        amount_token,
        ctx.accounts.mint.decimals,
    )?;

    ctx.accounts.push_base(
        &ctx.accounts.curve_base_vault,
        &ctx.accounts.trader_base_account,
        fill.net_base,
    )?;
    ctx.accounts.push_base(
        &ctx.accounts.curve_base_vault,
        &ctx.accounts.protocol_vault,
        shares.protocol,
    )?;
    ctx.accounts.push_base(
        &ctx.accounts.curve_base_vault,
        &ctx.accounts.ops_vault,
        shares.stonkz_ops,
    )?;
    ctx.accounts.push_base(
        &ctx.accounts.curve_base_vault,
        &ctx.accounts.burn_vault,
        shares.burn,
    )?;
    // A sell inside the cashback window pays the elevated fee like any other
    // fill, but its bucket accrues in base: swapping it into the token would be
    // buy pressure the seller never asked for. See SPEC.md §3.
    ctx.accounts.push_base(
        &ctx.accounts.curve_base_vault,
        &ctx.accounts.bucket_base_vault,
        shares.creator_bucket,
    )?;

    let c = &mut ctx.accounts.curve;
    c.virtual_base = c
        .virtual_base
        .checked_sub(fill.gross_base as u128)
        .ok_or(LaunchpadError::MathOverflow)?;
    c.virtual_token = c
        .virtual_token
        .checked_add(amount_token as u128)
        .ok_or(LaunchpadError::MathOverflow)?;
    c.real_base = c
        .real_base
        .checked_sub(fill.gross_base)
        .ok_or(LaunchpadError::MathOverflow)?;
    c.real_token = c
        .real_token
        .checked_add(amount_token)
        .ok_or(LaunchpadError::MathOverflow)?;

    let circ = circulating(c.tokens_for_sale, c.real_token).max(1);
    let (to_creator, to_stakers) = accrue_bucket_base(c, shares.creator_bucket, circ)?;

    c.protocol_accrued = c.protocol_accrued.saturating_add(shares.protocol);
    c.ops_accrued = c.ops_accrued.saturating_add(shares.stonkz_ops);
    c.creator_bucket_accrued = c.creator_bucket_accrued.saturating_add(shares.creator_bucket);

    emit_fill(
        c,
        &ctx.accounts.trader.key(),
        false,
        fill.gross_base,
        amount_token,
        bps,
        in_cashback,
        &shares,
        to_creator,
        to_stakers,
        0,
        now,
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn emit_fill(
    c: &Curve,
    trader: &Pubkey,
    is_buy: bool,
    base_amount: u64,
    token_amount: u64,
    bps: u16,
    in_cashback: bool,
    shares: &FeeShares,
    to_creator: u64,
    to_stakers: u64,
    cashback_tokens: u64,
    ts: i64,
) {
    let circ = circulating(c.tokens_for_sale, c.real_token);
    emit!(Trade {
        mint: c.mint,
        trader: *trader,
        is_buy,
        base_amount,
        token_amount,
        eff_fee_bps: bps,
        in_cashback,
        fee_total: shares.total(),
        fee_protocol: shares.protocol,
        fee_ops: shares.stonkz_ops,
        fee_burn: shares.burn,
        fee_creator_bucket: shares.creator_bucket,
        fee_stakers: to_stakers,
        fee_creator: to_creator,
        cashback_tokens,
        virtual_base: c.virtual_base,
        virtual_token: c.virtual_token,
        real_base: c.real_base,
        real_token: c.real_token,
        circulating: circ,
        ts,
    });
    emit!(FeeAccrued {
        mint: c.mint,
        base_mint: c.base_mint,
        fee_total: shares.total(),
        protocol: shares.protocol,
        ops: shares.stonkz_ops,
        burn: shares.burn,
        creator_bucket: shares.creator_bucket,
        ts,
    });
    emit!(TreasuryCredit {
        base_mint: c.base_mint,
        protocol_delta: shares.protocol,
        ops_delta: shares.stonkz_ops,
        burn_delta: shares.burn,
        ts,
    });
}
