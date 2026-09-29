use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::system_program as system_program_id;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{
    burn, transfer_checked, Burn, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::*;
use crate::errors::LaunchpadError;
use crate::events::{DexFeesClaimed, Graduated, LiquidityMigrated};
use crate::instructions::admin::read_fresh_price;
use crate::instructions::trade::{accrue_bucket_base, accrue_bucket_token};
use crate::math::{circulating, mcap_base, mcap_usd_1e6, split_fee, CurveState};
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
        require!(c.real_base > 0, LaunchpadError::NotGraduable);
        (GraduationReason::OraclePrice, usd)
    };

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

/* -------------------------------------------------------------------------- */
/* Meteora DLMM migration — two instructions (CU + bin-array weight)           */
/* -------------------------------------------------------------------------- */

/// Create a Meteora DLMM `LbPair` at the curve's closing price via
/// `initialize_lb_pair2` + admin-chosen `PresetParameter2`.
///
/// Does **not** move curve reserves yet — that is `migrate_seed_liquidity`.
/// Hand-built CPI (no foreign Anchor CPI crate), matching the former Raydium
/// rationale in SPEC §6.
#[derive(Accounts)]
pub struct MigrateCreatePool<'info> {
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

    /// CHECK: Meteora program id from Global.
    #[account(address = global.dex_program @ LaunchpadError::Unauthorized)]
    pub dex_program: UncheckedAccount<'info>,
    /// CHECK: PresetParameter2 from Global.
    #[account(address = global.dex_config @ LaunchpadError::Unauthorized)]
    pub preset_parameter: UncheckedAccount<'info>,

    /// CHECK: LB pair PDA `[preset, min(x,y), max(x,y)]` under `dex_program`.
    #[account(mut)]
    pub lb_pair: UncheckedAccount<'info>,
    /// CHECK: optional bitmap extension; pass `dex_program` when unused.
    #[account(mut)]
    pub bin_array_bitmap_extension: UncheckedAccount<'info>,
    /// CHECK: Meteora reserve PDA `[lb_pair, token_x_mint]`.
    #[account(mut)]
    pub reserve_x: UncheckedAccount<'info>,
    /// CHECK: Meteora reserve PDA `[lb_pair, token_y_mint]`.
    #[account(mut)]
    pub reserve_y: UncheckedAccount<'info>,
    /// CHECK: Meteora oracle PDA `["oracle", lb_pair]`.
    #[account(mut)]
    pub oracle: UncheckedAccount<'info>,
    /// CHECK: optional token badge; pass `dex_program` for classic SPL.
    pub token_badge_x: UncheckedAccount<'info>,
    /// CHECK: optional token badge; pass `dex_program` for classic SPL.
    pub token_badge_y: UncheckedAccount<'info>,
    /// CHECK: event authority PDA `["__event_authority"]` under `dex_program`.
    pub event_authority: UncheckedAccount<'info>,

    #[account(mut, address = global.migration_authority @ LaunchpadError::Unauthorized)]
    pub migration_authority: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub base_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn migrate_create_pool(ctx: Context<MigrateCreatePool>) -> Result<()> {
    require!(ctx.accounts.curve.graduated, LaunchpadError::NotGraduable);
    require!(
        !ctx.accounts.curve.migrated,
        LaunchpadError::AlreadyMigrated
    );
    require!(
        ctx.accounts.curve.dex_pool == Pubkey::default(),
        LaunchpadError::PoolAlreadyExists
    );
    require!(
        *ctx.accounts.lb_pair.owner == system_program_id::ID
            && ctx.accounts.lb_pair.lamports() == 0,
        LaunchpadError::PoolAlreadyExists
    );

    let mint_key = ctx.accounts.mint.key();
    let base_mint_key = ctx.accounts.base_mint.key();
    let (token_x_mint, token_y_mint) = sort_mints(mint_key, base_mint_key);

    // Closing price in Y-per-X lamports, then Q64.64 → active bin id.
    let base_amount = ctx.accounts.curve.real_base;
    let token_amount = ctx.accounts.curve.lp_reserve;
    require!(
        base_amount > 0 && token_amount > 0,
        LaunchpadError::NothingToClaim
    );

    let bin_step = read_u16(
        &ctx.accounts.preset_parameter,
        METEORA_PRESET2_BIN_STEP_OFFSET,
    )?;
    let active_id = active_id_from_curve_price(
        mint_key,
        base_mint_key,
        token_amount,
        base_amount,
        ctx.accounts.mint.decimals,
        ctx.accounts.base_mint.decimals,
        bin_step,
    )?;

    // InitializeLbPair2Params { active_id: i32, padding: [u8; 96] }
    let mut data = Vec::with_capacity(8 + 4 + 96);
    data.extend_from_slice(&METEORA_INIT_LB_PAIR2_DISCRIMINATOR);
    data.extend_from_slice(&active_id.to_le_bytes());
    data.extend_from_slice(&[0u8; 96]);

    let dex = ctx.accounts.dex_program.key();
    let (token_x_mint_ai, token_y_mint_ai, token_x_prog_ai, token_y_prog_ai) =
        if mint_key < base_mint_key {
            (
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.base_mint.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.base_token_program.to_account_info(),
            )
        } else {
            (
                ctx.accounts.base_mint.to_account_info(),
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.base_token_program.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            )
        };

    let accounts = vec![
        AccountMeta::new(ctx.accounts.lb_pair.key(), false),
        optional_meta(ctx.accounts.bin_array_bitmap_extension.key(), dex),
        AccountMeta::new_readonly(token_x_mint, false),
        AccountMeta::new_readonly(token_y_mint, false),
        AccountMeta::new(ctx.accounts.reserve_x.key(), false),
        AccountMeta::new(ctx.accounts.reserve_y.key(), false),
        AccountMeta::new(ctx.accounts.oracle.key(), false),
        AccountMeta::new_readonly(ctx.accounts.preset_parameter.key(), false),
        AccountMeta::new(ctx.accounts.migration_authority.key(), true),
        AccountMeta::new_readonly(ctx.accounts.token_badge_x.key(), false),
        AccountMeta::new_readonly(ctx.accounts.token_badge_y.key(), false),
        AccountMeta::new_readonly(token_x_prog_ai.key(), false),
        AccountMeta::new_readonly(token_y_prog_ai.key(), false),
        AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
        AccountMeta::new_readonly(ctx.accounts.event_authority.key(), false),
        AccountMeta::new_readonly(dex, false),
    ];

    invoke_signed(
        &Instruction {
            program_id: dex,
            accounts,
            data,
        },
        &[
            ctx.accounts.lb_pair.to_account_info(),
            ctx.accounts.bin_array_bitmap_extension.to_account_info(),
            token_x_mint_ai,
            token_y_mint_ai,
            ctx.accounts.reserve_x.to_account_info(),
            ctx.accounts.reserve_y.to_account_info(),
            ctx.accounts.oracle.to_account_info(),
            ctx.accounts.preset_parameter.to_account_info(),
            ctx.accounts.migration_authority.to_account_info(),
            ctx.accounts.token_badge_x.to_account_info(),
            ctx.accounts.token_badge_y.to_account_info(),
            token_x_prog_ai,
            token_y_prog_ai,
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.event_authority.to_account_info(),
            ctx.accounts.dex_program.to_account_info(),
        ],
        &[],
    )?;

    ctx.accounts.curve.dex_pool = ctx.accounts.lb_pair.key();
    Ok(())
}

