//! Self-serve referral payouts against API-signed Ed25519 vouchers.
//!
//! Referral commissions (15 / 10 / 5% of a referred trader's curve fee, out of
//! the platform's 15% leg) are accounted off chain. The protocol withdraw
//! authority moves the owed total from `protocol_vault` into the per-base-mint
//! `referral_vault` (`withdraw_treasury(Protocol, amount)` with the referral
//! vault as `destination`, or `fund_referral_vault`), and a referrer pulls
//! their share with a voucher the API signs over
//!
//! ```text
//! "STONKZ_REFERRAL_V1" || cluster_tag[8] || referral_vault || recipient || base_mint
//!                      || cumulative_amount u64 LE || deadline i64 LE
//! ```
//!
//! The voucher carries the referrer's **lifetime** entitlement; `claim_referral`
//! pays `cumulative_amount - claim_state.claimed` and remembers the new
//! cumulative. Replaying a voucher, or presenting an older one, pays nothing
//! and fails — no nonce is needed because the API only ever signs a number it
//! has already booked as earned.
//!
//! The signature is checked by the Ed25519 native program: the transaction
//! carries an `Ed25519Program` instruction before `claim_referral`, and this
//! instruction reads it back through the instructions sysvar and requires
//! the verified public key to be `ReferralConfig.signer` and the verified
//! message to be byte-for-byte the voucher above. The runtime has already
//! rejected the transaction if that signature did not verify.
//!
//! Trust boundaries mirror the EVM `ReferralVault`: the signer is a
//! message-only key with `max_per_day` as its blast radius; admin appoints it;
//! the launchpad's pauser (or admin) can stop claims; only admin restarts them.
//! Nothing here can reach `protocol_vault` — what is not funded cannot be
//! claimed.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked, ID as INSTRUCTIONS_SYSVAR_ID,
};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::*;
use crate::errors::LaunchpadError;
use crate::events::{ReferralClaimed, ReferralConfigSet, ReferralVaultFunded};
use crate::state::*;

/// Byte length of a voucher message: prefix + tag + 3 keys + u64 + i64.
pub const REFERRAL_MESSAGE_LEN: usize = REFERRAL_MESSAGE_PREFIX.len() + 8 + 32 + 32 + 32 + 8 + 8;

/// The Ed25519 native program (`Ed25519SigVerify111111111111111111111111111`).
pub const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");

/// `max_per_day` value meaning "no daily cap".
pub const REFERRAL_UNCAPPED: u64 = u64::MAX;

const DAY_SECS: i64 = 86_400;

/* ------------------------------------------------------------ pure core */

/// The bytes the API signs and the program compares against.
pub fn referral_message(
    cluster_tag: &[u8; 8],
    vault: &Pubkey,
    recipient: &Pubkey,
    base_mint: &Pubkey,
    cumulative_amount: u64,
    deadline: i64,
) -> [u8; REFERRAL_MESSAGE_LEN] {
    let mut out = [0u8; REFERRAL_MESSAGE_LEN];
    let mut o = 0;
    out[o..o + REFERRAL_MESSAGE_PREFIX.len()].copy_from_slice(REFERRAL_MESSAGE_PREFIX);
    o += REFERRAL_MESSAGE_PREFIX.len();
    out[o..o + 8].copy_from_slice(cluster_tag);
    o += 8;
    out[o..o + 32].copy_from_slice(vault.as_ref());
    o += 32;
    out[o..o + 32].copy_from_slice(recipient.as_ref());
    o += 32;
    out[o..o + 32].copy_from_slice(base_mint.as_ref());
    o += 32;
    out[o..o + 8].copy_from_slice(&cumulative_amount.to_le_bytes());
    o += 8;
    out[o..o + 8].copy_from_slice(&deadline.to_le_bytes());
    out
}

