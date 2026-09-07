use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::system_program as system_program_id;
use anchor_spl::associated_token::{get_associated_token_address_with_program_id, AssociatedToken};
use anchor_spl::token::{self, TokenAccount as SplTokenAccount};
use anchor_spl::token_interface::{
    burn, transfer_checked, Burn, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::*;
use crate::errors::LaunchpadError;
use crate::events::{Graduated, LiquidityMigrated};
use crate::instructions::admin::read_fresh_price;
use crate::math::{mcap_base, mcap_usd_1e6, CurveState};
use crate::state::*;

/// Graduation is permissionless: anyone may call it once a trigger is met, so
/// no operator can hold a coin hostage on the curve.
#[derive(Accounts)]
pub struct Graduate<'info> {
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
    #[account(mut)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    /// Optional. Without it only the curve-exhaustion trigger is available,
    /// which is exactly the intended behaviour when the oracle is down.
    pub oracle: Option<Box<Account<'info, BaseOracle>>>,
    #[account(mut, seeds = [SEED_CURVE_TOKEN_VAULT, mint.key().as_ref()], bump)]
    pub curve_token_vault: Box<InterfaceAccount<'info, TokenAccount>>,
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

/// Seed a real Raydium CPMM pool with the graduated reserves and burn 100% of
/// the LP it mints — the Solana mirror of `UniswapV2Migrator.migrate` (see
/// `programs/evm/src/UniswapV2Migrator.sol`), closing H1 in
/// `docs/security-review-findings.md`.
///
/// ## Why a hand-built CPI instead of `raydium_cp_swap::cpi::initialize`
///
/// This program does **not** depend on the `raydium-cp-swap` crate. Anchor's
/// generated CPI clients require the crate's own account types (`AmmConfig`,
/// zero-copy `PoolState`/`ObservationState` loaders), which would pin this
/// program to whatever anchor-lang/anchor-spl point release that crate was
/// last published against — a second, foreign supply chain sitting on top of
/// a launchpad that moves real money. Every account Raydium's `Initialize`
/// touches is public (`docs.raydium.io/products/cpmm/instructions`, and
/// `raydium-io/raydium-cp-swap/programs/cp-swap/src/instructions/
/// initialize.rs`), so the instruction is built here as a raw
/// `Instruction` with Anchor's own sighash convention
/// (`sha256("global:initialize")[..8]`), and every Raydium-owned PDA in the
/// account list is still verified with Anchor's `seeds::program = …`
/// constraint rather than trusted from the caller. This is strictly more
/// defensive than accepting the crate's types unchecked would have been.
///
/// ## The pre-seeded-pool defence
///
/// `UniswapV2Migrator` guards against a pre-seeded pair by comparing the
/// existing reserve ratio to the deposit and refusing a large deviation
/// (`MAX_PRICE_DEVIATION_BPS`), because anyone can compute and fund a v2
/// pair's deterministic address ahead of the migration.
///
/// Raydium's canonical pool PDA (`["pool", amm_config, token_0, token_1]`) has
/// the same property — but this instruction never uses it. `pool_state` here
/// is **our own program's PDA** (`SEED_RAYDIUM_POOL`), passed to Raydium via
/// the "random keypair" path its `Initialize` instruction supports for
/// exactly this front-running class (`pool_account_info.is_signer` in their
/// `create_pool`, satisfied here via `invoke_signed`). Nobody — not another
/// user, not a validator, not `migration_authority` — can ever produce a
/// valid signature for that address except this program, for this mint, so
/// nobody can occupy it before a graduation runs. That makes the Solana side's
/// guarantee strictly stronger than the EVM side's: there is no reserve ratio
/// to check because there is no way for the pool to exist yet. The explicit
/// `require!` below is defence in depth (and the one honest way this could
/// still fail: a *second* call after `curve.migrated` is set, which is
/// rejected before it reaches Raydium at all).
///
/// ## Why an escrow PDA, not `migration_authority`, is Raydium's `creator`
///
/// Raydium's `Initialize` account list conflates "who pays the pool's
/// creation rent" with "who owns the token accounts the deposit is pulled
/// from" and "who receives the minted LP" into one `creator: Signer` account.
/// The graduated reserves live in program-owned vaults (`curve_base_vault`,
/// `lp_vault`), not in any wallet, so this instruction moves them into two
/// temporary ATAs owned by a dedicated escrow PDA (`SEED_RAYDIUM_ESCROW`)
/// immediately beforehand, and that PDA — not `migration_authority` — signs
/// as Raydium's `creator`. The LP Raydium mints therefore lands in an ATA
/// this program's escrow PDA owns, and is burned in the same instruction,
/// before control ever returns to any signer. `migration_authority` only
/// funds the SOL the pool creation costs; it never holds the tokens, the
/// pool, or the LP even transiently.
#[derive(Accounts)]
pub struct MigrateLiquidity<'info> {
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
    #[account(mut, seeds = [SEED_LP_VAULT, mint.key().as_ref()], bump)]
    pub lp_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: a plain, dataless PDA of this program used only as a CPI
    /// signer (Raydium's `creator`) and lamport holder — see the doc comment
    /// above. Its address is fully determined by the `seeds`/`bump`
    /// constraint, so there is nothing else to validate.
    #[account(mut, seeds = [SEED_RAYDIUM_ESCROW, mint.key().as_ref()], bump)]
    pub escrow: UncheckedAccount<'info>,
    /// Temporary holding account for the base side of the deposit, owned by
    /// `escrow`, emptied into the Raydium vault by this same instruction.
    #[account(
        init_if_needed,
        payer = migration_authority,
        associated_token::mint = base_mint,
        associated_token::authority = escrow,
        associated_token::token_program = base_token_program,
    )]
    pub escrow_base: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Same, for the launched-token side.
    #[account(
        init_if_needed,
        payer = migration_authority,
        associated_token::mint = mint,
        associated_token::authority = escrow,
        associated_token::token_program = token_program,
    )]
    pub escrow_token: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: the Raydium CPMM deployment this network is configured to use
    /// (`global.raydium_program`, set only by `set_raydium_config`). This is
    /// the CPI callee, invoked directly below — not a data account this
    /// instruction reads.
    #[account(address = global.raydium_program @ LaunchpadError::Unauthorized)]
    pub raydium_program: UncheckedAccount<'info>,
    /// CHECK: the fee tier this network is configured to migrate into
    /// (`global.raydium_amm_config`). Its `create_pool_fee` field is read
    /// directly off the raw account data below (see the handler) rather than
    /// deserialized through a type, since this program does not depend on
    /// the `raydium-cp-swap` crate.
    #[account(address = global.raydium_amm_config @ LaunchpadError::Unauthorized)]
    pub amm_config: UncheckedAccount<'info>,
    /// CHECK: Raydium's global vault/LP-mint-authority PDA. Verified by seed,
    /// not trusted from the caller.
    #[account(
        seeds = [RAYDIUM_AUTH_SEED],
        bump,
        seeds::program = raydium_program.key(),
    )]
    pub raydium_authority: UncheckedAccount<'info>,
    /// CHECK: this program's own PDA, used as Raydium's non-canonical
    /// `pool_state` — see the doc comment above. Must not already exist: if
    /// it does, either this coin already migrated (checked separately below)
    /// or something is very wrong, and either way this instruction must not
    /// proceed (asserted in the handler before the CPI runs).
    #[account(mut, seeds = [SEED_RAYDIUM_POOL, mint.key().as_ref()], bump)]
    pub pool_state: UncheckedAccount<'info>,
    /// CHECK: Raydium-owned PDA, `init`ed by Raydium inside the CPI. Verified
    /// by seed.
    #[account(
        mut,
        seeds = [RAYDIUM_POOL_LP_MINT_SEED, pool_state.key().as_ref()],
        bump,
        seeds::program = raydium_program.key(),
    )]
    pub lp_mint: UncheckedAccount<'info>,
    /// CHECK: Raydium-owned vault for the base side. Verified by seed.
    #[account(
        mut,
        seeds = [RAYDIUM_POOL_VAULT_SEED, pool_state.key().as_ref(), base_mint.key().as_ref()],
        bump,
        seeds::program = raydium_program.key(),
    )]
    pub pool_vault_base: UncheckedAccount<'info>,
    /// CHECK: Raydium-owned vault for the launched-token side. Verified by seed.
    #[account(
        mut,
        seeds = [RAYDIUM_POOL_VAULT_SEED, pool_state.key().as_ref(), mint.key().as_ref()],
        bump,
        seeds::program = raydium_program.key(),
    )]
    pub pool_vault_token: UncheckedAccount<'info>,
    /// CHECK: Raydium's oracle-observation account for this pool. Verified by
    /// seed.
    #[account(
        mut,
        seeds = [RAYDIUM_OBSERVATION_SEED, pool_state.key().as_ref()],
        bump,
        seeds::program = raydium_program.key(),
    )]
    pub observation_state: UncheckedAccount<'info>,
    /// CHECK: Raydium's hardcoded pool-creation-fee receiver. Raydium's own
    /// `Initialize` asserts this address itself (`address =
    /// create_pool_fee_reveiver::ID`); this program does not additionally
    /// hardcode it so a devnet vs. mainnet deploy needs no code change.
    #[account(mut)]
    pub create_pool_fee: UncheckedAccount<'info>,
    /// CHECK: `escrow`'s ATA for `lp_mint`, created by Raydium inside the CPI
    /// (`associated_token::authority = creator` on their side). Its address
    /// is asserted below rather than left to the caller.
    #[account(
        mut,
        address = get_associated_token_address_with_program_id(&escrow.key(), &lp_mint.key(), &token::ID),
    )]
    pub escrow_lp_token: UncheckedAccount<'info>,

    /// Pays the SOL this pool creation costs. Never touches the tokens, the
    /// pool, or the LP — see the doc comment above.
    #[account(mut, address = global.migration_authority @ LaunchpadError::Unauthorized)]
    pub migration_authority: Signer<'info>,
    /// Must be the classic SPL Token program: launched mints are always
    /// classic SPL (`SPEC.md` §6), and Raydium's `lp_mint`/`creator_lp_token`
    /// are hardcoded to classic Token regardless of which program the pair's
    /// two mints use.
    #[account(address = token::ID @ LaunchpadError::Unauthorized)]
    pub token_program: Interface<'info, TokenInterface>,
    pub base_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn migrate_liquidity(ctx: Context<MigrateLiquidity>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(ctx.accounts.curve.graduated, LaunchpadError::NotGraduable);
    require!(!ctx.accounts.curve.migrated, LaunchpadError::AlreadyMigrated);

    let base_amount = ctx.accounts.curve.real_base;
    let token_amount = ctx.accounts.curve.lp_reserve;
    require!(
        base_amount > 0 && token_amount > 0,
        LaunchpadError::NothingToClaim
    );

    // Defence in depth: `pool_state` is our own PDA (see the doc comment
    // above for why nobody else can ever occupy it), so the only way it can
    // already be initialized is a re-entrant or replayed call after a
    // migration already ran — which `curve.migrated` above already refused.
    // This second check exists so that invariant is asserted here too, not
    // only inferred from the curve flag.
    require!(
        *ctx.accounts.pool_state.owner == system_program_id::ID
            && ctx.accounts.pool_state.lamports() == 0,
        LaunchpadError::PoolAlreadyExists
    );

    let mint_key = ctx.accounts.mint.key();
    let curve_bump = [ctx.accounts.curve.bump];
    let curve_seeds: &[&[u8]] = &[SEED_CURVE, mint_key.as_ref(), &curve_bump];

    // 1) Move the graduated reserves out of the curve's vaults and into the
    //    escrow's temporary ATAs — the only accounts Raydium's `Initialize`
    //    is willing to pull a deposit from (`token::authority = creator`).
    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.base_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.curve_base_vault.to_account_info(),
                mint: ctx.accounts.base_mint.to_account_info(),
                to: ctx.accounts.escrow_base.to_account_info(),
                authority: ctx.accounts.curve.to_account_info(),
            },
            &[curve_seeds],
        ),
        base_amount,
        ctx.accounts.base_mint.decimals,
    )?;
    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.lp_vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.escrow_token.to_account_info(),
                authority: ctx.accounts.curve.to_account_info(),
            },
            &[curve_seeds],
        ),
        token_amount,
        ctx.accounts.mint.decimals,
    )?;

    // 2) Fund the escrow's rent + the pool-creation fee. It is a plain PDA
    //    with no data of its own, so every lamport here either becomes rent
    //    Raydium's `Initialize` allocates for its own accounts or the
    //    `create_pool_fee` transfer; nothing is ever withdrawable back out by
    //    any signer. `create_pool_fee` is read live off `amm_config` rather
    //    than hardcoded, since it is itself an admin choice via
    //    `set_raydium_config`.
    let create_pool_fee_lamports: u64 = {
        let data = ctx.accounts.amm_config.try_borrow_data()?;
        let end = RAYDIUM_AMM_CONFIG_CREATE_POOL_FEE_OFFSET + 8;
        require!(data.len() >= end, LaunchpadError::MathOverflow);
        u64::from_le_bytes(
            data[RAYDIUM_AMM_CONFIG_CREATE_POOL_FEE_OFFSET..end]
                .try_into()
                .map_err(|_| LaunchpadError::MathOverflow)?,
        )
    };
    let escrow_funding = RAYDIUM_MIGRATION_RENT_BUFFER_LAMPORTS
        .checked_add(create_pool_fee_lamports)
        .ok_or(LaunchpadError::MathOverflow)?;
    anchor_lang::system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.migration_authority.to_account_info(),
                to: ctx.accounts.escrow.to_account_info(),
            },
        ),
        escrow_funding,
    )?;

    // 3) Raydium requires `token_0_mint.key() < token_1_mint.key()`. Work out
    //    which of {mint, base_mint} is which and route the matching escrow
    //    ATA / Raydium vault / token program into the right slot.
    let mint_key = ctx.accounts.mint.key();
    let base_mint_key = ctx.accounts.base_mint.key();
    let token_is_zero = mint_key < base_mint_key;

    let (token_0_mint, token_1_mint) = if token_is_zero {
        (mint_key, base_mint_key)
    } else {
        (base_mint_key, mint_key)
    };
    let (amount_0, amount_1) = if token_is_zero {
        (token_amount, base_amount)
    } else {
        (base_amount, token_amount)
    };
    let (creator_token_0, creator_token_1) = if token_is_zero {
        (
            ctx.accounts.escrow_token.key(),
            ctx.accounts.escrow_base.key(),
        )
    } else {
        (
            ctx.accounts.escrow_base.key(),
            ctx.accounts.escrow_token.key(),
        )
    };
    let (token_0_vault, token_1_vault) = if token_is_zero {
        (
            ctx.accounts.pool_vault_token.key(),
            ctx.accounts.pool_vault_base.key(),
        )
    } else {
        (
            ctx.accounts.pool_vault_base.key(),
            ctx.accounts.pool_vault_token.key(),
        )
    };
    let (token_0_program, token_1_program) = if token_is_zero {
        (
            ctx.accounts.token_program.key(),
            ctx.accounts.base_token_program.key(),
        )
    } else {
        (
            ctx.accounts.base_token_program.key(),
            ctx.accounts.token_program.key(),
        )
    };

    // 4) Build Raydium's `Initialize` instruction by hand (see the doc
    //    comment above for why) and invoke it, signing for both PDAs it
    //    requires to sign: `escrow` (the non-canonical-path `creator`) and
    //    `pool_state` (the non-canonical-path `pool_state`).
    let open_time: u64 = 0; // Raydium clamps this to `now + 1` when it is in the past.
    let mut data = RAYDIUM_INITIALIZE_DISCRIMINATOR.to_vec();
    data.extend_from_slice(&amount_0.to_le_bytes());
    data.extend_from_slice(&amount_1.to_le_bytes());
    data.extend_from_slice(&open_time.to_le_bytes());

    let accounts = vec![
        AccountMeta::new(ctx.accounts.escrow.key(), true), // creator
        AccountMeta::new_readonly(ctx.accounts.amm_config.key(), false),
        AccountMeta::new_readonly(ctx.accounts.raydium_authority.key(), false),
        AccountMeta::new(ctx.accounts.pool_state.key(), true), // non-canonical: must sign
        AccountMeta::new_readonly(token_0_mint, false),
        AccountMeta::new_readonly(token_1_mint, false),
        AccountMeta::new(ctx.accounts.lp_mint.key(), false),
        AccountMeta::new(creator_token_0, false),
        AccountMeta::new(creator_token_1, false),
        AccountMeta::new(ctx.accounts.escrow_lp_token.key(), false),
        AccountMeta::new(token_0_vault, false),
        AccountMeta::new(token_1_vault, false),
        AccountMeta::new(ctx.accounts.create_pool_fee.key(), false),
        AccountMeta::new(ctx.accounts.observation_state.key(), false),
        AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
        AccountMeta::new_readonly(token_0_program, false),
        AccountMeta::new_readonly(token_1_program, false),
        AccountMeta::new_readonly(ctx.accounts.associated_token_program.key(), false),
        AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
        AccountMeta::new_readonly(anchor_lang::solana_program::sysvar::rent::ID, false),
    ];
    let ix = Instruction {
        program_id: ctx.accounts.raydium_program.key(),
        accounts,
        data,
    };

    let escrow_bump = [ctx.bumps.escrow];
    let pool_bump = [ctx.bumps.pool_state];
    let escrow_seeds: &[&[u8]] = &[SEED_RAYDIUM_ESCROW, mint_key.as_ref(), &escrow_bump];
    let pool_seeds: &[&[u8]] = &[SEED_RAYDIUM_POOL, mint_key.as_ref(), &pool_bump];

    invoke_signed(
        &ix,
        &[
            ctx.accounts.escrow.to_account_info(),
            ctx.accounts.amm_config.to_account_info(),
            ctx.accounts.raydium_authority.to_account_info(),
            ctx.accounts.pool_state.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.base_mint.to_account_info(),
            ctx.accounts.lp_mint.to_account_info(),
            ctx.accounts.escrow_token.to_account_info(),
            ctx.accounts.escrow_base.to_account_info(),
            ctx.accounts.escrow_lp_token.to_account_info(),
            ctx.accounts.pool_vault_token.to_account_info(),
            ctx.accounts.pool_vault_base.to_account_info(),
            ctx.accounts.create_pool_fee.to_account_info(),
            ctx.accounts.observation_state.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.base_token_program.to_account_info(),
            ctx.accounts.associated_token_program.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.rent.to_account_info(),
            ctx.accounts.raydium_program.to_account_info(),
        ],
        &[escrow_seeds, pool_seeds],
    )?;

    // 5) Read back exactly how much LP Raydium minted to the escrow, and burn
    //    every atom of it. This is a real SPL `Burn` — it reduces
    //    `lp_mint.supply` on chain, which is strictly stronger than sending to
    //    an unusable address (there is no "unusable but still counted in
    //    supply" state on Solana the way `0xdead` is on EVM).
    let lp_minted = {
        let data = ctx.accounts.escrow_lp_token.try_borrow_data()?;
        SplTokenAccount::try_deserialize(&mut &data[..])?.amount
    };
    require!(lp_minted > 0, LaunchpadError::NoLiquidityMinted);

    token::burn(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            token::Burn {
                mint: ctx.accounts.lp_mint.to_account_info(),
                from: ctx.accounts.escrow_lp_token.to_account_info(),
                authority: ctx.accounts.escrow.to_account_info(),
            },
            &[escrow_seeds],
        ),
        lp_minted,
    )?;

    let pool_key = ctx.accounts.pool_state.key();
    let lp_mint_key = ctx.accounts.lp_mint.key();
    let c = &mut ctx.accounts.curve;
    c.real_base = 0;
    c.lp_reserve = 0;
    c.migrated = true;
    c.raydium_pool = pool_key;
    c.raydium_lp_burned = lp_minted;

    emit!(LiquidityMigrated {
        mint: mint_key,
        base_mint: base_mint_key,
        pool: pool_key,
        lp_mint: lp_mint_key,
        base_deposited: base_amount,
        token_deposited: token_amount,
        lp_minted,
        lp_burned: lp_minted,
        ts: now,
    });

    Ok(())
}
