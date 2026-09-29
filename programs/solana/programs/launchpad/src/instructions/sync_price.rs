use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

use crate::constants::*;
use crate::errors::LaunchpadError;
use crate::pyth::*;
use crate::state::*;

#[derive(Accounts)]
pub struct SyncPriceFromPyth<'info> {
    #[account(seeds = [SEED_GLOBAL], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
    /// Same PDA and layout `push_price` writes; created on the first sync.
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + BaseOracle::INIT_SPACE,
        seeds = [SEED_ORACLE, base_mint.key().as_ref()],
        bump
    )]
    pub oracle: Box<Account<'info, BaseOracle>>,
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: a Pyth `PriceUpdateV2`. Authenticated in the handler: owner is
    /// the Pyth receiver program, Anchor discriminator, `Full` verification,
    /// and the feed id pinned for `base_mint` in `pyth::PYTH_FEEDS`. Any such
    /// account is genuine Wormhole-verified Pyth data, so its address is not
    /// pinned (sponsored push feed or a caller-posted update both work).
    pub price_update: UncheckedAccount<'info>,
    /// Pays rent only when the `BaseOracle` does not exist yet.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// Permissionless: copy a fresh Pyth price into the base mint's `BaseOracle`.
///
/// Anyone may call it (a launch transaction bundles it in front of
/// `create_token`), because the only thing it can write is a price Pyth
/// itself published for the feed this program pins to that mint. An update
/// that is not newer than the stored one is a no-op, never an error.
pub fn sync_price_from_pyth(ctx: Context<SyncPriceFromPyth>) -> Result<()> {
    let base_mint = ctx.accounts.base_mint.key();
    let expected_feed = pinned_pyth_feed(&base_mint).ok_or(LaunchpadError::PythFeedNotPinned)?;

    let info = ctx.accounts.price_update.to_account_info();
    require!(
        *info.owner == PYTH_RECEIVER_PROGRAM_ID,
        LaunchpadError::PythAccountInvalid
    );
    let update = {
        let data = info.try_borrow_data()?;
        parse_price_update_v2(&data)?
    };

    let now = Clock::get()?.unix_timestamp;
    let o = &mut ctx.accounts.oracle;
    // Identity fields are written unconditionally (idempotent for an existing
    // account) so a first sync that turns out to be a no-op still leaves a
    // well-formed account for `push_price` / a later sync to fill in.
    o.bump = ctx.bumps.oracle;
    o.base_mint = base_mint;
    o.base_decimals = ctx.accounts.base_mint.decimals;

    match evaluate_sync(&update, &expected_feed, o.publish_time, now)? {
        SyncOutcome::Write {
            price_1e6,
            conf_1e6,
            publish_time,
        } => {
            o.price_1e6 = price_1e6;
            o.conf_1e6 = conf_1e6;
            // Pyth's own publish time, so `read_fresh_price` measures the age
            // of the price itself rather than of this copy.
            o.publish_time = publish_time;
        }
        SyncOutcome::NoOp => {}
    }
    Ok(())
}