/// One verified `(public key, message)` pair from an Ed25519 program
/// instruction's data.
#[derive(Debug, PartialEq, Eq)]
pub struct Ed25519Payload<'a> {
    pub pubkey: &'a [u8],
    pub message: &'a [u8],
}

/// Parses the data of an `Ed25519Program` instruction that verifies exactly
/// one signature whose public key, signature and message all live in that
/// same instruction (`instruction_index == u16::MAX`, or the instruction's
/// own index `self_index`). Anything else — several signatures, or offsets
/// pointing into a *different* instruction's data — is refused rather than
/// followed, so a voucher can only be proven by bytes this program can read
/// back and compare in full.
///
/// Layout (`solana_sdk::ed25519_instruction`):
/// ```text
/// u8 num_signatures, u8 padding,
/// Ed25519SignatureOffsets {
///   u16 signature_offset, u16 signature_instruction_index,
///   u16 public_key_offset, u16 public_key_instruction_index,
///   u16 message_data_offset, u16 message_data_size, u16 message_instruction_index,
/// }
/// ```
pub fn parse_single_ed25519(data: &[u8], self_index: u16) -> Option<Ed25519Payload<'_>> {
    const HEADER: usize = 2 + 14;
    if data.len() < HEADER || data[0] != 1 {
        return None;
    }
    let u16_at = |i: usize| u16::from_le_bytes([data[i], data[i + 1]]);
    let sig_off = u16_at(2) as usize;
    let sig_ix = u16_at(4);
    let pk_off = u16_at(6) as usize;
    let pk_ix = u16_at(8);
    let msg_off = u16_at(10) as usize;
    let msg_len = u16_at(12) as usize;
    let msg_ix = u16_at(14);
    let here = |ix: u16| ix == u16::MAX || ix == self_index;
    if !(here(sig_ix) && here(pk_ix) && here(msg_ix)) {
        return None;
    }
    // The signature itself is not re-read (the runtime verified it), but its
    // 64 bytes must sit inside this instruction like everything else.
    if sig_off.checked_add(64)? > data.len() {
        return None;
    }
    let pk_end = pk_off.checked_add(32)?;
    let msg_end = msg_off.checked_add(msg_len)?;
    if pk_end > data.len() || msg_end > data.len() {
        return None;
    }
    Some(Ed25519Payload {
        pubkey: &data[pk_off..pk_end],
        message: &data[msg_off..msg_end],
    })
}

/// Rolling-day cap bookkeeping, shared with the unit tests. Returns the
/// updated `(day_start, claimed_today)` or `None` when `delta` would cross
/// the cap. `REFERRAL_UNCAPPED` never counts; `0` refuses everything.
pub fn consume_daily_cap(
    max_per_day: u64,
    day_start: i64,
    claimed_today: u64,
    now: i64,
    delta: u64,
) -> Option<(i64, u64)> {
    if max_per_day == 0 {
        return None;
    }
    if max_per_day == REFERRAL_UNCAPPED {
        return Some((day_start, claimed_today));
    }
    let (start, used) = if now >= day_start.saturating_add(DAY_SECS) {
        (now, 0u64)
    } else {
        (day_start, claimed_today)
    };
    let remaining = max_per_day.checked_sub(used)?;
    if delta > remaining {
        return None;
    }
    Some((start, used.checked_add(delta)?))
}

/* -------------------------------------------------------- init vault */

/// The referral vault for one base mint. Permissionless and idempotent, like
/// `init_treasury`: opening it grants no authority over what lands in it. The
/// token authority is the `referral_authority` PDA, which no existing
/// instruction can sign for, so `withdraw_treasury` cannot drain it and this
/// module cannot reach the treasuries.
#[derive(Accounts)]
pub struct InitReferralVault<'info> {
    #[account(seeds = [SEED_GLOBAL], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init_if_needed,
        payer = payer,
        seeds = [SEED_REFERRAL_VAULT, base_mint.key().as_ref()],
        bump,
        token::mint = base_mint,
        token::authority = referral_authority,
        token::token_program = base_token_program,
    )]
    pub referral_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: data-less PDA that signs vault transfers; only its seeds matter.
    #[account(seeds = [SEED_REFERRAL_AUTHORITY], bump)]
    pub referral_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub base_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn init_referral_vault(_ctx: Context<InitReferralVault>) -> Result<()> {
    Ok(())
}