/// Seed liquidity into the pool created by `migrate_create_pool`: init the
/// active bin array, open a position owned by the escrow PDA, deposit
/// SpotBalanced into the active bin, and refund the unspent rent buffer. The
/// position stays with the escrow for good: no instruction of this program
/// withdraws, closes or reassigns it (DLMM's operator timelock is
/// whitelist-gated and unavailable — see step 4).
#[derive(Accounts)]
pub struct MigrateSeedLiquidity<'info> {
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

    /// CHECK: escrow PDA — CPI signer for position + liquidity.
    #[account(mut, seeds = [SEED_METEORA_ESCROW, mint.key().as_ref()], bump)]
    pub escrow: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = base_mint,
        associated_token::authority = escrow,
        associated_token::token_program = base_token_program,
    )]
    pub escrow_base: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = escrow,
        associated_token::token_program = token_program,
    )]
    pub escrow_token: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: must match `curve.dex_pool` (address constraint).
    #[account(mut, address = curve.dex_pool @ LaunchpadError::PoolNotCreated)]
    pub lb_pair: UncheckedAccount<'info>,
    /// CHECK: optional bitmap extension; pass `dex_program` when unused.
    #[account(mut)]
    pub bin_array_bitmap_extension: UncheckedAccount<'info>,
    /// CHECK: Meteora reserve PDA for token X.
    #[account(mut)]
    pub reserve_x: UncheckedAccount<'info>,
    /// CHECK: Meteora reserve PDA for token Y.
    #[account(mut)]
    pub reserve_y: UncheckedAccount<'info>,
    /// CHECK: bin array PDA `["bin_array", lb_pair, index]`.
    #[account(mut)]
    pub bin_array: UncheckedAccount<'info>,
    /// CHECK: position PDA `["position", lb_pair, escrow, lower, width]`.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: event authority PDA `["__event_authority"]`.
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: Meteora program id from Global.
    #[account(address = global.dex_program @ LaunchpadError::Unauthorized)]
    pub dex_program: UncheckedAccount<'info>,

    /// Escrow ATA for token X (sorted mint order). Client must pass the matching escrow ATA.
    #[account(mut)]
    pub user_token_x: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Escrow ATA for token Y (sorted mint order).
    #[account(mut)]
    pub user_token_y: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut, address = global.migration_authority @ LaunchpadError::Unauthorized)]
    pub migration_authority: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub base_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    /// `initialize_position_pda` takes the rent sysvar.
    pub rent: Sysvar<'info, Rent>,
}

