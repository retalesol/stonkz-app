use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    mint_to, set_authority, spl_token_2022::instruction::AuthorityType, Mint, MintTo, SetAuthority,
    TokenAccount, TokenInterface,
};

use crate::constants::*;
use crate::errors::LaunchpadError;
use crate::events::*;
use crate::instructions::admin::read_fresh_price;
use crate::math::derive_curve;
use crate::state::*;

pub const MAX_NAME_LEN: usize = 32;
pub const MAX_URI_LEN: usize = 200;

#[derive(Accounts)]
#[instruction(name: String, ticker: String)]
pub struct CreateToken<'info> {
    #[account(mut, seeds = [SEED_GLOBAL], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,

    /// Seeding the mint on the ticker makes tickers unique per program
    /// deployment — one launchpad per network, so unique per net — without a
    /// registry account or a server-side check.
    #[account(
        init,
        payer = creator,
        seeds = [SEED_MINT, ticker.as_bytes()],
        bump,
        mint::decimals = TOKEN_DECIMALS,
        mint::authority = curve,
        mint::freeze_authority = curve,
        mint::token_program = token_program,
    )]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = creator,
        space = 8 + Curve::INIT_SPACE,
        seeds = [SEED_CURVE, mint.key().as_ref()],
        bump
    )]
    pub curve: Box<Account<'info, Curve>>,

    pub base_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        seeds = [SEED_ORACLE, base_mint.key().as_ref()],
        bump = oracle.bump,
        constraint = oracle.base_mint == base_mint.key() @ LaunchpadError::BaseMintMismatch,
    )]
    pub oracle: Box<Account<'info, BaseOracle>>,

    /// Holds the 80% sellable allocation.
    #[account(
        init, payer = creator,
        seeds = [SEED_CURVE_TOKEN_VAULT, mint.key().as_ref()], bump,
        token::mint = mint, token::authority = curve, token::token_program = token_program,
    )]
    pub curve_token_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Holds the 20% escrowed for the graduation pool.
    #[account(
        init, payer = creator,
        seeds = [SEED_LP_VAULT, mint.key().as_ref()], bump,
        token::mint = mint, token::authority = curve, token::token_program = token_program,
    )]
    pub lp_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Holds base paid into the curve.
    #[account(
        init, payer = creator,
        seeds = [SEED_CURVE_BASE_VAULT, mint.key().as_ref()], bump,
        token::mint = base_mint, token::authority = curve, token::token_program = base_token_program,
    )]
    pub curve_base_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The 70% bucket, in base. Creator claim and staker pool share it; the
    /// ledger on `Curve` says how much of the balance belongs to which.
    #[account(
        init, payer = creator,
        seeds = [SEED_BUCKET_BASE_VAULT, mint.key().as_ref()], bump,
        token::mint = base_mint, token::authority = curve, token::token_program = base_token_program,
    )]
    pub bucket_base_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The 70% bucket after a cashback swap, in the launched token.
    #[account(
        init, payer = creator,
        seeds = [SEED_BUCKET_TOKEN_VAULT, mint.key().as_ref()], bump,
        token::mint = mint, token::authority = curve, token::token_program = token_program,
    )]
    pub bucket_token_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Escrow for staked tokens, including zero-weight FLEX positions.
    #[account(
        init, payer = creator,
        seeds = [SEED_STAKE_ESCROW, mint.key().as_ref()], bump,
        token::mint = mint, token::authority = curve, token::token_program = token_program,
    )]
    pub stake_escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub creator: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub base_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

fn valid_ticker(t: &str) -> bool {
    !t.is_empty()
        && t.len() <= 10
        && t.bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
}

