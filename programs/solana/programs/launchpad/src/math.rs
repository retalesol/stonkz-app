//! Pure settlement arithmetic. No Anchor, no accounts, no clock — everything
//! here is a function of its arguments so it can be fuzzed on the host in
//! milliseconds instead of on a validator.
//!
//! The EVM mirror in `programs/evm/src/CurveMath.sol` implements the same
//! functions with the same rounding, and `tests/parity.json` is generated from
//! this module so both chains can be checked against one table.

use crate::constants::*;

/// Every rounding decision in this file is "toward the pool". Traders never
/// gain an atom from truncation; the curve invariant only ever tightens.
#[inline]
fn ceil_div(a: u128, b: u128) -> Option<u128> {
    if b == 0 {
        return None;
    }
    Some(a.div_ceil(b))
}

#[inline]
fn mul_div_floor(a: u128, b: u128, d: u128) -> Option<u128> {
    if d == 0 {
        return None;
    }
    a.checked_mul(b)?.checked_div(d)
}

/* -------------------------------------------------------------------------- */
/* Fee split                                                                   */
/* -------------------------------------------------------------------------- */

/// The three destinations of one curve fee.
///
/// `protocol` and `stonkz_ops` are floors of their nominal shares;
/// `creator_bucket` is the **remainder**, so the identity
/// `protocol + stonkz_ops + creator_bucket == fee` holds for every input with
/// no exceptions. At most 2 atoms of floor dust land in the creator bucket.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct FeeShares {
    pub protocol: u64,
    pub stonkz_ops: u64,
    pub creator_bucket: u64,
}

pub fn split_fee(fee: u64) -> FeeShares {
    let f = fee as u128;
    // Both shares are < fee, so the casts below cannot truncate.
    let protocol = (f * FEE_PROTOCOL_BPS as u128 / BPS_DEN as u128) as u64;
    let stonkz_ops = (f * FEE_OPS_BPS as u128 / BPS_DEN as u128) as u64;
    FeeShares {
        protocol,
        stonkz_ops,
        creator_bucket: fee - protocol - stonkz_ops,
    }
}

/// How the 70% creator bucket divides between the creator and that coin's
/// stakers. This runs *after* `split_fee`, on the creator bucket alone —
/// protocol and ops are already in other accounts and cannot reach here.
///
/// `stakers = floor(bucket · eligible_staked / (2 · circulating))`, clamped to
/// half the bucket. That is `poolFrac = min(0.5, 0.5·staked/circulating)` from
/// `packages/shared`, done in integers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct BucketSplit {
    pub creator: u64,
    pub stakers: u64,
}

pub fn split_creator_bucket(bucket: u64, eligible_staked: u64, circulating: u64) -> BucketSplit {
    let half = bucket / 2;
    if bucket == 0 || eligible_staked == 0 || circulating == 0 {
        return BucketSplit {
            creator: bucket,
            stakers: 0,
        };
    }
    let denom = (circulating as u128) * 2;
    let raw = (bucket as u128) * (eligible_staked as u128) / denom;
    let stakers = core::cmp::min(raw, half as u128) as u64;
    BucketSplit {
        creator: bucket - stakers,
        stakers,
    }
}

/* -------------------------------------------------------------------------- */
/* Cashback                                                                    */
/* -------------------------------------------------------------------------- */

/// Effective curve fee in basis points at `now`.
///
/// Outside a cashback window this is the creator's own fee. Inside it decays
/// linearly from 5000 bps to that fee across 300 seconds. Whole-second
/// granularity, because that is what `Clock` gives us.
pub fn eff_fee_bps(base_bps: u16, cashback: bool, cb_start: i64, now: i64) -> u16 {
    if !cashback {
        return base_bps;
    }
    let remaining = cb_start + CB_WINDOW_SECS - now;
    if remaining <= 0 {
        return base_bps;
    }
    let remaining = core::cmp::min(remaining, CB_WINDOW_SECS) as u64;
    let base = base_bps as u64;
    // base_bps is capped at 500, so the sum cannot exceed 5000 and fits a u16.
    (base + (CB_START_FEE_BPS - base) * remaining / CB_WINDOW_SECS as u64) as u16
}