pub fn migrate_seed_liquidity(ctx: Context<MigrateSeedLiquidity>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(ctx.accounts.curve.graduated, LaunchpadError::NotGraduable);
    require!(
        !ctx.accounts.curve.migrated,
        LaunchpadError::AlreadyMigrated
    );
    require!(
        ctx.accounts.curve.dex_pool != Pubkey::default(),
        LaunchpadError::PoolNotCreated
    );

    let base_amount = ctx.accounts.curve.real_base;
    let token_amount = ctx.accounts.curve.lp_reserve;
    require!(
        base_amount > 0 && token_amount > 0,
        LaunchpadError::NothingToClaim
    );

    let mint_key = ctx.accounts.mint.key();
    let base_mint_key = ctx.accounts.base_mint.key();
    let curve_bump = [ctx.accounts.curve.bump];
    let curve_seeds: &[&[u8]] = &[SEED_CURVE, mint_key.as_ref(), &curve_bump];
    let escrow_bump = [ctx.bumps.escrow];
    let escrow_seeds: &[&[u8]] = &[SEED_METEORA_ESCROW, mint_key.as_ref(), &escrow_bump];

    // 1) Move graduated reserves into escrow ATAs.
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

    // 2) Fund escrow rent for bin array + position.
    anchor_lang::system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.migration_authority.to_account_info(),
                to: ctx.accounts.escrow.to_account_info(),
            },
        ),
        METEORA_MIGRATION_RENT_BUFFER_LAMPORTS,
    )?;

    let active_id = read_i32(&ctx.accounts.lb_pair, METEORA_LB_PAIR_ACTIVE_ID_OFFSET)?;
    let bin_array_index = bin_id_to_bin_array_index(active_id);
    let lower_bin_id = active_id;
    let width: i32 = 1; // single active bin — both sides of the deposit land here
    let dex = ctx.accounts.dex_program.key();
    let lb_pair = ctx.accounts.lb_pair.key();
    let position = ctx.accounts.position.key();
    let escrow = ctx.accounts.escrow.key();

    let (amount_x, amount_y) = if mint_key < base_mint_key {
        (token_amount, base_amount)
    } else {
        (base_amount, token_amount)
    };

    // 3) initialize_bin_array
    {
        let mut data = Vec::with_capacity(8 + 8);
        data.extend_from_slice(&METEORA_INIT_BIN_ARRAY_DISCRIMINATOR);
        data.extend_from_slice(&bin_array_index.to_le_bytes());
        invoke_signed(
            &Instruction {
                program_id: dex,
                accounts: vec![
                    AccountMeta::new_readonly(lb_pair, false),
                    AccountMeta::new(ctx.accounts.bin_array.key(), false),
                    AccountMeta::new(escrow, true),
                    AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
                ],
                data,
            },
            &[
                ctx.accounts.lb_pair.to_account_info(),
                ctx.accounts.bin_array.to_account_info(),
                ctx.accounts.escrow.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[escrow_seeds],
        )?;
    }

    // 4) initialize_position_pda — payer, base and owner are all the escrow
    //    PDA, so the position (`["position", lb_pair, escrow, lower, width]`)
    //    is owned by a key only this program can sign for.
    //
    //    Why not `initialize_position_by_operator` with `lock_release_point =
    //    u64::MAX` (the previous design)? DLMM gates that instruction on its
    //    own operator whitelist (`create_operator_account`, admin-signed):
    //    against the real `lb_clmm` it returns `UnauthorizedAccess` for every
    //    caller, on preset and customizable pairs alike — verified in
    //    `tests/meteora-graduation.ts` — so the on-chain timelock is simply
    //    not available to a per-mint PDA. Permanence therefore rests on this
    //    program: no instruction of it removes liquidity from, closes, or
    //    reassigns the position, and the escrow has no other signer. That is
    //    the same trust the EVM side places in its UUPS admin; hand the
    //    program's upgrade authority to the timelock at the governance
    //    handover (`docs/governance-handover.md`).
    //
    //    `fee_owner` is left at its default, which DLMM reads as "the owner":
    //    `claim_fee2` pays into the escrow's token accounts, so the program —
    //    and only the program, via `claim_dex_fees` — can pull swap fees and
    //    route them through the curve's split. (The design before this one
    //    named the incinerator as fee owner, which would have burned every
    //    post-bond fee for good.)
    let lock_release: u64 = 0;
    {
        let mut data = Vec::with_capacity(8 + 4 + 4);
        data.extend_from_slice(&METEORA_INIT_POSITION_PDA_DISCRIMINATOR);
        data.extend_from_slice(&lower_bin_id.to_le_bytes());
        data.extend_from_slice(&width.to_le_bytes());

        let escrow_ai = ctx.accounts.escrow.to_account_info();
        invoke_signed(
            &Instruction {
                program_id: dex,
                accounts: vec![
                    AccountMeta::new(escrow, true),          // payer
                    AccountMeta::new_readonly(escrow, true), // base
                    AccountMeta::new(position, false),
                    AccountMeta::new_readonly(lb_pair, false),
                    AccountMeta::new_readonly(escrow, true), // owner
                    AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
                    AccountMeta::new_readonly(ctx.accounts.rent.key(), false),
                    AccountMeta::new_readonly(ctx.accounts.event_authority.key(), false),
                    AccountMeta::new_readonly(dex, false),
                ],
                data,
            },
            &[
                escrow_ai.clone(),
                escrow_ai.clone(),
                ctx.accounts.position.to_account_info(),
                ctx.accounts.lb_pair.to_account_info(),
                escrow_ai,
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.rent.to_account_info(),
                ctx.accounts.event_authority.to_account_info(),
                ctx.accounts.dex_program.to_account_info(),
            ],
            &[escrow_seeds],
        )?;
    }

    // 5) add_liquidity2 — the whole of both sides into the active bin, as an
    //    explicit 100% / 100% distribution. Two lessons from the real program:
    //    the v2 forms take bin arrays as trailing remaining accounts, which is
    //    what lets a one-bin position pass its single array once (v1 names
    //    `bin_array_lower` / `bin_array_upper` and, given the same account
    //    twice, fails with `AccountBorrowFailed`); and `SpotBalanced` rounds
    //    its weights, leaving ~0.1% of one side undeposited in the escrow —
    //    an exact distribution deposits every atom, so nothing is stranded.
    {
        let mut data = Vec::with_capacity(8 + 8 + 8 + 4 + (4 + 2 + 2) + 4);
        data.extend_from_slice(&METEORA_ADD_LIQUIDITY2_DISCRIMINATOR);
        data.extend_from_slice(&amount_x.to_le_bytes());
        data.extend_from_slice(&amount_y.to_le_bytes());
        data.extend_from_slice(&1u32.to_le_bytes()); // bin_liquidity_dist: one entry
        data.extend_from_slice(&lower_bin_id.to_le_bytes()); // bin_id = active
        data.extend_from_slice(&METEORA_BPS_ALL.to_le_bytes()); // distribution_x
        data.extend_from_slice(&METEORA_BPS_ALL.to_le_bytes()); // distribution_y
        data.extend_from_slice(&0u32.to_le_bytes()); // RemainingAccountsInfo { slices: vec![] }

        let (token_x_mint, token_y_mint) = sort_mints(mint_key, base_mint_key);
        let (token_x_mint_ai, token_y_mint_ai, token_x_prog_ai, token_y_prog_ai) =
            if mint_key < base_mint_key {
                (
                    ctx.accounts.mint.to_account_info(),
                    ctx.accounts.base_mint.to_account_info(),
                    ctx.accounts.token_program.to_account_info(),
                    ctx.accounts.base_token_program.to_account_info(),
                )
            } else {
                (
                    ctx.accounts.base_mint.to_account_info(),
                    ctx.accounts.mint.to_account_info(),
                    ctx.accounts.base_token_program.to_account_info(),
                    ctx.accounts.token_program.to_account_info(),
                )
            };

        invoke_signed(
            &Instruction {
                program_id: dex,
                accounts: vec![
                    AccountMeta::new(position, false),
                    AccountMeta::new(lb_pair, false),
                    optional_meta(ctx.accounts.bin_array_bitmap_extension.key(), dex),
                    AccountMeta::new(ctx.accounts.user_token_x.key(), false),
                    AccountMeta::new(ctx.accounts.user_token_y.key(), false),
                    AccountMeta::new(ctx.accounts.reserve_x.key(), false),
                    AccountMeta::new(ctx.accounts.reserve_y.key(), false),
                    AccountMeta::new_readonly(token_x_mint, false),
                    AccountMeta::new_readonly(token_y_mint, false),
                    AccountMeta::new_readonly(escrow, true),
                    AccountMeta::new_readonly(token_x_prog_ai.key(), false),
                    AccountMeta::new_readonly(token_y_prog_ai.key(), false),
                    AccountMeta::new_readonly(ctx.accounts.event_authority.key(), false),
                    AccountMeta::new_readonly(dex, false),
                    // remaining: the one bin array this position spans
                    AccountMeta::new(ctx.accounts.bin_array.key(), false),
                ],
                data,
            },
            &[
                ctx.accounts.position.to_account_info(),
                ctx.accounts.lb_pair.to_account_info(),
                ctx.accounts.bin_array_bitmap_extension.to_account_info(),
                ctx.accounts.user_token_x.to_account_info(),
                ctx.accounts.user_token_y.to_account_info(),
                ctx.accounts.reserve_x.to_account_info(),
                ctx.accounts.reserve_y.to_account_info(),
                token_x_mint_ai,
                token_y_mint_ai,
                ctx.accounts.escrow.to_account_info(),
                token_x_prog_ai,
                token_y_prog_ai,
                ctx.accounts.event_authority.to_account_info(),
                ctx.accounts.dex_program.to_account_info(),
                ctx.accounts.bin_array.to_account_info(),
            ],
            &[escrow_seeds],
        )?;
    }

    // 6) Hand back whatever of the rent buffer the CPIs did not spend. The
    //    escrow is a data-less PDA that only ever signs, so it needs no balance
    //    of its own; leaving lamports here would strand them on every coin.
    let leftover = ctx.accounts.escrow.lamports();
    if leftover > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.escrow.to_account_info(),
                    to: ctx.accounts.migration_authority.to_account_info(),
                },
                &[escrow_seeds],
            ),
            leftover,
        )?;
    }

    let c = &mut ctx.accounts.curve;
    c.real_base = 0;
    c.lp_reserve = 0;
    c.migrated = true;
    c.dex_position_meta = pack_position_meta(lower_bin_id, width);

    emit!(LiquidityMigrated {
        mint: mint_key,
        base_mint: base_mint_key,
        pool: lb_pair,
        position,
        base_deposited: base_amount,
        token_deposited: token_amount,
        lock_release_point: lock_release,
        // Held by the program escrow with no withdraw instruction; DLMM's own
        // timelock is not available to us (see step 4).
        position_locked: 1,
        ts: now,
    });
    Ok(())
}

