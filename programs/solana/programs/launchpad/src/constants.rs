//! Every number here is mirrored in `programs/curve.json` and in
//! `packages/shared`. Changing one without the other two is a bug.

/// Basis-point denominator.
pub const BPS_DEN: u64 = 10_000;

/* -------------------------------------------------------------------------- */
/* Fee split — see SPEC.md §2                                                  */
/* -------------------------------------------------------------------------- */

/// Protocol revenue share of the curve fee.
pub const FEE_PROTOCOL_BPS: u64 = 2_000;
/// `$STONKZ` operations share of the curve fee.
pub const FEE_OPS_BPS: u64 = 1_000;
/// The creator bucket is deliberately *not* a constant: it is the remainder,
/// so the three shares sum to the fee exactly. This value exists only so tests
/// and the IDL can assert the nominal 70%.
pub const FEE_CREATOR_BUCKET_BPS_NOMINAL: u64 = 7_000;

/// Creator-set curve fee bounds, matching the launch slider's 1.0–5.0%.
pub const MIN_FEE_BPS: u16 = 100;
pub const MAX_FEE_BPS: u16 = 500;

/* -------------------------------------------------------------------------- */
/* Curve shape — see SPEC.md §1                                                */
/* -------------------------------------------------------------------------- */

/// Fraction of supply sellable on the curve: 4/5.
pub const TOKENS_FOR_SALE_NUM: u128 = 4;
pub const TOKENS_FOR_SALE_DEN: u128 = 5;

/// Initial virtual token reserves as a multiple of supply: 16/15.
/// Forced by the "LP opens at the curve's closing price" constraint given the
/// 4/5 sale fraction.
pub const VIRTUAL_TOKEN_NUM: u128 = 16;
pub const VIRTUAL_TOKEN_DEN: u128 = 15;

/// Initial virtual base reserves as a fraction of the graduation market cap.
pub const VIRTUAL_BASE_DEN: u128 = 15;

/// $69,000, scaled 1e6.
pub const GRAD_MCAP_USD_1E6: u128 = 69_000_000_000;

/// Launched mints always use 6 decimals.
pub const TOKEN_DECIMALS: u8 = 6;

/// The four supplies the launch stepper offers, in whole tokens.
pub const ALLOWED_SUPPLIES: [u64; 4] = [1_000_000, 500_000_000, 1_000_000_000, 1_000_000_000_000];

/// Guard rail on `k` so a pathological base mint cannot get near the u128 roof.
pub const MAX_K: u128 = u128::MAX / 1_000_000;

/* -------------------------------------------------------------------------- */
/* Cashback — see SPEC.md §3                                                   */
/* -------------------------------------------------------------------------- */

/// Cashback window, seconds. The UI's `CB_MS` is this × 1000.
pub const CB_WINDOW_SECS: i64 = 300;
/// The fee the window decays down from: 50%.
pub const CB_START_FEE_BPS: u64 = 5_000;

/* -------------------------------------------------------------------------- */
/* Staking — see SPEC.md §2                                                    */
/* -------------------------------------------------------------------------- */

/// Selectable lock terms, days.
pub const LOCK_DAYS: [u16; 7] = [0, 1, 7, 30, 90, 180, 365];

/// Pool weight per lock term, basis points of the staked amount.
///
/// FLEX (index 0) is **zero**: a 0-day position parks tokens but earns no share
/// of the creator bucket. The UI's `LOCKS` table shows 1× for FLEX — that is
/// display chrome for the lock grid, not pool weight. Anti-wash, plan step 134.
pub const LOCK_WEIGHT_BPS: [u64; 7] = [0, 11_000, 12_500, 15_000, 25_000, 50_000, 80_000];

/// Fixed-point scale for the reward-per-weight accumulators.
pub const ACC_PRECISION: u128 = 1_000_000_000_000;

/* -------------------------------------------------------------------------- */
/* Oracle                                                                      */
/* -------------------------------------------------------------------------- */

/// Default max age of an oracle push before it is considered stale, seconds.
pub const DEFAULT_MAX_ORACLE_STALENESS: i64 = 90;

/// Reject an oracle read whose confidence exceeds this fraction of the price.
pub const MAX_ORACLE_CONF_BPS: u64 = 200;

/* -------------------------------------------------------------------------- */
/* PDA seeds                                                                   */
/* -------------------------------------------------------------------------- */

pub const SEED_GLOBAL: &[u8] = b"global";
pub const SEED_ORACLE: &[u8] = b"oracle";
pub const SEED_CURVE: &[u8] = b"curve";
pub const SEED_MINT: &[u8] = b"mint";
pub const SEED_CURVE_BASE_VAULT: &[u8] = b"curve_base";
pub const SEED_CURVE_TOKEN_VAULT: &[u8] = b"curve_token";
pub const SEED_LP_VAULT: &[u8] = b"lp_vault";
pub const SEED_BUCKET_BASE_VAULT: &[u8] = b"bucket_base";
pub const SEED_BUCKET_TOKEN_VAULT: &[u8] = b"bucket_token";
pub const SEED_STAKE_ESCROW: &[u8] = b"stake_escrow";
pub const SEED_STAKE_POSITION: &[u8] = b"stake";
pub const SEED_PROTOCOL_VAULT: &[u8] = b"protocol_vault";
pub const SEED_OPS_VAULT: &[u8] = b"ops_vault";