/* -------------------------------------------------------------------------- */
/* Curve parameters                                                            */
/* -------------------------------------------------------------------------- */

/// The launch-time shape of one curve. See SPEC.md §1 for the derivation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CurveParams {
    pub tokens_for_sale: u64,
    pub lp_reserve: u64,
    pub virtual_token: u128,
    pub virtual_base: u128,
    pub k: u128,
    /// Base atoms that equal $69,000 at the oracle price read at creation.
    pub grad_mcap_base: u128,
}

/// Base atoms worth $69,000 at `price_1e6` USD per whole base token.
pub fn grad_mcap_base_atoms(price_1e6: u64, base_decimals: u8) -> Option<u128> {
    if price_1e6 == 0 || base_decimals > 18 {
        return None;
    }
    let scale = 10u128.checked_pow(base_decimals as u32)?;
    GRAD_MCAP_USD_1E6
        .checked_mul(scale)?
        .checked_div(price_1e6 as u128)
}

/// Derive every curve parameter from the fixed supply and the base price.
pub fn derive_curve(supply_atoms: u64, price_1e6: u64, base_decimals: u8) -> Option<CurveParams> {
    if supply_atoms == 0 {
        return None;
    }
    let s = supply_atoms as u128;

    // Exact for all four allowed supplies — every one is divisible by 5.
    let tokens_for_sale = s.checked_mul(TOKENS_FOR_SALE_NUM)? / TOKENS_FOR_SALE_DEN;
    let lp_reserve = s - tokens_for_sale;

    // floor(16·S/15). The <1-atom truncation is analysed in SPEC.md §1.
    let virtual_token = s.checked_mul(VIRTUAL_TOKEN_NUM)? / VIRTUAL_TOKEN_DEN;
    if virtual_token <= tokens_for_sale {
        return None;
    }

    let grad_mcap_base = grad_mcap_base_atoms(price_1e6, base_decimals)?;
    // Ceil, not floor. Graduation mcap is `15 · virtual_base`, so rounding up
    // here guarantees the curve closes at or fractionally above $69,000 and
    // never below it. With a floor the residue lands on the wrong side: for a
    // 1M supply against an 8-decimal, $4312.50 base it graduated $0.0003 short.
    let virtual_base = ceil_div(grad_mcap_base, VIRTUAL_BASE_DEN)?;
    // `virtual_base` quadruples on the way to graduation and every base amount
    // the program moves is a u64, so refuse a curve whose graduated reserve
    // would not fit one.
    if virtual_base == 0 || virtual_base > MAX_VIRTUAL_BASE {
        return None;
    }

    let k = virtual_base.checked_mul(virtual_token)?;

    Some(CurveParams {
        tokens_for_sale: u64::try_from(tokens_for_sale).ok()?,
        lp_reserve: u64::try_from(lp_reserve).ok()?,
        virtual_token,
        virtual_base,
        k,
        grad_mcap_base,
    })
}

/* -------------------------------------------------------------------------- */
/* Live curve state                                                            */
/* -------------------------------------------------------------------------- */

/// The mutable half of a curve, as the quote functions see it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CurveState {
    pub virtual_base: u128,
    pub virtual_token: u128,
    pub real_base: u64,
    pub real_token: u64,
    pub k: u128,
}

/// Result of a buy against the curve.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct BuyFill {
    /// Base actually pulled from the trader. Less than `amount_base` when the
    /// order was capped by the remaining curve reserve.
    pub gross_base: u64,
    pub fee: u64,
    /// `gross_base - fee` — the part that enters the pool.
    pub net_base: u64,
    pub tokens_out: u64,
    /// True when the fill emptied the curve allocation.
    pub curve_complete: bool,
}

