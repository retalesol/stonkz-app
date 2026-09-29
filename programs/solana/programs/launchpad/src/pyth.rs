//! Pyth pull-oracle `PriceUpdateV2` reader for `sync_price_from_pyth`.
//!
//! Pyth sponsors *push feeds* on Solana: for a handful of feeds it keeps one
//! `PriceUpdateV2` account per feed (a PDA of the push-oracle program,
//! `[shard_id u16 LE, feed_id]`) refreshed on a heartbeat (measured ~35 s on
//! devnet, ~55 s on mainnet, inside the 90 s default staleness) or on a price
//! move, owned by the receiver program. Reading one of those accounts gives this program a fresh,
//! Wormhole-verified USD price without a keeper or a server key.
//!
//! The account is parsed by hand rather than through `pyth-solana-receiver-sdk`:
//! the SDK pins its own `anchor-lang`/`solana-program` versions, and the layout
//! is a small, stable Borsh struct. Everything the parser relies on is checked
//! (owner, discriminator, verification level, feed id), so a look-alike
//! account cannot be passed off as a Pyth price.
//!
//! Layout after the 8-byte Anchor discriminator:
//!
//! ```text
//! write_authority     [32]
//! verification_level  enum: Partial { num_signatures: u8 } = 0 | Full = 1   (1 or 2 bytes!)
//! price_message:
//!   feed_id           [32]
//!   price             i64
//!   conf              u64
//!   exponent          i32
//!   publish_time      i64
//!   prev_publish_time i64
//!   ema_price         i64
//!   ema_conf          u64
//! posted_slot         u64
//! ```

use anchor_lang::prelude::*;
use anchor_lang::pubkey;

use crate::constants::{BPS_DEN, MAX_ORACLE_CONF_BPS};
use crate::errors::LaunchpadError;

/// Pyth Solana receiver program — owner of every `PriceUpdateV2` account,
/// sponsored push feeds included. Same id on devnet and mainnet.
pub const PYTH_RECEIVER_PROGRAM_ID: Pubkey = pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");

/// Pyth push-oracle program: the sponsored feed accounts are its PDAs
/// `[shard_id u16 LE, feed_id]`. Not needed on chain (the owner and content
/// checks are what authenticate an update); kept for clients and tests.
pub const PYTH_PUSH_ORACLE_PROGRAM_ID: Pubkey =
    pubkey!("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");

/// Anchor account discriminator of `PriceUpdateV2`:
/// `sha256("account:PriceUpdateV2")[..8]`.
pub const PRICE_UPDATE_V2_DISCRIMINATOR: [u8; 8] = [34, 241, 35, 99, 157, 126, 244, 205];

/// Borsh variant tags of `VerificationLevel`.
const VERIFICATION_PARTIAL: u8 = 0;
const VERIFICATION_FULL: u8 = 1;

/// How far past the cluster clock a Pyth `publish_time` may sit and still be
/// written. Pyth stamps prices with its publishers' wall clock, while
/// `Clock::unix_timestamp` is the stake-weighted cluster estimate and routinely
/// trails wall time by a few seconds; refusing every "future" update outright
/// would silently no-op the bundled sync whenever the cluster runs behind.
/// Anything further ahead than this is ignored (no-op) rather than trusted.
pub const PYTH_MAX_FUTURE_SKEW_SECS: i64 = 30;