/* --------------------------------------------------------------- fund */

/// Anyone may top the vault up. The protocol withdraw authority normally
/// funds it with `withdraw_treasury(Protocol, amount)` pointed at the vault
/// instead; this instruction exists for other funders and for the event.
#[derive(Accounts)]
pub struct FundReferralVault<'info> {
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        seeds = [SEED_REFERRAL_VAULT, base_mint.key().as_ref()],
        bump,
        token::mint = base_mint,
    )]
    pub referral_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = base_mint, token::authority = funder)]
    pub source: Box<InterfaceAccount<'info, TokenAccount>>,
    pub funder: Signer<'info>,
    pub base_token_program: Interface<'info, TokenInterface>,
}

pub fn fund_referral_vault(ctx: Context<FundReferralVault>, amount: u64) -> Result<()> {
    require!(amount > 0, LaunchpadError::ZeroAmount);
    transfer_checked(
        CpiContext::new(
            ctx.accounts.base_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.source.to_account_info(),
                mint: ctx.accounts.base_mint.to_account_info(),
                to: ctx.accounts.referral_vault.to_account_info(),
                authority: ctx.accounts.funder.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.base_mint.decimals,
    )?;
    emit!(ReferralVaultFunded {
        base_mint: ctx.accounts.base_mint.key(),
        vault: ctx.accounts.referral_vault.key(),
        funder: ctx.accounts.funder.key(),
        amount,
        ts: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

/* ------------------------------------------------------------- config */

/// Admin appoints the voucher signer, the daily cap and the cluster tag the
/// API signs with. Lives in its own PDA so `Global`'s layout never changes.
#[derive(Accounts)]
pub struct SetReferralSigner<'info> {
    #[account(seeds = [SEED_GLOBAL], bump = global.bump, has_one = admin @ LaunchpadError::Unauthorized)]
    pub global: Box<Account<'info, Global>>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + ReferralConfig::INIT_SPACE,
        seeds = [SEED_REFERRAL_CONFIG],
        bump
    )]
    pub referral_config: Box<Account<'info, ReferralConfig>>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// `Pubkey::default()` as `signer` disables claims. `max_per_day` is in the
/// vault's base atoms (wSOL lamports for the native vault); `0` refuses every
/// claim, `u64::MAX` removes the cap. `cluster_tag` is the 8-byte cluster
/// marker the API puts in every voucher (`b"mainnet\0"`, `b"devnet\0\0"`, …),
/// so a voucher signed for one cluster is meaningless on another even if the
/// same signer key were reused.
pub fn set_referral_signer(
    ctx: Context<SetReferralSigner>,
    signer: Pubkey,
    max_per_day: u64,
    cluster_tag: [u8; 8],
) -> Result<()> {
    let c = &mut ctx.accounts.referral_config;
    c.bump = ctx.bumps.referral_config;
    c.signer = signer;
    c.max_per_day = max_per_day;
    c.cluster_tag = cluster_tag;
    emit!(ReferralConfigSet {
        signer,
        max_per_day,
        cluster_tag,
        paused: c.paused,
        ts: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

/// Admin, or the emergency pauser (who may only *set* the flag).
#[derive(Accounts)]
pub struct SetReferralPaused<'info> {
    #[account(seeds = [SEED_GLOBAL], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
    #[account(mut, seeds = [SEED_REFERRAL_CONFIG], bump = referral_config.bump)]
    pub referral_config: Box<Account<'info, ReferralConfig>>,
    /// Absent when no pauser was ever appointed; then only admin may call.
    #[account(seeds = [SEED_PAUSER], bump = pauser_config.bump)]
    pub pauser_config: Option<Box<Account<'info, PauserConfig>>>,
    pub authority: Signer<'info>,
}

pub fn set_referral_paused(ctx: Context<SetReferralPaused>, paused: bool) -> Result<()> {
    let who = ctx.accounts.authority.key();
    let is_admin = who == ctx.accounts.global.admin;
    let is_pauser = ctx
        .accounts
        .pauser_config
        .as_ref()
        .map(|p| p.pauser != Pubkey::default() && p.pauser == who)
        .unwrap_or(false);
    // The pauser can stop claims; only admin can start them again.
    require!(is_admin || (is_pauser && paused), LaunchpadError::Unauthorized);
    let c = &mut ctx.accounts.referral_config;
    c.paused = paused;
    emit!(ReferralConfigSet {
        signer: c.signer,
        max_per_day: c.max_per_day,
        cluster_tag: c.cluster_tag,
        paused,
        ts: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

/* -------------------------------------------------------------- claim */

#[derive(Accounts)]
pub struct ClaimReferral<'info> {
    #[account(mut, seeds = [SEED_REFERRAL_CONFIG], bump = referral_config.bump)]
    pub referral_config: Box<Account<'info, ReferralConfig>>,
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        seeds = [SEED_REFERRAL_VAULT, base_mint.key().as_ref()],
        bump,
        token::mint = base_mint,
        token::authority = referral_authority,
    )]
    pub referral_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: data-less PDA that signs the vault transfer; only its seeds matter.
    #[account(seeds = [SEED_REFERRAL_AUTHORITY], bump)]
    pub referral_authority: UncheckedAccount<'info>,
    /// The recipient's lifetime-claimed counter for this base mint. Rent is
    /// the recipient's: they are the one being paid.
    #[account(
        init_if_needed,
        payer = recipient,
        space = 8 + ReferralClaimState::INIT_SPACE,
        seeds = [SEED_REFERRAL_CLAIM, base_mint.key().as_ref(), recipient.key().as_ref()],
        bump
    )]
    pub claim_state: Box<Account<'info, ReferralClaimState>>,
    #[account(mut)]
    pub recipient: Signer<'info>,
    /// The recipient's ATA for the base mint, created here if missing with
    /// the recipient's lamports (they are the one being paid). Measured
    /// smaller than requiring a client-side create (830,136 vs 903,816 B).
    #[account(
        init_if_needed,
        payer = recipient,
        associated_token::mint = base_mint,
        associated_token::authority = recipient,
        associated_token::token_program = base_token_program,
    )]
    pub recipient_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: the instructions sysvar, address-checked here and again by the loaders.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
    pub base_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn claim_referral(
    ctx: Context<ClaimReferral>,
    cumulative_amount: u64,
    deadline: i64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let cfg = &ctx.accounts.referral_config;
    require!(!cfg.paused, LaunchpadError::ReferralClaimsPaused);
    require!(
        cfg.signer != Pubkey::default(),
        LaunchpadError::ReferralSignerUnset
    );
    require!(now <= deadline, LaunchpadError::ReferralVoucherExpired);

    let vault_key = ctx.accounts.referral_vault.key();
    let recipient = ctx.accounts.recipient.key();
    let base_mint = ctx.accounts.base_mint.key();
    let expected = referral_message(
        &cfg.cluster_tag,
        &vault_key,
        &recipient,
        &base_mint,
        cumulative_amount,
        deadline,
    );

    // Find the Ed25519 verification of exactly this message by exactly the
    // configured signer among the instructions that ran before this one.
    let sysvar = &ctx.accounts.instructions_sysvar;
    let current = load_current_index_checked(sysvar)?;
    let mut verified = false;
    for i in 0..current {
        let ix = load_instruction_at_checked(i as usize, sysvar)?;
        if ix.program_id != ED25519_PROGRAM_ID {
            continue;
        }
        if let Some(p) = parse_single_ed25519(&ix.data, i) {
            if p.pubkey == cfg.signer.as_ref() && p.message == expected {
                verified = true;
                break;
            }
        }
    }
    require!(verified, LaunchpadError::ReferralSignatureInvalid);

    // Cumulative accounting: pay only what the voucher adds over what was paid.
    let state = &mut ctx.accounts.claim_state;
    if state.recipient == Pubkey::default() {
        state.bump = ctx.bumps.claim_state;
        state.base_mint = base_mint;
        state.recipient = recipient;
    }
    require!(
        cumulative_amount > state.claimed,
        LaunchpadError::ReferralNothingToClaim
    );
    let delta = cumulative_amount - state.claimed;

    let cfg = &mut ctx.accounts.referral_config;
    let (day_start, claimed_today) = consume_daily_cap(
        cfg.max_per_day,
        cfg.day_start,
        cfg.claimed_today,
        now,
        delta,
    )
    .ok_or(LaunchpadError::ReferralDailyCapExceeded)?;
    cfg.day_start = day_start;
    cfg.claimed_today = claimed_today;

    // The transfer reverts the whole instruction if the vault is short:
    // nothing partial, and `claimed` below is only committed on success.
    state.claimed = cumulative_amount;

    let bump = [ctx.bumps.referral_authority];
    let seeds: &[&[&[u8]]] = &[&[SEED_REFERRAL_AUTHORITY, &bump]];
    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.base_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.referral_vault.to_account_info(),
                mint: ctx.accounts.base_mint.to_account_info(),
                to: ctx.accounts.recipient_token_account.to_account_info(),
                authority: ctx.accounts.referral_authority.to_account_info(),
            },
            seeds,
        ),
        delta,
        ctx.accounts.base_mint.decimals,
    )?;

    emit!(ReferralClaimed {
        base_mint,
        vault: vault_key,
        recipient,
        amount: delta,
        cumulative_amount,
        ts: now,
    });
    Ok(())
}