/* -------------------------------------------------------------------------- */
/* Post-bond fees — claim from the locked DLMM position into the curve split   */
/* -------------------------------------------------------------------------- */

/// Permissionless crank. The escrow PDA owns the locked position *and* is its
/// `fee_owner`, so only this program can claim its swap fees — and this is the
/// only instruction that does, into program vaults and ledgers, never to the
/// caller. Base-side fees take the curve's exact split (15% protocol / 10%
/// `$STONKZ` buyback / 6% RWA crate fund / 69% creator bucket, the bucket
/// peeled between creator and stakers as on every fill). The launched-token
/// side has no per-mint treasury to hold the protocol legs, so only its 69%
/// bucket is credited (creator + stakers, in tokens, as during cashback) and
/// the other 31% is burned. Liquidity never moves: `claim_fee2` touches fees
/// only, and the position's `lock_release_point` stays `u64::MAX`.
#[derive(Accounts)]
pub struct ClaimDexFees<'info> {
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
    /// Mutable: the token side's non-bucket legs are burned.
    #[account(mut)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,

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

    /// CHECK: escrow PDA — position owner and fee owner; CPI signer.
    #[account(mut, seeds = [SEED_METEORA_ESCROW, mint.key().as_ref()], bump)]
    pub escrow: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = base_mint,
        associated_token::authority = escrow,
        associated_token::token_program = base_token_program,
    )]
    pub escrow_base: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = escrow,
        associated_token::token_program = token_program,
    )]
    pub escrow_token: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: must be the pool `migrate_create_pool` recorded.
    #[account(mut, address = curve.dex_pool @ LaunchpadError::PoolNotCreated)]
    pub lb_pair: UncheckedAccount<'info>,
    /// CHECK: verified against the DLMM `PositionV2` layout in the handler
    /// (program-owned, this pool, escrow as owner and fee owner).
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: bin array covering the position's lower bin (DLMM validates).
    #[account(mut)]
    pub bin_array_lower: UncheckedAccount<'info>,
    /// CHECK: bin array covering the upper bin; the same account for a one-bin position.
    #[account(mut)]
    pub bin_array_upper: UncheckedAccount<'info>,
    /// CHECK: Meteora reserve for token X (DLMM validates `has_one`).
    #[account(mut)]
    pub reserve_x: UncheckedAccount<'info>,
    /// CHECK: Meteora reserve for token Y.
    #[account(mut)]
    pub reserve_y: UncheckedAccount<'info>,
    /// CHECK: event authority PDA `["__event_authority"]` under `dex_program`.
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: Meteora program id from Global.
    #[account(address = global.dex_program @ LaunchpadError::Unauthorized)]
    pub dex_program: UncheckedAccount<'info>,
    /// CHECK: SPL Memo, a required account of every DLMM v2 instruction.
    #[account(address = SPL_MEMO_PROGRAM_ID @ LaunchpadError::Unauthorized)]
    pub memo_program: UncheckedAccount<'info>,

    /// Anyone. Pays the transaction fee and receives nothing.
    pub caller: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub base_token_program: Interface<'info, TokenInterface>,
}