/// Pyth SOL/USD feed id.
pub const PYTH_FEED_SOL_USD: [u8; 32] = [
    0xef, 0x0d, 0x8b, 0x6f, 0xda, 0x2c, 0xeb, 0xa4, 0x1d, 0xa1, 0x5d, 0x40, 0x95, 0xd1, 0xda, 0x39,
    0x2a, 0x0d, 0x2f, 0x8e, 0xd0, 0xc6, 0xc7, 0xbc, 0x0f, 0x4c, 0xfa, 0xc8, 0xc2, 0x80, 0xb5, 0x6d,
];
/// Pyth USDC/USD feed id.
pub const PYTH_FEED_USDC_USD: [u8; 32] = [
    0xea, 0xa0, 0x20, 0xc6, 0x1c, 0xc4, 0x79, 0x71, 0x28, 0x13, 0x46, 0x1c, 0xe1, 0x53, 0x89, 0x4a,
    0x96, 0xa6, 0xc0, 0x0b, 0x21, 0xed, 0x0c, 0xfc, 0x27, 0x98, 0xd1, 0xf9, 0xa9, 0xe9, 0xc9, 0x4a,
];
/// Pyth USDT/USD feed id.
pub const PYTH_FEED_USDT_USD: [u8; 32] = [
    0x2b, 0x89, 0xb9, 0xdc, 0x8f, 0xdf, 0x9f, 0x34, 0x70, 0x9a, 0x5b, 0x10, 0x6b, 0x47, 0x2f, 0x0f,
    0x39, 0xbb, 0x6c, 0xa9, 0xce, 0x04, 0xb0, 0xfd, 0x7f, 0x2e, 0x97, 0x16, 0x88, 0xe2, 0xe5, 0x3b,
];

/// Wrapped SOL (same mint on every cluster).
pub const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
/// Mainnet USDC.
pub const USDC_MINT: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
/// Mainnet USDT.
pub const USDT_MINT: Pubkey = pubkey!("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");

/// Base mint → the one Pyth feed allowed to price it. Pinned in the program
/// so a permissionless caller cannot price wSOL off, say, the BONK feed.
/// Mirrored in `apps/api/src/router/solana-idl.ts` (`PYTH_FEEDS`).
pub const PYTH_FEEDS: [(Pubkey, [u8; 32]); 3] = [
    (WSOL_MINT, PYTH_FEED_SOL_USD),
    (USDC_MINT, PYTH_FEED_USDC_USD),
    (USDT_MINT, PYTH_FEED_USDT_USD),
];

/// The feed pinned for `base_mint`, if any.
pub fn pinned_pyth_feed(base_mint: &Pubkey) -> Option<[u8; 32]> {
    PYTH_FEEDS
        .iter()
        .find(|(mint, _)| mint == base_mint)
        .map(|(_, feed)| *feed)
}

/// The fields of a fully verified `PriceUpdateV2` this program uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PythPrice {
    pub feed_id: [u8; 32],
    pub price: i64,
    pub conf: u64,
    pub exponent: i32,
    pub publish_time: i64,
}

/// `write_authority` ends here; the verification level starts it.
const LEVEL_OFFSET: usize = 8 + 32;
/// `price_message` (feed_id, price, conf, exponent, publish_time,
/// prev_publish_time, ema_price, ema_conf) plus the trailing `posted_slot`.
const MESSAGE_AND_SLOT_LEN: usize = 32 + 8 + 8 + 4 + 8 + 8 + 8 + 8 + 8;

/// `N` bytes at `at`. Callers bound-check the buffer once, up front.
fn le<const N: usize>(data: &[u8], at: usize) -> [u8; N] {
    let mut out = [0u8; N];
    out.copy_from_slice(&data[at..at + N]);
    out
}

/// Parse `PriceUpdateV2` account data (discriminator included). Refuses a
/// wrong discriminator, a truncated buffer, an unknown verification level, and
/// any update that is only partially verified. Does **not** check the owner —
/// the caller does, against [`PYTH_RECEIVER_PROGRAM_ID`].
pub fn parse_price_update_v2(data: &[u8]) -> Result<PythPrice> {
    require!(
        data.len() > LEVEL_OFFSET && data[..8] == PRICE_UPDATE_V2_DISCRIMINATOR,
        LaunchpadError::PythAccountInvalid
    );
    // `VerificationLevel` is a Borsh enum: `Full` is its 1-byte tag alone,
    // `Partial` carries a `num_signatures: u8` — so where the price message
    // starts depends on it.
    let at = match data[LEVEL_OFFSET] {
        VERIFICATION_FULL => LEVEL_OFFSET + 1,
        VERIFICATION_PARTIAL => LEVEL_OFFSET + 2,
        _ => return err!(LaunchpadError::PythAccountInvalid),
    };
    require!(
        data.len() >= at + MESSAGE_AND_SLOT_LEN,
        LaunchpadError::PythAccountInvalid
    );
    // Only a Full (quorum) Wormhole verification is trusted to price a launch.
    require!(
        data[LEVEL_OFFSET] == VERIFICATION_FULL,
        LaunchpadError::PythNotFullyVerified
    );
    Ok(PythPrice {
        feed_id: le(data, at),
        price: i64::from_le_bytes(le(data, at + 32)),
        conf: u64::from_le_bytes(le(data, at + 40)),
        exponent: i32::from_le_bytes(le(data, at + 48)),
        publish_time: i64::from_le_bytes(le(data, at + 52)),
    })
}