/// Buy `amount_base` worth of tokens.
///
/// If the order would drain more than the remaining allocation, it is **capped
/// rather than rejected**: we solve for the exact base needed to buy the rest of
/// the curve, gross it back up through the fee, and only pull that much. The
/// trader is never overcharged for tokens that do not exist.
pub fn buy_quote(state: &CurveState, fee_bps: u16, amount_base: u64) -> Option<BuyFill> {
    if amount_base == 0 || state.real_token == 0 {
        return None;
    }
    let bps = fee_bps as u128;
    if bps >= BPS_DEN as u128 {
        return None;
    }

    let fee = mul_div_floor(amount_base as u128, bps, BPS_DEN as u128)?;
    let net = amount_base as u128 - fee;
    if net == 0 {
        return None;
    }

    let new_vb = state.virtual_base.checked_add(net)?;
    // ceil the new token reserve so tokens_out rounds down.
    let new_vt = ceil_div(state.k, new_vb)?;
    let tokens_out = state.virtual_token.checked_sub(new_vt)?;

    if tokens_out <= state.real_token as u128 {
        return Some(BuyFill {
            gross_base: amount_base,
            fee: u64::try_from(fee).ok()?,
            net_base: u64::try_from(net).ok()?,
            tokens_out: u64::try_from(tokens_out).ok()?,
            curve_complete: tokens_out == state.real_token as u128,
        });
    }

    // Capped path: buy exactly the remainder of the allocation.
    let tokens_out = state.real_token as u128;
    let new_vt = state.virtual_token.checked_sub(tokens_out)?;
    if new_vt == 0 {
        return None;
    }
    let needed_vb = ceil_div(state.k, new_vt)?;
    let net_needed = needed_vb.checked_sub(state.virtual_base)?;
    if net_needed == 0 {
        return None;
    }
    // Gross the net back up so that floor(gross·bps/10000) still leaves at
    // least `net_needed` in the pool.
    let gross = ceil_div(
        net_needed.checked_mul(BPS_DEN as u128)?,
        BPS_DEN as u128 - bps,
    )?;
    let fee = gross.checked_sub(net_needed)?;

    Some(BuyFill {
        gross_base: u64::try_from(gross).ok()?,
        fee: u64::try_from(fee).ok()?,
        net_base: u64::try_from(net_needed).ok()?,
        tokens_out: u64::try_from(tokens_out).ok()?,
        curve_complete: true,
    })
}

/// Result of a sell against the curve.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SellFill {
    /// Base leaving the pool, before the fee is peeled off it.
    pub gross_base: u64,
    pub fee: u64,
    /// What the trader receives.
    pub net_base: u64,
    pub tokens_in: u64,
}

/// Sell `amount_token` back into the curve.
///
/// The fee is taken out of the base the pool pays out, so the pool's base
/// balance falls by `gross_base` and the trader receives `gross_base - fee`.
pub fn sell_quote(state: &CurveState, fee_bps: u16, amount_token: u64) -> Option<SellFill> {
    if amount_token == 0 {
        return None;
    }
    let bps = fee_bps as u128;
    if bps >= BPS_DEN as u128 {
        return None;
    }

    let new_vt = state.virtual_token.checked_add(amount_token as u128)?;
    // ceil the new base reserve so base out rounds down.
    let new_vb = ceil_div(state.k, new_vt)?;
    let gross = state.virtual_base.checked_sub(new_vb)?;
    // A sell can never withdraw more than the real base the pool actually holds.
    let gross = core::cmp::min(gross, state.real_base as u128);
    if gross == 0 {
        return None;
    }

    let fee = mul_div_floor(gross, bps, BPS_DEN as u128)?;
    Some(SellFill {
        gross_base: u64::try_from(gross).ok()?,
        fee: u64::try_from(fee).ok()?,
        net_base: u64::try_from(gross - fee).ok()?,
        tokens_in: amount_token,
    })
}