/* -------------------------------------------------------------- tests */

#[cfg(test)]
mod tests {
    use super::*;

    fn key(b: u8) -> Pubkey {
        Pubkey::new_from_array([b; 32])
    }

    /// Builds the exact data `@solana/web3.js`'s
    /// `Ed25519Program.createInstructionWithPublicKey` emits: 16-byte header,
    /// pubkey at 16, signature at 48, message at 112, indices `u16::MAX`.
    fn ed25519_ix_data(pubkey: &[u8; 32], message: &[u8], index: u16) -> Vec<u8> {
        let mut d = Vec::new();
        d.push(1u8);
        d.push(0u8);
        let sig_off: u16 = 48;
        let pk_off: u16 = 16;
        let msg_off: u16 = 112;
        for v in [
            sig_off,
            index,
            pk_off,
            index,
            msg_off,
            message.len() as u16,
            index,
        ] {
            d.extend_from_slice(&v.to_le_bytes());
        }
        assert_eq!(d.len(), 16);
        d.extend_from_slice(pubkey);
        d.extend_from_slice(&[7u8; 64]);
        d.extend_from_slice(message);
        d
    }

    #[test]
    fn message_layout_is_fixed_and_little_endian() {
        let tag = *b"devnet\0\0";
        let m = referral_message(&tag, &key(1), &key(2), &key(3), 0x0102_0304_0506_0708, -2);
        assert_eq!(m.len(), REFERRAL_MESSAGE_LEN);
        assert_eq!(REFERRAL_MESSAGE_LEN, 138);
        assert_eq!(&m[..18], b"STONKZ_REFERRAL_V1");
        assert_eq!(&m[18..26], &tag);
        assert_eq!(&m[26..58], &[1u8; 32]);
        assert_eq!(&m[58..90], &[2u8; 32]);
        assert_eq!(&m[90..122], &[3u8; 32]);
        assert_eq!(&m[122..130], &[8, 7, 6, 5, 4, 3, 2, 1]);
        assert_eq!(&m[130..138], &(-2i64).to_le_bytes());
    }