/// Rescale a Pyth fixed-point value `v · 10^exponent` to the `1e6` scale
/// `BaseOracle` stores. Rounds down unless `round_up`.
pub fn scale_to_1e6(v: u64, exponent: i32, round_up: bool) -> Result<u64> {
    let shift = exponent
        .checked_add(6)
        .ok_or(LaunchpadError::MathOverflow)?;
    let v = v as u128;
    let out = if shift >= 0 {
        let mul = 10u128
            .checked_pow(shift as u32)
            .ok_or(LaunchpadError::MathOverflow)?;
        v.checked_mul(mul).ok_or(LaunchpadError::MathOverflow)?
    } else {
        let neg = shift.checked_neg().ok_or(LaunchpadError::MathOverflow)? as u32;
        match 10u128.checked_pow(neg) {
            Some(div) => {
                let q = v / div;
                if round_up && v % div != 0 {
                    q.checked_add(1).ok_or(LaunchpadError::MathOverflow)?
                } else {
                    q
                }
            }
            // 10^neg overflows u128 (neg > 38): every u64 rounds to zero.
            None => u128::from(round_up && v != 0),
        }
    };
    u64::try_from(out).map_err(|_| error!(LaunchpadError::MathOverflow))
}

/// What `sync_price_from_pyth` should do with a parsed update.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncOutcome {
    /// Overwrite the `BaseOracle` with these values.
    Write {
        price_1e6: u64,
        conf_1e6: u64,
        publish_time: i64,
    },
    /// Leave the `BaseOracle` untouched: the update is not newer than what is
    /// stored, or it claims a publish time too far past the cluster clock.
    /// Not an error, so bundling the sync in front of a launch is always safe.
    NoOp,
}