pub fn claim_dex_fees(ctx: Context<ClaimDexFees>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(ctx.accounts.curve.migrated, LaunchpadError::NotMigrated);

    let mint_key = ctx.accounts.mint.key();
    let base_mint_key = ctx.accounts.base_mint.key();
    let escrow = ctx.accounts.escrow.key();
    let dex = ctx.accounts.dex_program.key();
    let lb_pair = ctx.accounts.lb_pair.key();
    let position = ctx.accounts.position.key();

    // The position is the one `migrate_seed_liquidity` opened: DLMM-owned, on
    // this pool, owned by the escrow and paying fees to the escrow. Anything
    // else would let a caller point the crank at a foreign position (harmless
    // — DLMM would refuse the escrow as sender — but a clear error is better).
    {
        require!(
            *ctx.accounts.position.owner == dex,
            LaunchpadError::PositionMismatch
        );
        let data = ctx.accounts.position.try_borrow_data()?;
        require!(
            data.len() >= METEORA_POSITION_MIN_LEN,
            LaunchpadError::PositionMismatch
        );
        let at = |o: usize| -> Pubkey {
            let mut b = [0u8; 32];
            b.copy_from_slice(&data[o..o + 32]);
            Pubkey::new_from_array(b)
        };
        // `fee_owner` at its default means "the owner" to DLMM; the escrow
        // explicitly is accepted too. Anything else (e.g. the incinerator the
        // previous build wrote) would send the claim elsewhere.
        let fee_owner = at(METEORA_POSITION_FEE_OWNER_OFFSET);
        require!(
            at(METEORA_POSITION_LB_PAIR_OFFSET) == lb_pair
                && at(METEORA_POSITION_OWNER_OFFSET) == escrow
                && (fee_owner == Pubkey::default() || fee_owner == escrow),
            LaunchpadError::PositionMismatch
        );
    }

    let (lower_bin_id, width) = unpack_position_meta(ctx.accounts.curve.dex_position_meta);
    require!(width > 0, LaunchpadError::PositionMismatch);
    let upper_bin_id = lower_bin_id
        .checked_add(width - 1)
        .ok_or(LaunchpadError::MathOverflow)?;

    let escrow_bump = [ctx.bumps.escrow];
    let escrow_seeds: &[&[u8]] = &[SEED_METEORA_ESCROW, mint_key.as_ref(), &escrow_bump];

    let base_before = ctx.accounts.escrow_base.amount;
    let token_before = ctx.accounts.escrow_token.amount;

    // 1) claim_fee2(min_bin_id, max_bin_id, remaining_accounts_info { slices: [] })
    //    Bin arrays travel as trailing remaining accounts; a one-bin position
    //    has one, and DLMM rejects the same account loaded twice.
    {
        let (token_x_mint, token_y_mint) = sort_mints(mint_key, base_mint_key);
        let (user_token_x, user_token_y, token_x_mint_ai, token_y_mint_ai, prog_x, prog_y) =
            if mint_key < base_mint_key {
                (
                    ctx.accounts.escrow_token.to_account_info(),
                    ctx.accounts.escrow_base.to_account_info(),
                    ctx.accounts.mint.to_account_info(),
                    ctx.accounts.base_mint.to_account_info(),
                    ctx.accounts.token_program.to_account_info(),
                    ctx.accounts.base_token_program.to_account_info(),
                )
            } else {
                (
                    ctx.accounts.escrow_base.to_account_info(),
                    ctx.accounts.escrow_token.to_account_info(),
                    ctx.accounts.base_mint.to_account_info(),
                    ctx.accounts.mint.to_account_info(),
                    ctx.accounts.base_token_program.to_account_info(),
                    ctx.accounts.token_program.to_account_info(),
                )
            };

        let mut data = Vec::with_capacity(8 + 4 + 4 + 4);
        data.extend_from_slice(&METEORA_CLAIM_FEE2_DISCRIMINATOR);
        data.extend_from_slice(&lower_bin_id.to_le_bytes());
        data.extend_from_slice(&upper_bin_id.to_le_bytes());
        data.extend_from_slice(&0u32.to_le_bytes()); // RemainingAccountsInfo { slices: vec![] }

        let mut accounts = vec![
            AccountMeta::new(lb_pair, false),
            AccountMeta::new(position, false),
            AccountMeta::new_readonly(escrow, true), // sender = owner
            AccountMeta::new(ctx.accounts.reserve_x.key(), false),
            AccountMeta::new(ctx.accounts.reserve_y.key(), false),
            AccountMeta::new(user_token_x.key(), false),
            AccountMeta::new(user_token_y.key(), false),
            AccountMeta::new_readonly(token_x_mint, false),
            AccountMeta::new_readonly(token_y_mint, false),
            AccountMeta::new_readonly(prog_x.key(), false),
            AccountMeta::new_readonly(prog_y.key(), false),
            AccountMeta::new_readonly(ctx.accounts.memo_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.event_authority.key(), false),
            AccountMeta::new_readonly(dex, false),
        ];
        let mut infos = vec![
            ctx.accounts.lb_pair.to_account_info(),
            ctx.accounts.position.to_account_info(),
            ctx.accounts.escrow.to_account_info(),
            ctx.accounts.reserve_x.to_account_info(),
            ctx.accounts.reserve_y.to_account_info(),
            user_token_x,
            user_token_y,
            token_x_mint_ai,
            token_y_mint_ai,
            prog_x,
            prog_y,
            ctx.accounts.memo_program.to_account_info(),
            ctx.accounts.event_authority.to_account_info(),
            ctx.accounts.dex_program.to_account_info(),
        ];
        accounts.push(AccountMeta::new(ctx.accounts.bin_array_lower.key(), false));
        infos.push(ctx.accounts.bin_array_lower.to_account_info());
        if ctx.accounts.bin_array_upper.key() != ctx.accounts.bin_array_lower.key() {
            accounts.push(AccountMeta::new(ctx.accounts.bin_array_upper.key(), false));
            infos.push(ctx.accounts.bin_array_upper.to_account_info());
        }

        invoke_signed(
            &Instruction {
                program_id: dex,
                accounts,
                data,
            },
            &infos,
            &[escrow_seeds],
        )?;
    }

    ctx.accounts.escrow_base.reload()?;
    ctx.accounts.escrow_token.reload()?;
    let fee_base = ctx
        .accounts
        .escrow_base
        .amount
        .checked_sub(base_before)
        .ok_or(LaunchpadError::MathOverflow)?;
    let fee_token = ctx
        .accounts
        .escrow_token
        .amount
        .checked_sub(token_before)
        .ok_or(LaunchpadError::MathOverflow)?;
    require!(fee_base > 0 || fee_token > 0, LaunchpadError::NothingToClaim);

    let circ = circulating(
        ctx.accounts.curve.tokens_for_sale,
        ctx.accounts.curve.real_token,
    );

    // 2) Base side: the curve's split, to the same vaults a fill pays.
    let s = split_fee(fee_base);
    {
        let legs = [
            (ctx.accounts.protocol_vault.to_account_info(), s.protocol),
            (ctx.accounts.ops_vault.to_account_info(), s.stonkz_ops),
            (ctx.accounts.burn_vault.to_account_info(), s.burn),
            (ctx.accounts.bucket_base_vault.to_account_info(), s.creator_bucket),
        ];
        for (to, amount) in legs {
            if amount == 0 {
                continue;
            }
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.base_token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.escrow_base.to_account_info(),
                        mint: ctx.accounts.base_mint.to_account_info(),
                        to,
                        authority: ctx.accounts.escrow.to_account_info(),
                    },
                    &[escrow_seeds],
                ),
                amount,
                ctx.accounts.base_mint.decimals,
            )?;
        }
    }
    let (to_creator_base, to_stakers_base) =
        accrue_bucket_base(&mut ctx.accounts.curve, s.creator_bucket, circ)?;

    // 3) Token side: the 69% bucket in tokens; the treasury legs are burned.
    let t = split_fee(fee_token);
    let tokens_burned = fee_token
        .checked_sub(t.creator_bucket)
        .ok_or(LaunchpadError::MathOverflow)?;
    if t.creator_bucket > 0 {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.escrow_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.bucket_token_vault.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                &[escrow_seeds],
            ),
            t.creator_bucket,
            ctx.accounts.mint.decimals,
        )?;
    }
    if tokens_burned > 0 {
        burn(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.escrow_token.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                &[escrow_seeds],
            ),
            tokens_burned,
        )?;
    }
    let (to_creator_token, to_stakers_token) =
        accrue_bucket_token(&mut ctx.accounts.curve, t.creator_bucket, circ)?;

    // 4) Lifetime ledgers, as a fill would move them.
    let c = &mut ctx.accounts.curve;
    c.protocol_accrued = c.protocol_accrued.saturating_add(s.protocol);
    c.ops_accrued = c.ops_accrued.saturating_add(s.stonkz_ops);
    c.creator_bucket_accrued = c.creator_bucket_accrued.saturating_add(s.creator_bucket);

    emit!(DexFeesClaimed {
        mint: mint_key,
        base_mint: base_mint_key,
        pool: lb_pair,
        position,
        caller: ctx.accounts.caller.key(),
        fee_base,
        fee_token,
        protocol: s.protocol,
        ops: s.stonkz_ops,
        burn: s.burn,
        creator_bucket_base: s.creator_bucket,
        creator_bucket_token: t.creator_bucket,
        to_creator_base,
        to_stakers_base,
        to_creator_token,
        to_stakers_token,
        tokens_burned,
        ts: now,
    });
    Ok(())
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