#[allow(clippy::too_many_arguments)]
pub fn create_token(
    ctx: Context<CreateToken>,
    name: String,
    ticker: String,
    uri: String,
    supply: u64,
    fee_bps: u16,
    cashback: bool,
) -> Result<()> {
    require!(!ctx.accounts.global.launch_paused, LaunchpadError::LaunchPaused);
    require!(valid_ticker(&ticker), LaunchpadError::InvalidTicker);
    require!(
        name.len() <= MAX_NAME_LEN && uri.len() <= MAX_URI_LEN,
        LaunchpadError::MetadataTooLong
    );
    require!(
        (MIN_FEE_BPS..=MAX_FEE_BPS).contains(&fee_bps),
        LaunchpadError::FeeOutOfRange
    );
    require!(
        ALLOWED_SUPPLIES.contains(&supply),
        LaunchpadError::UnsupportedSupply
    );

    let now = Clock::get()?.unix_timestamp;
    let price_1e6 = read_fresh_price(&ctx.accounts.oracle, &ctx.accounts.global, now)?;
    let base_decimals = ctx.accounts.base_mint.decimals;

    let supply_atoms = supply
        .checked_mul(10u64.pow(TOKEN_DECIMALS as u32))
        .ok_or(LaunchpadError::MathOverflow)?;
    let p = derive_curve(supply_atoms, price_1e6, base_decimals)
        .ok_or(LaunchpadError::MathOverflow)?;

    let mint_key = ctx.accounts.mint.key();
    let curve_bump = ctx.bumps.curve;
    let signer_seeds: &[&[&[u8]]] = &[&[SEED_CURVE, mint_key.as_ref(), &[curve_bump]]];

    // Mint the entire fixed supply once: the sellable allocation to the curve
    // vault, the rest to the LP escrow.
    mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.curve_token_vault.to_account_info(),
                authority: ctx.accounts.curve.to_account_info(),
            },
            signer_seeds,
        ),
        p.tokens_for_sale,
    )?;
    mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.lp_vault.to_account_info(),
                authority: ctx.accounts.curve.to_account_info(),
            },
            signer_seeds,
        ),
        p.lp_reserve,
    )?;

    // Supply is now fixed forever, and no holder can be frozen.
    set_authority(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            SetAuthority {
                current_authority: ctx.accounts.curve.to_account_info(),
                account_or_mint: ctx.accounts.mint.to_account_info(),
            },
            signer_seeds,
        ),
        AuthorityType::MintTokens,
        None,
    )?;
    set_authority(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            SetAuthority {
                current_authority: ctx.accounts.curve.to_account_info(),
                account_or_mint: ctx.accounts.mint.to_account_info(),
            },
            signer_seeds,
        ),
        AuthorityType::FreezeAccount,
        None,
    )?;

    let c = &mut ctx.accounts.curve;
    c.bump = curve_bump;
    c.mint = mint_key;
    c.base_mint = ctx.accounts.base_mint.key();
    c.creator = ctx.accounts.creator.key();
    c.ticker = ticker.clone();
    c.supply = supply_atoms;
    c.decimals = TOKEN_DECIMALS;
    c.base_decimals = base_decimals;
    c.fee_bps = fee_bps;
    c.cashback = cashback;
    // Stamped by the program from the validator clock. Nothing can move it.
    c.cb_start = if cashback { now } else { 0 };

    c.virtual_base = p.virtual_base;
    c.virtual_token = p.virtual_token;
    c.real_base = 0;
    c.real_token = p.tokens_for_sale;
    c.k = p.k;
    c.init_virtual_base = p.virtual_base;
    c.init_virtual_token = p.virtual_token;
    c.tokens_for_sale = p.tokens_for_sale;
    c.lp_reserve = p.lp_reserve;

    c.grad_mcap_base = p.grad_mcap_base;
    c.creation_base_price_1e6 = price_1e6;
    c.complete = false;
    c.graduated = false;
    c.graduation_reason = None;
    c.graduated_at = 0;

    c.protocol_accrued = 0;
    c.ops_accrued = 0;
    c.creator_bucket_accrued = 0;
    c.creator_claimable_base = 0;
    c.creator_claimable_token = 0;

    c.eligible_staked = 0;
    c.flex_staked = 0;
    c.total_weight = 0;
    c.acc_base_per_weight = 0;
    c.acc_token_per_weight = 0;
    c.pool_dust_base = 0;
    c.pool_dust_token = 0;
    c.staker_accrued_base = 0;
    c.staker_accrued_token = 0;

    ctx.accounts.global.token_count = ctx.accounts.global.token_count.saturating_add(1);

    emit!(TokenCreated {
        mint: mint_key,
        base_mint: c.base_mint,
        creator: c.creator,
        ticker,
        supply: supply_atoms,
        fee_bps,
        cashback,
        cb_start: c.cb_start,
        virtual_base: p.virtual_base,
        virtual_token: p.virtual_token,
        tokens_for_sale: p.tokens_for_sale,
        lp_reserve: p.lp_reserve,
        grad_mcap_base: p.grad_mcap_base,
        base_price_1e6: price_1e6,
        ts: now,
    });
    msg!("stonkz:create {} {} {}", c.ticker, name, uri);
    Ok(())
}