/// Swap base into tokens at **zero fee** — the cashback path, where the creator
/// bucket is converted to the launched token. Returns `None` if the remaining
/// allocation cannot cover it, in which case the caller falls back to accruing
/// the bucket in base.
pub fn zero_fee_buy(state: &CurveState, amount_base: u64) -> Option<u64> {
    if amount_base == 0 || state.real_token == 0 {
        return None;
    }
    let new_vb = state.virtual_base.checked_add(amount_base as u128)?;
    let new_vt = ceil_div(state.k, new_vb)?;
    let tokens_out = state.virtual_token.checked_sub(new_vt)?;
    if tokens_out == 0 || tokens_out > state.real_token as u128 {
        return None;
    }
    u64::try_from(tokens_out).ok()
}

/* -------------------------------------------------------------------------- */
/* Valuation                                                                   */
/* -------------------------------------------------------------------------- */

/// Market cap in base atoms: spot price × fixed supply.
pub fn mcap_base(state: &CurveState, supply_atoms: u64) -> Option<u128> {
    mul_div_floor(state.virtual_base, supply_atoms as u128, state.virtual_token)
}

/// Market cap in USD, scaled 1e6.
pub fn mcap_usd_1e6(mcap_base: u128, price_1e6: u64, base_decimals: u8) -> Option<u128> {
    let scale = 10u128.checked_pow(base_decimals as u32)?;
    mul_div_floor(mcap_base, price_1e6 as u128, scale)
}

/// Tokens actually sold out of the curve allocation — the circulating supply
/// the staking pool measures itself against. Replaces the UI's hard-coded 80%.
pub fn circulating(tokens_for_sale: u64, real_token: u64) -> u64 {
    tokens_for_sale.saturating_sub(real_token)
}

/// Lock weight of a staked amount. FLEX returns 0 by design.
pub fn stake_weight(amount: u64, lock_days: u16) -> Option<u128> {
    let idx = LOCK_DAYS.iter().position(|d| *d == lock_days)?;
    mul_div_floor(
        amount as u128,
        LOCK_WEIGHT_BPS[idx] as u128,
        BPS_DEN as u128,
    )
}

/// Reward owed to a position given the pool accumulator it last settled at.
pub fn pending_reward(weight: u128, acc: u128, debt: u128) -> Option<u64> {
    let delta = acc.checked_sub(debt)?;
    u64::try_from(weight.checked_mul(delta)? / ACC_PRECISION).ok()
}

/// Advance a reward accumulator by `amount` spread over `total_weight`.
///
/// Returns the new accumulator and the dust that would not divide evenly. The
/// caller carries the dust into the next accrual, so nothing is lost and the
/// pool stays solvent.
///
/// The commitment is rounded **up**. A staker claims
/// `floor(weight · Σ steps / ACC)`, and the floor of a sum is not the sum of
/// floors — it can be larger by up to one unit per step. Committing the floored
/// amount here would therefore let the pool promise a few atoms more than it
/// actually received, and the last staker to claim would find the vault short.
/// Rounding the commitment up makes total claims provably bounded by total
/// inflow.
pub fn advance_acc(acc: u128, amount: u64, total_weight: u128) -> Option<(u128, u64)> {
    if total_weight == 0 || amount == 0 {
        return Some((acc, amount));
    }
    let scaled = (amount as u128).checked_mul(ACC_PRECISION)?;
    let per_weight = scaled / total_weight;
    if per_weight == 0 {
        // Too small to move the accumulator at all — hold all of it.
        return Some((acc, amount));
    }
    let committed = u64::try_from(
        per_weight
            .checked_mul(total_weight)?
            .div_ceil(ACC_PRECISION),
    )
    .ok()?;
    Some((acc.checked_add(per_weight)?, amount.saturating_sub(committed)))
}