    #[test]
    fn every_field_changes_the_message() {
        let tag = *b"mainnet\0";
        let base = referral_message(&tag, &key(1), &key(2), &key(3), 10, 20);
        assert_ne!(
            base,
            referral_message(b"devnet\0\0", &key(1), &key(2), &key(3), 10, 20)
        );
        assert_ne!(base, referral_message(&tag, &key(9), &key(2), &key(3), 10, 20));
        assert_ne!(base, referral_message(&tag, &key(1), &key(9), &key(3), 10, 20));
        assert_ne!(base, referral_message(&tag, &key(1), &key(2), &key(9), 10, 20));
        assert_ne!(base, referral_message(&tag, &key(1), &key(2), &key(3), 11, 20));
        assert_ne!(base, referral_message(&tag, &key(1), &key(2), &key(3), 10, 21));
    }

    #[test]
    fn parses_the_web3js_shape() {
        let pk = [5u8; 32];
        let msg = referral_message(b"devnet\0\0", &key(1), &key(2), &key(3), 1, 2);
        let data = ed25519_ix_data(&pk, &msg, u16::MAX);
        let p = parse_single_ed25519(&data, 0).expect("parses");
        assert_eq!(p.pubkey, &pk);
        assert_eq!(p.message, &msg[..]);
        // an explicit self index is accepted too
        let data = ed25519_ix_data(&pk, &msg, 3);
        assert!(parse_single_ed25519(&data, 3).is_some());
        assert!(parse_single_ed25519(&data, 4).is_none(), "another instruction's index");
    }

