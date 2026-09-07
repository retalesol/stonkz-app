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

/// The binding safety constraint on curve size.
///
/// SPL token amounts are `u64`, and `real_base` reaches `3 · virtual_base` by
/// graduation while `virtual_base` itself reaches `4 · virtual_base_0`. So the
/// real limit is not `k` — which sits four orders of magnitude below the `u128`
/// roof even for the largest supply against the cheapest base — it is that the
/// graduated base reserve still fits a `u64`. `create_token` rejects any
/// (supply, base price, base decimals) combination that would not.
///
/// This is what rules out very low-priced 18-decimal base mints on Solana. The
/// EVM mirror uses `uint256` and is strictly more permissive.
pub const MAX_VIRTUAL_BASE: u128 = (u64::MAX as u128) / 4;

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
///
/// The accumulator divides a reward in *base* atoms by a weight in *launched
/// token* atoms, so the scale has to span the gap between two unrelated
/// magnitudes. `1e12` is not enough: the largest allowed supply is 1e12 tokens,
/// which at 6 decimals and the 365-day multiplier gives a fully-staked weight
/// of 8e18, and `reward · 1e12 / 8e18` truncates to **zero** for any reward
/// under 8 million atoms. Stakers on such a coin would accrue nothing at all
/// while the pool banked their entire share as dust — silent, with no error
/// anywhere. Even a 1e9-supply coin only resolved to about 1 part in 125.
///
/// `1e18` gives every allowed supply at least five significant digits per
/// accrual, and the products stay inside `u128`: `amount · ACC_PRECISION` peaks
/// near 1.8e37, and `weight · (acc − debt)` is bounded by total rewards times
/// the scale — also about 1.8e37 — against a 3.4e38 ceiling.
///
/// The EVM mirror uses `1e36` for the same reason and by the same argument; its
/// launched tokens are 18 decimals rather than 6, so its gap is twelve orders
/// wider. This is the one constant the two chains are allowed to disagree on,
/// because it is a function of token decimals and not of the fee model.
pub const ACC_PRECISION: u128 = 1_000_000_000_000_000_000;

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

/* -------------------------------------------------------------------------- */
/* Graduation migration (Raydium CPMM) — see SPEC.md §5 and §7                */
/* -------------------------------------------------------------------------- */

/// Program-derived, unique per (this program, mint). Used as the CPI "creator"
/// account for Raydium's `Initialize`: it signs via `invoke_signed`, holds the
/// deposited reserves for the instant it takes to seed the pool, and receives
/// (then immediately burns) 100% of the minted LP. No wallet — not even
/// `migration_authority` — ever controls this key, which is what makes the
/// burn irreversible rather than merely "nobody has done it yet".
pub const SEED_RAYDIUM_ESCROW: &[u8] = b"raydium_escrow";

/// Our own PDA, used as Raydium's non-canonical `pool_state`. Nothing but this
/// program can ever produce a valid signature for this address, so nobody can
/// occupy it ahead of a graduation the way they could Raydium's canonical
/// `["pool", amm_config, token_0, token_1]` PDA — see `graduate.rs`'s
/// `MigrateLiquidity` doc comment for the full argument.
pub const SEED_RAYDIUM_POOL: &[u8] = b"raydium_pool";

/// Raydium CPMM's own seed strings (`raydium-cp-swap/src/states/*`), needed to
/// derive and validate its PDAs via Anchor's `seeds::program`. Copied here
/// rather than pulled in as a crate dependency — see `graduate.rs` for why this
/// integration is a hand-built CPI instead of `raydium_cp_swap::cpi::*`.
pub const RAYDIUM_AUTH_SEED: &[u8] = b"vault_and_lp_mint_auth_seed";
pub const RAYDIUM_POOL_LP_MINT_SEED: &[u8] = b"pool_lp_mint";
pub const RAYDIUM_POOL_VAULT_SEED: &[u8] = b"pool_vault";
pub const RAYDIUM_OBSERVATION_SEED: &[u8] = b"observation";

/// Anchor instruction discriminator for `raydium_cp_swap::initialize`
/// (`sha256("global:initialize")[..8]`). Verified against
/// `raydium-io/raydium-cp-swap`'s published IDL; see `graduate.rs`.
pub const RAYDIUM_INITIALIZE_DISCRIMINATOR: [u8; 8] = [175, 175, 109, 31, 13, 152, 155, 237];

/// Rent buffer transferred from `migration_authority` into the escrow before
/// the CPI, on top of `amm_config.create_pool_fee` (read live from the
/// account, not hardcoded — see `graduate.rs`, it is 0.15 SOL on both of
/// Raydium's published mainnet and devnet default configs, and the AmmConfig
/// this network uses is itself admin-chosen via `set_raydium_config`, so it is
/// not something this program should guess at). This buffer covers
/// `lp_mint` + `pool_state` + `observation_state` + two vault accounts' rent.
/// Any unspent lamports stay in the escrow permanently — a small, bounded,
/// documented dust cost. Nobody can reclaim it because nobody but this
/// program can ever sign for that PDA again.
pub const RAYDIUM_MIGRATION_RENT_BUFFER_LAMPORTS: u64 = 50_000_000; // 0.05 SOL

/// Byte offset of `AmmConfig.create_pool_fee` within its account data,
/// including the 8-byte Anchor discriminator:
/// `8 (disc) + bump(1) + disable_create_pool(1) + index(2) + trade_fee_rate(8)
/// + protocol_fee_rate(8) + fund_fee_rate(8)`. Confirmed against
/// `raydium-io/raydium-cp-swap/programs/cp-swap/src/states/config.rs`.
pub const RAYDIUM_AMM_CONFIG_CREATE_POOL_FEE_OFFSET: usize = 8 + 1 + 1 + 2 + 8 + 8 + 8;
