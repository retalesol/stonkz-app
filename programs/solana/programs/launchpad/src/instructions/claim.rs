use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::*;
use crate::errors::LaunchpadError;
use crate::events::CreatorFeesClaimed;
use crate::state::*;

/// Drains the creator's ledger only.
///
/// There is no account in this context that can reach `protocol_vault` or
/// `ops_vault`, and the amounts paid out come from `creator_claimable_*`, which
/// only ever grows by the creator's slice of the 69% bucket. The staker pool's
/// share sits in the same vault but under a different counter, and this
/// instruction cannot read it.
#[derive(Accounts)]
pub struct ClaimCreatorFees<'info> {
    #[account(
        mut,
        seeds = [SEED_CURVE, mint.key().as_ref()],
        bump = curve.bump,
        has_one = mint,
        has_one = base_mint @ LaunchpadError::BaseMintMismatch,
        has_one = creator @ LaunchpadError::NotCreator,
    )]
    pub curve: Box<Account<'info, Curve>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [SEED_BUCKET_BASE_VAULT, mint.key().as_ref()], bump)]
    pub bucket_base_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [SEED_BUCKET_TOKEN_VAULT, mint.key().as_ref()], bump)]
    pub bucket_token_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub creator: Signer<'info>,
    #[account(mut, token::mint = base_mint, token::authority = creator)]
    pub creator_base_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::authority = creator)]
    pub creator_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub base_token_program: Interface<'info, TokenInterface>,
}

pub fn claim_creator_fees(ctx: Context<ClaimCreatorFees>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let c = &mut ctx.accounts.curve;
    let base = c.creator_claimable_base;
    let token = c.creator_claimable_token;
    require!(base > 0 || token > 0, LaunchpadError::NothingToClaim);
    c.creator_claimable_base = 0;
    c.creator_claimable_token = 0;

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
                    to: ctx.accounts.creator_base_account.to_account_info(),
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
                    to: ctx.accounts.creator_token_account.to_account_info(),
                    authority: ctx.accounts.curve.to_account_info(),
                },
                seeds,
            ),
            token,
            ctx.accounts.mint.decimals,
        )?;
    }

    emit!(CreatorFeesClaimed {
        mint: mint_key,
        creator: ctx.accounts.creator.key(),
        base_amount: base,
        token_amount: token,
        ts: now,
    });
    Ok(())
}