/// An Anchor `Option<Account>` that is absent is passed as the callee's own
/// program id; that key must travel read-only (a writable executable would
/// fail the CPI privilege check), a real account writable.
fn optional_meta(key: Pubkey, dex: Pubkey) -> AccountMeta {
    if key == dex {
        AccountMeta::new_readonly(key, false)
    } else {
        AccountMeta::new(key, false)
    }
}

fn sort_mints(a: Pubkey, b: Pubkey) -> (Pubkey, Pubkey) {
    if a < b {
        (a, b)
    } else {
        (b, a)
    }
}

fn pack_position_meta(lower_bin_id: i32, width: i32) -> u64 {
    (lower_bin_id as u32 as u64) | ((width as u32 as u64) << 32)
}

pub fn unpack_position_meta(meta: u64) -> (i32, i32) {
    let lower = meta as u32 as i32;
    let width = (meta >> 32) as u32 as i32;
    (lower, width)
}

fn read_u16(account: &UncheckedAccount, offset: usize) -> Result<u16> {
    let data = account.try_borrow_data()?;
    require!(data.len() >= offset + 2, LaunchpadError::MathOverflow);
    Ok(u16::from_le_bytes(
        data[offset..offset + 2]
            .try_into()
            .map_err(|_| LaunchpadError::MathOverflow)?,
    ))
}