    #[test]
    fn refuses_multi_sig_and_out_of_range_offsets() {
        let pk = [5u8; 32];
        let msg = [1u8; 40];
        let mut data = ed25519_ix_data(&pk, &msg, u16::MAX);
        data[0] = 2;
        assert!(parse_single_ed25519(&data, 0).is_none(), "two signatures");
        let mut data = ed25519_ix_data(&pk, &msg, u16::MAX);
        data[12] = 0xFF; // message size past the end
        data[13] = 0xFF;
        assert!(parse_single_ed25519(&data, 0).is_none(), "message past end");
        let mut data = ed25519_ix_data(&pk, &msg, u16::MAX);
        data[6] = 0xFF; // pubkey offset past the end
        data[7] = 0xFF;
        assert!(parse_single_ed25519(&data, 0).is_none(), "pubkey past end");
        assert!(parse_single_ed25519(&data[..10], 0).is_none(), "truncated header");
        let mut data = ed25519_ix_data(&pk, &msg, u16::MAX);
        data[2] = 0xFF; // signature offset past the end
        data[3] = 0xFF;
        assert!(parse_single_ed25519(&data, 0).is_none(), "signature past end");
    }

    #[test]
    fn daily_cap_rolls_and_refuses_the_crossing_claim() {
        const T: i64 = 1_800_000_000;
        // 0 = disabled
        assert_eq!(consume_daily_cap(0, 0, 0, T, 1), None);
        // uncapped never counts
        assert_eq!(consume_daily_cap(REFERRAL_UNCAPPED, 5, 9, T, u64::MAX), Some((5, 9)));
        // first claim ever (day_start 0) starts the window at `now`
        assert_eq!(consume_daily_cap(100, 0, 0, T, 60), Some((T, 60)));
        // same day: within remaining ok, crossing refused
        assert_eq!(consume_daily_cap(100, T, 60, T + 1_000, 40), Some((T, 100)));
        assert_eq!(consume_daily_cap(100, T, 60, T + 1_000, 41), None);
        // next day resets; one second short does not
        assert_eq!(consume_daily_cap(100, T, 100, T + 86_400, 100), Some((T + 86_400, 100)));
        assert_eq!(consume_daily_cap(100, T, 100, T + 86_399, 1), None);
    }
}