/// Decide a sync, given a parsed update, the feed pinned for the base mint,
/// the `publish_time` already stored in the `BaseOracle` (0 for a fresh one)
/// and the cluster clock.
///
/// Order matters: a feed mismatch is always an error (wrong input), timing is
/// checked next and only ever no-ops, and price validity is judged only for an
/// update that would actually be written — a stale update with a wide band
/// must not revert the launch it is bundled with.
pub fn evaluate_sync(
    update: &PythPrice,
    expected_feed: &[u8; 32],
    stored_publish_time: i64,
    now: i64,
) -> Result<SyncOutcome> {
    require!(
        update.feed_id == *expected_feed,
        LaunchpadError::PythFeedMismatch
    );
    if update.publish_time > now.saturating_add(PYTH_MAX_FUTURE_SKEW_SECS) {
        return Ok(SyncOutcome::NoOp);
    }
    if update.publish_time <= stored_publish_time {
        return Ok(SyncOutcome::NoOp);
    }
    require!(update.price > 0, LaunchpadError::OracleInvalid);
    let price = update.price as u64;
    // Band check on the raw values: exact, independent of the rescale below.
    let conf_bps = (update.conf as u128)
        .checked_mul(BPS_DEN as u128)
        .ok_or(LaunchpadError::MathOverflow)?
        / price as u128;
    require!(
        conf_bps <= MAX_ORACLE_CONF_BPS as u128,
        LaunchpadError::OracleUnreliable
    );
    let price_1e6 = scale_to_1e6(price, update.exponent, false)?;
    // A price that rounds to zero at 1e6 cannot price a curve.
    require!(price_1e6 > 0, LaunchpadError::OracleInvalid);
    // Conservative: the band is rounded up, never down.
    let conf_1e6 = scale_to_1e6(update.conf, update.exponent, true)?;
    Ok(SyncOutcome::Write {
        price_1e6,
        conf_1e6,
        publish_time: update.publish_time,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real devnet account `7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE`
    /// (sponsored SOL/USD push feed), fetched 2026-09-29.
    const DEVNET_SOL_USD_B64: &str = "IvEjY51+9M1gMUcENA3t3zcf1CRyFI8kjp0abRpesqw6zYt/1dayQwHvDYtv2izrpB2hXUCV0do5Kg0vjtDGx7wPTPrIwoC1bS3zG8QCAAAA6pEJAAAAAAD4////J/66agAAAAAm/rpqAAAAAPJCtcICAAAAwtcTAAAAAACbxh4eAAAAAAA=";

    fn b64(s: &str) -> Vec<u8> {
        // Minimal standard-alphabet base64 decoder; tests only.
        let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = Vec::new();
        let mut buf = 0u32;
        let mut bits = 0u32;
        for c in s.bytes().filter(|&c| c != b'=') {
            let v = alphabet.iter().position(|&a| a == c).expect("base64") as u32;
            buf = (buf << 6) | v;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((buf >> bits) as u8);
                buf &= (1 << bits) - 1;
            }
        }
        out
    }

    fn hex32(s: &str) -> [u8; 32] {
        let mut out = [0u8; 32];
        for (i, b) in out.iter_mut().enumerate() {
            *b = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
        }
        out
    }

    /// Encode a `PriceUpdateV2` the way the receiver program lays it out.
    fn encode(level: Option<u8>, p: &PythPrice) -> Vec<u8> {
        let mut d = PRICE_UPDATE_V2_DISCRIMINATOR.to_vec();
        d.extend_from_slice(&[7u8; 32]); // write_authority
        match level {
            None => d.push(VERIFICATION_FULL),
            Some(n) => {
                d.push(VERIFICATION_PARTIAL);
                d.push(n);
            }
        }
        d.extend_from_slice(&p.feed_id);
        d.extend_from_slice(&p.price.to_le_bytes());
        d.extend_from_slice(&p.conf.to_le_bytes());
        d.extend_from_slice(&p.exponent.to_le_bytes());
        d.extend_from_slice(&p.publish_time.to_le_bytes());
        d.extend_from_slice(&(p.publish_time - 1).to_le_bytes()); // prev_publish_time
        d.extend_from_slice(&p.price.to_le_bytes()); // ema_price
        d.extend_from_slice(&p.conf.to_le_bytes()); // ema_conf
        d.extend_from_slice(&123u64.to_le_bytes()); // posted_slot
        d
    }

    fn sol(price: i64, conf: u64, exponent: i32, publish_time: i64) -> PythPrice {
        PythPrice {
            feed_id: PYTH_FEED_SOL_USD,
            price,
            conf,
            exponent,
            publish_time,
        }
    }

    #[test]
    fn constants_match_their_sources() {
        // `sha256("account:PriceUpdateV2")[..8]`, as the receiver program
        // writes it on the real account snapshot below.
        assert_eq!(
            PRICE_UPDATE_V2_DISCRIMINATOR[..],
            b64(DEVNET_SOL_USD_B64)[..8]
        );
        assert_eq!(
            PYTH_FEED_SOL_USD,
            hex32("ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d")
        );
        assert_eq!(
            PYTH_FEED_USDC_USD,
            hex32("eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a")
        );
        assert_eq!(
            PYTH_FEED_USDT_USD,
            hex32("2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b")
        );
        // The sponsored SOL/USD account is the push-oracle PDA [shard 0, feed].
        let (feed_account, _) = Pubkey::find_program_address(
            &[&0u16.to_le_bytes(), &PYTH_FEED_SOL_USD],
            &PYTH_PUSH_ORACLE_PROGRAM_ID,
        );
        assert_eq!(
            feed_account,
            pubkey!("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE")
        );
    }

    #[test]
    fn pinned_feeds_cover_exactly_the_three_majors() {
        assert_eq!(pinned_pyth_feed(&WSOL_MINT), Some(PYTH_FEED_SOL_USD));
        assert_eq!(pinned_pyth_feed(&USDC_MINT), Some(PYTH_FEED_USDC_USD));
        assert_eq!(pinned_pyth_feed(&USDT_MINT), Some(PYTH_FEED_USDT_USD));
        assert_eq!(pinned_pyth_feed(&Pubkey::new_unique()), None);
    }

    #[test]
    fn parses_the_real_devnet_sol_usd_account() {
        let data = b64(DEVNET_SOL_USD_B64);
        assert_eq!(
            data.len(),
            134,
            "sponsored accounts are allocated for the Partial size"
        );
        let p = parse_price_update_v2(&data).expect("parses");
        assert_eq!(p.feed_id, PYTH_FEED_SOL_USD);
        assert_eq!(p.exponent, -8);
        assert!(p.price > 0);
        // $10..$10,000 — a sanity band, not a price assertion.
        let usd = scale_to_1e6(p.price as u64, p.exponent, false).unwrap();
        assert!(usd > 10_000_000 && usd < 10_000_000_000, "usd_1e6={usd}");
        assert!(p.publish_time > 1_700_000_000);
    }

    #[test]
    fn parses_full_verification_one_byte_level() {
        let want = sol(15_012_345_678, 7_000_000, -8, 1_800_000_000);
        let data = encode(None, &want);
        assert_eq!(data.len(), 8 + 32 + 1 + 84 + 8);
        assert_eq!(parse_price_update_v2(&data).unwrap(), want);
        // Trailing bytes (the account is allocated for the 2-byte level) are fine.
        let mut padded = data.clone();
        padded.push(0);
        assert_eq!(parse_price_update_v2(&padded).unwrap(), want);
    }

    #[test]
    fn rejects_partial_verification_two_byte_level() {
        let data = encode(Some(5), &sol(15_000_000_000, 1, -8, 1_800_000_000));
        assert_eq!(data.len(), 8 + 32 + 2 + 84 + 8);
        assert_eq!(
            parse_price_update_v2(&data).unwrap_err(),
            LaunchpadError::PythNotFullyVerified.into()
        );
    }

    #[test]
    fn rejects_malformed_accounts() {
        let good = encode(None, &sol(1, 0, -8, 1));
        // Wrong discriminator.
        let mut bad = good.clone();
        bad[0] ^= 1;
        assert_eq!(
            parse_price_update_v2(&bad).unwrap_err(),
            LaunchpadError::PythAccountInvalid.into()
        );
        // Unknown verification level.
        let mut bad = good.clone();
        bad[40] = 2;
        assert_eq!(
            parse_price_update_v2(&bad).unwrap_err(),
            LaunchpadError::PythAccountInvalid.into()
        );
        // Every truncation fails cleanly (no panic).
        for len in 0..good.len() {
            assert_eq!(
                parse_price_update_v2(&good[..len]).unwrap_err(),
                LaunchpadError::PythAccountInvalid.into(),
                "len={len}"
            );
        }
        assert!(parse_price_update_v2(&[]).is_err());
    }

    #[test]
    fn scales_every_exponent_to_1e6() {
        // $150.12345678 at 1e-8 → 150.123456 (floor) / 150.123457 (ceil).
        assert_eq!(
            scale_to_1e6(15_012_345_678, -8, false).unwrap(),
            150_123_456
        );
        assert_eq!(scale_to_1e6(15_012_345_678, -8, true).unwrap(), 150_123_457);
        // Exact at -6, multiplied above it.
        assert_eq!(scale_to_1e6(1_234, -6, false).unwrap(), 1_234);
        assert_eq!(scale_to_1e6(1_234, -5, false).unwrap(), 12_340);
        assert_eq!(scale_to_1e6(3, 0, false).unwrap(), 3_000_000);
        assert_eq!(scale_to_1e6(3, 2, false).unwrap(), 300_000_000);
        // Exact results never round up.
        assert_eq!(scale_to_1e6(100_000_000, -8, true).unwrap(), 1_000_000);
        // Overflow is an error, not a wrap.
        assert_eq!(
            scale_to_1e6(u64::MAX, 0, false).unwrap_err(),
            LaunchpadError::MathOverflow.into()
        );
        assert!(scale_to_1e6(1, 40, false).is_err());
        assert!(scale_to_1e6(1, i32::MAX, false).is_err());
        // Extreme negative exponents floor to zero (ceil to one) without panicking.
        assert_eq!(scale_to_1e6(u64::MAX, -60, false).unwrap(), 0);
        assert_eq!(scale_to_1e6(u64::MAX, -60, true).unwrap(), 1);
        assert_eq!(scale_to_1e6(0, -60, true).unwrap(), 0);
        assert!(scale_to_1e6(1, i32::MIN, false).is_ok());
    }

    #[test]
    fn writes_a_newer_valid_update() {
        let now = 1_800_000_100;
        let u = sol(15_012_345_678, 7_654_321, -8, now - 2);
        assert_eq!(
            evaluate_sync(&u, &PYTH_FEED_SOL_USD, now - 60, now).unwrap(),
            SyncOutcome::Write {
                price_1e6: 150_123_456,
                conf_1e6: 76_544,
                publish_time: now - 2,
            }
        );
        // A fresh BaseOracle (publish_time 0) takes any update.
        assert!(matches!(
            evaluate_sync(&u, &PYTH_FEED_SOL_USD, 0, now).unwrap(),
            SyncOutcome::Write { .. }
        ));
    }

    #[test]
    fn older_or_equal_updates_are_a_no_op() {
        let now = 1_800_000_100;
        let u = sol(15_000_000_000, 1, -8, now - 10);
        assert_eq!(
            evaluate_sync(&u, &PYTH_FEED_SOL_USD, now - 10, now).unwrap(),
            SyncOutcome::NoOp
        );
        assert_eq!(
            evaluate_sync(&u, &PYTH_FEED_SOL_USD, now - 5, now).unwrap(),
            SyncOutcome::NoOp
        );
        // A no-op is decided before price validity: a stale update with a
        // wide band or a bad price never reverts the launch it rides with.
        let wide = sol(15_000_000_000, 15_000_000_000, -8, now - 10);
        assert_eq!(
            evaluate_sync(&wide, &PYTH_FEED_SOL_USD, now, now).unwrap(),
            SyncOutcome::NoOp
        );
        let negative = sol(-1, 0, -8, now - 10);
        assert_eq!(
            evaluate_sync(&negative, &PYTH_FEED_SOL_USD, now, now).unwrap(),
            SyncOutcome::NoOp
        );
    }

    #[test]
    fn future_publish_times_are_tolerated_only_within_the_skew() {
        let now = 1_800_000_100;
        let slightly = sol(15_000_000_000, 1, -8, now + PYTH_MAX_FUTURE_SKEW_SECS);
        assert!(matches!(
            evaluate_sync(&slightly, &PYTH_FEED_SOL_USD, 0, now).unwrap(),
            SyncOutcome::Write { .. }
        ));
        let far = sol(15_000_000_000, 1, -8, now + PYTH_MAX_FUTURE_SKEW_SECS + 1);
        assert_eq!(
            evaluate_sync(&far, &PYTH_FEED_SOL_USD, 0, now).unwrap(),
            SyncOutcome::NoOp
        );
        let absurd = sol(15_000_000_000, 1, -8, i64::MAX);
        assert_eq!(
            evaluate_sync(&absurd, &PYTH_FEED_SOL_USD, 0, i64::MAX - 1).unwrap(),
            SyncOutcome::Write {
                price_1e6: 150_000_000,
                conf_1e6: 1,
                publish_time: i64::MAX
            }
        );
    }

    #[test]
    fn feed_mismatch_is_an_error_even_when_stale() {
        let now = 1_800_000_100;
        let mut u = sol(100_000_000, 1, -8, now - 1);
        u.feed_id = PYTH_FEED_USDC_USD;
        assert_eq!(
            evaluate_sync(&u, &PYTH_FEED_SOL_USD, 0, now).unwrap_err(),
            LaunchpadError::PythFeedMismatch.into()
        );
        assert_eq!(
            evaluate_sync(&u, &PYTH_FEED_SOL_USD, now, now).unwrap_err(),
            LaunchpadError::PythFeedMismatch.into()
        );
    }

    #[test]
    fn rejects_non_positive_prices_and_wide_bands() {
        let now = 1_800_000_100;
        for price in [0i64, -1, i64::MIN] {
            assert_eq!(
                evaluate_sync(&sol(price, 0, -8, now), &PYTH_FEED_SOL_USD, 0, now).unwrap_err(),
                LaunchpadError::OracleInvalid.into()
            );
        }
        // Exactly MAX_ORACLE_CONF_BPS (2%) passes; one atom more fails.
        let price = 10_000_000_000i64;
        let edge = price as u64 * MAX_ORACLE_CONF_BPS / BPS_DEN;
        assert!(evaluate_sync(&sol(price, edge, -8, now), &PYTH_FEED_SOL_USD, 0, now).is_ok());
        assert_eq!(
            evaluate_sync(
                &sol(price, edge + price as u64 / BPS_DEN, -8, now),
                &PYTH_FEED_SOL_USD,
                0,
                now
            )
            .unwrap_err(),
            LaunchpadError::OracleUnreliable.into()
        );
        // A positive price that floors to zero at 1e6 is refused too.
        assert_eq!(
            evaluate_sync(&sol(1, 0, -8, now), &PYTH_FEED_SOL_USD, 0, now).unwrap_err(),
            LaunchpadError::OracleInvalid.into()
        );
        // And one that overflows u64 at 1e6 is an overflow, not a wrap.
        assert_eq!(
            evaluate_sync(&sol(i64::MAX, 0, 0, now), &PYTH_FEED_SOL_USD, 0, now).unwrap_err(),
            LaunchpadError::MathOverflow.into()
        );
    }

    #[test]
    fn the_written_price_passes_read_fresh_price() {
        use crate::instructions::admin::read_fresh_price;
        use crate::state::{BaseOracle, Global};
        let now = 1_800_000_100;
        let u = sol(15_012_345_678, 150_000_000, -8, now - 3);
        let SyncOutcome::Write {
            price_1e6,
            conf_1e6,
            publish_time,
        } = evaluate_sync(&u, &PYTH_FEED_SOL_USD, 0, now).unwrap()
        else {
            panic!("expected a write")
        };
        let oracle = BaseOracle {
            bump: 255,
            base_mint: WSOL_MINT,
            price_1e6,
            conf_1e6,
            publish_time,
            base_decimals: 9,
        };
        let mut global = Global {
            bump: 255,
            admin: Pubkey::default(),
            pending_admin: Pubkey::default(),
            protocol_withdraw_authority: Pubkey::default(),
            ops_withdraw_authority: Pubkey::default(),
            oracle_authority: Pubkey::default(),
            migration_authority: Pubkey::default(),
            dex_program: Pubkey::default(),
            dex_config: Pubkey::default(),
            trading_paused: false,
            launch_paused: false,
            protocol_withdrawals_paused: false,
            ops_withdrawals_paused: false,
            max_oracle_staleness: 90,
            token_count: 0,
        };
        assert_eq!(
            read_fresh_price(&oracle, &global, now).unwrap(),
            150_123_456
        );
        // Staleness is measured from Pyth's publish time, not the sync's.
        global.max_oracle_staleness = 2;
        assert_eq!(
            read_fresh_price(&oracle, &global, now).unwrap_err(),
            LaunchpadError::OracleStale.into()
        );
    }
}