fn read_i32(account: &UncheckedAccount, offset: usize) -> Result<i32> {
    let data = account.try_borrow_data()?;
    require!(data.len() >= offset + 4, LaunchpadError::MathOverflow);
    Ok(i32::from_le_bytes(
        data[offset..offset + 4]
            .try_into()
            .map_err(|_| LaunchpadError::MathOverflow)?,
    ))
}

fn bin_id_to_bin_array_index(bin_id: i32) -> i64 {
    let idx = bin_id.div_euclid(METEORA_MAX_BIN_PER_ARRAY);
    idx as i64
}

/// Price of token X in Y (lamports), as Q64.64, then nearest bin id.
fn active_id_from_curve_price(
    mint: Pubkey,
    base_mint: Pubkey,
    token_amount: u64,
    base_amount: u64,
    token_decimals: u8,
    base_decimals: u8,
    bin_step: u16,
) -> Result<i32> {
    // Y-per-X in human units, then to lamports: price_lamports = y/x * 10^(dx-dy)
    let (amount_x, amount_y, dec_x, dec_y) = if mint < base_mint {
        (token_amount, base_amount, token_decimals, base_decimals)
    } else {
        (base_amount, token_amount, base_decimals, token_decimals)
    };
    require!(amount_x > 0 && amount_y > 0, LaunchpadError::MathOverflow);

    // Q64.64 price ≈ (amount_y / amount_x) * 10^(dec_x - dec_y) * 2^64
    let mut price = (amount_y as u128)
        .checked_shl(METEORA_SCALE_OFFSET as u32)
        .ok_or(LaunchpadError::MathOverflow)?
        .checked_div(amount_x as u128)
        .ok_or(LaunchpadError::MathOverflow)?;

    if dec_x > dec_y {
        let scale = 10u128
            .checked_pow((dec_x - dec_y) as u32)
            .ok_or(LaunchpadError::MathOverflow)?;
        price = price
            .checked_mul(scale)
            .ok_or(LaunchpadError::MathOverflow)?;
    } else if dec_y > dec_x {
        let scale = 10u128
            .checked_pow((dec_y - dec_x) as u32)
            .ok_or(LaunchpadError::MathOverflow)?;
        price = price
            .checked_div(scale)
            .ok_or(LaunchpadError::MathOverflow)?;
    }

    get_id_from_price(price, bin_step)
}

fn get_id_from_price(price_q64: u128, bin_step: u16) -> Result<i32> {
    // Binary search for the largest id with get_price_from_id(id) <= price.
    //
    // `pow_q64` cannot represent the price of every id in [-443636, 443636]:
    // far above zero it overflows u128, far below it underflows to zero, and
    // both come back as `None`. The search's first probes are exactly those
    // extremes (±221,818), so treating `None` as an error — as this did —
    // failed `migrate_create_pool` for *every* coin. `None` is a direction,
    // not a failure: an overflowing positive id is above the target, an
    // underflowing negative id below it.
    let mut lo: i32 = -443_636;
    let mut hi: i32 = 443_636;
    while lo < hi {
        let mid = (lo as i64 + hi as i64 + 1).div_euclid(2) as i32;
        match get_price_from_id(mid, bin_step) {
            Some(p) if p <= price_q64 => lo = mid,
            Some(_) => hi = mid - 1,
            None if mid > 0 => hi = mid - 1,
            None => lo = mid,
        }
    }
    // The price must actually be representable at the answer; a target
    // outside every bin (impossible for real reserves) is the one true error.
    get_price_from_id(lo, bin_step).ok_or(LaunchpadError::MathOverflow)?;
    Ok(lo)
}

fn get_price_from_id(active_id: i32, bin_step: u16) -> Option<u128> {
    let bps = (bin_step as u128).checked_shl(METEORA_SCALE_OFFSET as u32)?
        / (METEORA_BASIS_POINT_MAX as u128);
    let base = METEORA_ONE_Q64.checked_add(bps)?;
    pow_q64(base, active_id)
}

/// Q64.64 power used by DLMM (trimmed from Meteora commons).
fn pow_q64(base: u128, exp: i32) -> Option<u128> {
    if exp == 0 {
        return Some(METEORA_ONE_Q64);
    }
    let mut invert = exp.is_negative();
    let exp_u = exp.unsigned_abs();
    if exp_u >= 0x80000 {
        return None;
    }
    let mut squared_base = base;
    let mut result = METEORA_ONE_Q64;
    if squared_base >= result {
        squared_base = u128::MAX.checked_div(squared_base)?;
        invert = !invert;
    }
    let mut e = exp_u;
    while e > 0 {
        if e & 1 > 0 {
            result = (result.checked_mul(squared_base)?) >> METEORA_SCALE_OFFSET;
        }
        squared_base = (squared_base.checked_mul(squared_base)?) >> METEORA_SCALE_OFFSET;
        e >>= 1;
        if e > 0 && squared_base == 0 {
            return None;
        }
    }
    if invert {
        result = if result == 0 {
            return None;
        } else {
            u128::MAX.checked_div(result)?
        };
    }
    Some(result)
}
