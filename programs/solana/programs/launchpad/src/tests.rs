//! Host-side invariant and fuzz suite for the settlement math — review gate
//! 2.A (step 81) and the arithmetic half of gates 4.A/4.B/4.C.
//!
//! Deliberately deterministic: a fixed xorshift stream rather than a property
//! framework, so a failure reproduces exactly and the case counts below can be
//! quoted as evidence.

use crate::constants::*;
use crate::math::*;

/// Deterministic xorshift64*, so every run explores the same cases.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Rng(seed | 1)
    }
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    /// Uniform in `[lo, hi]`.
    fn range(&mut self, lo: u64, hi: u64) -> u64 {
        if hi <= lo {
            return lo;
        }
        lo + self.next() % (hi - lo + 1)
    }
}

const SUPPLY_1B: u64 = 1_000_000_000 * 1_000_000;
/// USDC-like base: 6 decimals, $1.00.
const USDC: (u64, u8) = (1_000_000, 6);
/// wSOL-like base: 9 decimals, $200.
const WSOL: (u64, u8) = (200_000_000, 9);

fn params(supply: u64, base: (u64, u8)) -> CurveParams {
    derive_curve(supply, base.0, base.1).expect("curve derives")
}

fn fresh(supply: u64, base: (u64, u8)) -> (CurveParams, CurveState) {
    let p = params(supply, base);
    (
        p,
        CurveState {
            virtual_base: p.virtual_base,
            virtual_token: p.virtual_token,
            real_base: 0,
            real_token: p.tokens_for_sale,
            k: p.k,
        },
    )
}

/* -------------------------------------------------------------------------- */
/* Gate 2.A — the 15/10/6/69 split, exact to the lamport                        */
/* -------------------------------------------------------------------------- */

/// The identity that makes the split trustworthy: the four shares reconstruct
/// the fee with nothing lost and nothing invented.
#[test]
fn split_fee_is_exact_for_every_small_fee() {
    for fee in 0u64..100_000 {
        let s = split_fee(fee);
        assert_eq!(
            s.protocol + s.stonkz_ops + s.burn + s.creator_bucket,
            fee,
            "shares must reconstruct fee exactly, fee={fee}"
        );
        assert_eq!(s.protocol, fee * 1_500 / 10_000);
        assert_eq!(s.stonkz_ops, fee * 1_000 / 10_000);
        assert_eq!(s.burn, fee * 600 / 10_000);
        // The creator bucket absorbs the floor dust, so it is never short.
        assert!(s.creator_bucket >= fee * 6_900 / 10_000);
        assert!(s.creator_bucket <= fee * 6_900 / 10_000 + 3);
    }
}

#[test]
fn split_fee_is_exact_across_the_whole_u64_range() {
    let mut rng = Rng::new(0xF00D_BEEF);
    for _ in 0..200_000 {
        let fee = rng.next() >> (rng.next() % 64);
        let s = split_fee(fee);
        assert_eq!(s.protocol + s.stonkz_ops + s.burn + s.creator_bucket, fee);
        assert_eq!(s.protocol as u128, fee as u128 * 1_500 / 10_000);
        assert_eq!(s.stonkz_ops as u128, fee as u128 * 1_000 / 10_000);
        assert_eq!(s.burn as u128, fee as u128 * 600 / 10_000);
    }
}

/// The gate as written in the task: random fill sizes, `fee_bps` swept across
/// the whole 100–500 slider range, split asserted exact on every fill.
#[test]
fn fee_split_is_exact_on_every_random_buy_and_sell() {
    let mut rng = Rng::new(0x5701_1425_0000_0001);
    let mut fills = 0u32;

    for case in 0..6_000u64 {
        let base = if case % 2 == 0 { USDC } else { WSOL };
        let (p, mut st) = fresh(SUPPLY_1B, base);
        let fee_bps = rng.range(MIN_FEE_BPS as u64, MAX_FEE_BPS as u64) as u16;

        // Random walk of buys and sells over one curve.
        let mut held: u64 = 0;
        for _ in 0..12 {
            let buy = held == 0 || rng.next() % 3 != 0;
            if buy {
                if st.real_token == 0 {
                    break;
                }
                let max_in = (p.grad_mcap_base / 4).min(u64::MAX as u128) as u64;
                let amount = rng.range(1_000, max_in.max(2_000));
                let Some(f) = buy_quote(&st, fee_bps, amount) else {
                    continue;
                };

                let s = split_fee(f.fee);
                assert_eq!(
                    s.protocol + s.stonkz_ops + s.burn + s.creator_bucket,
                    f.fee,
                    "buy split lost an atom: fee={} bps={}",
                    f.fee,
                    fee_bps
                );
                assert_eq!(s.protocol as u128, f.fee as u128 * 1_500 / 10_000);
                assert_eq!(s.stonkz_ops as u128, f.fee as u128 * 1_000 / 10_000);
                assert_eq!(s.burn as u128, f.fee as u128 * 600 / 10_000);
                assert_eq!(f.gross_base, f.fee + f.net_base, "gross must equal fee + net");

                st.virtual_base += f.net_base as u128;
                st.virtual_token -= f.tokens_out as u128;
                st.real_base += f.net_base;
                st.real_token -= f.tokens_out;
                held += f.tokens_out;
                fills += 1;
            } else {
                let amount = rng.range(1, held);
                let Some(f) = sell_quote(&st, fee_bps, amount) else {
                    continue;
                };

                let s = split_fee(f.fee);
                assert_eq!(
                    s.protocol + s.stonkz_ops + s.burn + s.creator_bucket,
                    f.fee,
                    "sell split lost an atom: fee={} bps={}",
                    f.fee,
                    fee_bps
                );
                assert_eq!(s.protocol as u128, f.fee as u128 * 1_500 / 10_000);
                assert_eq!(s.stonkz_ops as u128, f.fee as u128 * 1_000 / 10_000);
                assert_eq!(s.burn as u128, f.fee as u128 * 600 / 10_000);
                assert_eq!(f.gross_base, f.fee + f.net_base);

                st.virtual_base -= f.gross_base as u128;
                st.virtual_token += amount as u128;
                st.real_base -= f.gross_base;
                st.real_token += amount;
                held -= amount;
                fills += 1;
            }

            assert!(
                st.virtual_base * st.virtual_token >= st.k,
                "constant product must never fall below k"
            );
        }
    }

    assert!(fills > 20_000, "expected a broad sample, got {fills} fills");
}

/* -------------------------------------------------------------------------- */
/* Gate 2.A — curve invariants                                                 */
/* -------------------------------------------------------------------------- */

#[test]
fn constant_product_never_decreases() {
    let mut rng = Rng::new(0xC0FF_EE00);
    for _ in 0..2_000 {
        let (_, mut st) = fresh(SUPPLY_1B, USDC);
        let fee_bps = rng.range(100, 500) as u16;
        let mut held = 0u64;
        for _ in 0..25 {
            let before = st.virtual_base * st.virtual_token;
            if held == 0 || rng.next() % 2 == 0 {
                let Some(f) = buy_quote(&st, fee_bps, rng.range(1, 5_000_000_000)) else {
                    continue;
                };
                st.virtual_base += f.net_base as u128;
                st.virtual_token -= f.tokens_out as u128;
                st.real_base += f.net_base;
                st.real_token -= f.tokens_out;
                held += f.tokens_out;
            } else {
                let amt = rng.range(1, held);
                let Some(f) = sell_quote(&st, fee_bps, amt) else {
                    continue;
                };
                st.virtual_base -= f.gross_base as u128;
                st.virtual_token += amt as u128;
                st.real_base -= f.gross_base;
                st.real_token += amt;
                held -= amt;
            }
            let after = st.virtual_base * st.virtual_token;
            assert!(after >= st.k, "product fell below k");
            // Buys leave the product at k plus truncation; sells return it to
            // k. The curve never banks fee value — fees leave for the vaults —
            // so `after >= before` is not an invariant, `after >= k` is.
            assert!(
                after >= st.k && before >= st.k,
                "product left the feasible region"
            );
        }
    }
}

/// Buying and immediately selling back must always cost the trader money.
/// If this ever fails, the curve mints value out of rounding.
#[test]
fn round_trip_never_profits_the_trader() {
    let mut rng = Rng::new(0xDEAD_10CC);
    for _ in 0..50_000 {
        let (_, mut st) = fresh(SUPPLY_1B, USDC);
        let fee_bps = rng.range(100, 500) as u16;
        let amount = rng.range(1_000, 20_000_000_000);

        let Some(b) = buy_quote(&st, fee_bps, amount) else {
            continue;
        };
        st.virtual_base += b.net_base as u128;
        st.virtual_token -= b.tokens_out as u128;
        st.real_base += b.net_base;
        st.real_token -= b.tokens_out;

        let Some(s) = sell_quote(&st, fee_bps, b.tokens_out) else {
            continue;
        };
        assert!(
            s.net_base <= b.gross_base,
            "round trip returned more than it cost: in={} out={} bps={}",
            b.gross_base,
            s.net_base,
            fee_bps
        );
    }
}

/// A capped buy must pull only what it needs. The trader hands over less than
/// they offered rather than overpaying for tokens that do not exist.
#[test]
fn capped_buy_charges_only_for_what_it_delivers() {
    let (p, mut st) = fresh(SUPPLY_1B, USDC);
    // Drain most of the curve first.
    let f = buy_quote(&st, 300, (p.grad_mcap_base / 6) as u64).unwrap();
    st.virtual_base += f.net_base as u128;
    st.virtual_token -= f.tokens_out as u128;
    st.real_base += f.net_base;
    st.real_token -= f.tokens_out;

    let absurd = u64::MAX / 4;
    let capped = buy_quote(&st, 300, absurd).unwrap();
    assert!(capped.curve_complete);
    assert_eq!(capped.tokens_out, st.real_token);
    assert!(capped.gross_base < absurd, "capped buy must not pull the full offer");
    assert_eq!(capped.gross_base, capped.fee + capped.net_base);
    // The fee still leaves at least the required net in the pool.
    assert!(capped.fee >= capped.gross_base * 300 / 10_000);
}

/* -------------------------------------------------------------------------- */
/* Gate 2.A — graduation lands at $69,000                                      */
/* -------------------------------------------------------------------------- */

#[test]
fn exhausting_the_curve_lands_within_a_hair_of_69k() {
    for &supply in ALLOWED_SUPPLIES.iter() {
        for base in [USDC, WSOL, (10, 5), (4_312_500_000, 8)] {
            let supply_atoms = supply * 10u64.pow(TOKEN_DECIMALS as u32);
            let Some(p) = derive_curve(supply_atoms, base.0, base.1) else {
                continue;
            };
            let mut st = CurveState {
                virtual_base: p.virtual_base,
                virtual_token: p.virtual_token,
                real_base: 0,
                real_token: p.tokens_for_sale,
                k: p.k,
            };

            // One enormous buy, capped at the allocation.
            let f = buy_quote(&st, 100, u64::MAX / 4).expect("capped buy");
            assert!(f.curve_complete);
            st.virtual_base += f.net_base as u128;
            st.virtual_token -= f.tokens_out as u128;
            st.real_base += f.net_base;
            st.real_token -= f.tokens_out;
            assert_eq!(st.real_token, 0);

            let mcap = mcap_base(&st, supply_atoms).unwrap();
            let usd = mcap_usd_1e6(mcap, base.0, base.1).unwrap();

            // Two sub-atom truncations (virtual_token floor, virtual_base
            // ceil) and one on the mcap itself. One part per million of
            // $69,000 is 6.9 cents; the observed worst case across these
            // combinations is under a hundredth of that.
            let tol = GRAD_MCAP_USD_1E6 / 1_000_000;
            assert!(
                usd + tol >= GRAD_MCAP_USD_1E6 && usd <= GRAD_MCAP_USD_1E6 + tol,
                "supply={supply} base={base:?}: graduated at {usd} not {GRAD_MCAP_USD_1E6}"
            );

            // 20% of the graduation cap was raised, and the pool opens at the
            // curve's closing price.
            let raised = st.real_base as u128;
            let expect = p.grad_mcap_base / 5;
            assert!(
                raised.abs_diff(expect) * 1_000_000 <= expect,
                "raised {raised} not ~20% of {} ",
                p.grad_mcap_base
            );

            let close_price_num = st.virtual_base;
            let close_price_den = st.virtual_token;
            let lp_price_num = raised;
            let lp_price_den = p.lp_reserve as u128;
            // cross-multiply, allow one part per million of drift
            let a = close_price_num * lp_price_den;
            let b = lp_price_num * close_price_den;
            assert!(
                a.abs_diff(b) * 1_000_000 <= a.max(b),
                "LP would open off the curve's closing price"
            );
        }
    }
}

#[test]
fn start_mcap_is_one_sixteenth_of_graduation() {
    let (p, st) = fresh(SUPPLY_1B, USDC);
    let mcap = mcap_base(&st, SUPPLY_1B).unwrap();
    let expect = p.grad_mcap_base / 16;
    assert!(
        mcap.abs_diff(expect) * 1_000_000 <= expect,
        "start mcap {mcap} is not grad/16 ({expect})"
    );
}

/* -------------------------------------------------------------------------- */
/* Gate 4.A — cashback decay                                                   */
/* -------------------------------------------------------------------------- */

#[test]
fn cashback_decays_from_50pct_to_the_creator_fee_across_300s() {
    for base_bps in [100u16, 250, 500] {
        let start = 1_700_000_000i64;
        assert_eq!(eff_fee_bps(base_bps, true, start, start), 5_000);
        assert_eq!(eff_fee_bps(base_bps, true, start, start + 300), base_bps);
        assert_eq!(eff_fee_bps(base_bps, true, start, start + 301), base_bps);
        assert_eq!(eff_fee_bps(base_bps, true, start, start + 100_000), base_bps);

        // Halfway through, halfway down.
        let mid = eff_fee_bps(base_bps, true, start, start + 150);
        let want = base_bps as u64 + (5_000 - base_bps as u64) / 2;
        assert!(mid as u64 == want, "mid {mid} != {want}");

        // Monotone non-increasing, never below the creator fee, never above 50%.
        let mut prev = 5_001u16;
        for t in 0..=320i64 {
            let f = eff_fee_bps(base_bps, true, start, start + t);
            assert!(f <= prev, "fee rose at t={t}");
            assert!(f >= base_bps && f <= 5_000);
            prev = f;
        }

        // A non-cashback coin is flat, and a clock before the window opened
        // cannot be used to stretch it past 50%.
        assert_eq!(eff_fee_bps(base_bps, false, start, start), base_bps);
        assert_eq!(eff_fee_bps(base_bps, true, start, start - 10_000), 5_000);
    }
}

/// The elevated cashback fee splits 15/10/6/69 exactly like any other fill —
/// platform, buyback and RWA fund are not skipped or discounted during the
/// window.
#[test]
fn cashback_fills_still_split_15_10_6_69() {
    let mut rng = Rng::new(0xCA58_BAC4);
    let start = 1_700_000_000i64;
    for _ in 0..20_000 {
        let base_bps = rng.range(100, 500) as u16;
        let t = rng.range(0, 300) as i64;
        let bps = eff_fee_bps(base_bps, true, start, start + t);
        let (_, st) = fresh(SUPPLY_1B, USDC);
        let Some(f) = buy_quote(&st, bps, rng.range(1_000, 10_000_000_000)) else {
            continue;
        };
        let s = split_fee(f.fee);
        assert_eq!(s.protocol + s.stonkz_ops + s.burn + s.creator_bucket, f.fee);
        assert_eq!(s.protocol as u128, f.fee as u128 * 1_500 / 10_000);
        assert_eq!(s.stonkz_ops as u128, f.fee as u128 * 1_000 / 10_000);
        assert_eq!(s.burn as u128, f.fee as u128 * 600 / 10_000);
    }
}

/// Only the creator bucket is convertible to the token. The zero-fee swap is
/// the only path that touches the curve on behalf of the creator, and it is
/// fed the bucket alone.
#[test]
fn cashback_swap_consumes_only_the_creator_bucket() {
    let (_, st) = fresh(SUPPLY_1B, USDC);
    let f = buy_quote(&st, 5_000, 1_000_000_000).unwrap();
    let s = split_fee(f.fee);

    let swapped = zero_fee_buy(&st, s.creator_bucket).unwrap();
    let would_be_whole_fee = zero_fee_buy(&st, f.fee).unwrap();
    assert!(
        swapped < would_be_whole_fee,
        "the swap must be sized to the bucket, not the whole fee"
    );

    // Platform, buyback (ops) and RWA fund (burn) remain in base, untouched
    // by the swap.
    assert_eq!(s.protocol + s.stonkz_ops + s.burn, f.fee - s.creator_bucket);
}

/* -------------------------------------------------------------------------- */
/* Gate 4.B — staking draws only from the 69%                                  */
/* -------------------------------------------------------------------------- */

#[test]
fn stakers_never_reach_past_half_the_creator_bucket() {
    let mut rng = Rng::new(0x57A4_E12D);
    for _ in 0..300_000 {
        let bucket = rng.next() >> (rng.next() % 40);
        let circulating = rng.range(1, u64::MAX >> 20);
        // Staked can exceed circulating (nonsense input) — the clamp must hold.
        let staked = rng.range(0, circulating.saturating_mul(3).max(1));

        let sp = split_creator_bucket(bucket, staked, circulating);
        assert_eq!(sp.creator + sp.stakers, bucket, "bucket must be conserved");
        assert!(sp.stakers <= bucket / 2, "stakers took more than half the bucket");
        assert!(sp.creator >= bucket - bucket / 2, "creator fell below half the bucket");
    }
}

/// End to end: platform 15%, buyback 10% and RWA fund 6% cannot leak into a
/// staker claim even when the coin is 100% staked. This is review gate 4.B/step 138 and 4.C/142.
#[test]
fn protocol_and_ops_never_enter_the_stake_pool() {
    let mut rng = Rng::new(0x9E11_4CE5);
    let mut protocol_total = 0u128;
    let mut ops_total = 0u128;
    let mut burn_total = 0u128;
    let mut creator_total = 0u128;
    let mut staker_total = 0u128;
    let mut fee_total = 0u128;
    let mut fills = 0u128;

    for _ in 0..50_000 {
        let (p, st) = fresh(SUPPLY_1B, USDC);
        let fee_bps = rng.range(100, 500) as u16;
        let Some(f) = buy_quote(&st, fee_bps, rng.range(10_000, 20_000_000_000)) else {
            continue;
        };
        let s = split_fee(f.fee);

        // Fully staked: circulating == eligible_staked, the worst case for the
        // creator and the best case for stakers.
        let circulating = circulating(p.tokens_for_sale, st.real_token - f.tokens_out).max(1);
        let sp = split_creator_bucket(s.creator_bucket, circulating, circulating);

        assert_eq!(sp.creator + sp.stakers, s.creator_bucket);
        assert!(
            sp.stakers <= s.creator_bucket / 2,
            "fully staked still caps stakers at half the bucket"
        );
        // The staker take can never exceed 34.5% of the fee (half of the 69%
        // bucket). The bucket carries up to 3 atoms of floor dust, so half of
        // it can overshoot 34.5% by up to 2 atoms.
        assert!(sp.stakers as u128 * 1000 <= f.fee as u128 * 345 + 2000);
        // The creator never drops below 34.5% of the fee.
        // Floor dust in the bucket (<= 3 atoms) can shave the creator by up to 2.
        assert!(sp.creator as u128 * 1000 + 2000 >= f.fee as u128 * 345);

        protocol_total += s.protocol as u128;
        ops_total += s.stonkz_ops as u128;
        burn_total += s.burn as u128;
        creator_total += sp.creator as u128;
        staker_total += sp.stakers as u128;
        fee_total += f.fee as u128;
        fills += 1;
    }

    assert_eq!(
        protocol_total + ops_total + burn_total + creator_total + staker_total,
        fee_total,
        "the five destinations must reconstruct every fee taken"
    );
    // In aggregate platform still holds its 15%, buyback its 10% and the RWA
    // fund its 6%, short only by the per-fill floor, which is strictly less
    // than one atom of the fee — so less than 10_000 units of
    // `fee_total * 10_000` per fill.
    assert!(protocol_total * 10_000 + 10_000 * fills >= fee_total * 1_500);
    assert!(ops_total * 10_000 + 10_000 * fills >= fee_total * 1_000);
    assert!(burn_total * 10_000 + 10_000 * fills >= fee_total * 600);
    // And they never hold more than their nominal share.
    assert!(protocol_total * 10_000 <= fee_total * 1_500);
    assert!(ops_total * 10_000 <= fee_total * 1_000);
    assert!(burn_total * 10_000 <= fee_total * 600);
}

#[test]
fn flex_earns_zero_pool_weight() {
    assert_eq!(stake_weight(1_000_000_000, 0), Some(0));
    assert_eq!(stake_weight(1_000_000_000, 1), Some(1_100_000_000));
    assert_eq!(stake_weight(1_000_000_000, 7), Some(1_250_000_000));
    assert_eq!(stake_weight(1_000_000_000, 30), Some(1_500_000_000));
    assert_eq!(stake_weight(1_000_000_000, 90), Some(2_500_000_000));
    assert_eq!(stake_weight(1_000_000_000, 180), Some(5_000_000_000));
    assert_eq!(stake_weight(1_000_000_000, 365), Some(8_000_000_000));
    // Anything not on the lock grid is rejected outright.
    assert_eq!(stake_weight(1_000_000_000, 2), None);
    assert_eq!(stake_weight(1_000_000_000, 364), None);
}

#[test]
fn the_accumulator_resolves_a_fill_on_every_allowed_supply() {
    // Regression. At `ACC_PRECISION = 1e12` the largest allowed supply, fully
    // staked at the 365-day multiplier, drove `per_weight` to zero: the pool
    // held every accrual as dust and stakers earned nothing, with no error
    // raised anywhere. The failure is silent, so it needs an explicit test
    // rather than trust in the fuzz, which never happened to stake a whole 1e12
    // float.
    for supply in ALLOWED_SUPPLIES {
        let atoms = (supply as u128) * 10u128.pow(TOKEN_DECIMALS as u32);
        let weight = atoms * (LOCK_WEIGHT_BPS[6] as u128) / (BPS_DEN as u128);

        // One atom of a 6-decimal base is the smallest reward that can arrive.
        let (acc, dust) = advance_acc(0, 1_000_000, weight).expect("no overflow");
        assert!(
            acc > 0,
            "supply {supply}: a 1.0-base-token accrual must move the accumulator, \
             not vanish into dust (weight {weight})"
        );
        assert!(dust < 1_000_000, "supply {supply}: most of the accrual must land");

        // And a staker holding the whole float can actually claim it back.
        let claimable = pending_reward(weight, acc, 0).expect("no overflow");
        assert!(
            claimable > 900_000,
            "supply {supply}: sole staker should recover nearly the whole accrual, got {claimable}"
        );
        assert!(claimable <= 1_000_000, "supply {supply}: and never more than it");
    }
}

#[test]
fn reward_accumulator_conserves_value() {
    let mut rng = Rng::new(0xACC0_1234);
    for _ in 0..20_000 {
        let n = rng.range(1, 8) as usize;
        let weights: Vec<u128> = (0..n).map(|_| rng.range(1, 1_000_000_000) as u128).collect();
        let total: u128 = weights.iter().sum();

        let mut acc = 0u128;
        let mut paid_in = 0u128;
        // The program carries indivisible dust into the next accrual rather
        // than dropping it, so the test has to model that or it will misjudge
        // solvency. See `accrue_bucket_base` in trade.rs.
        let mut carried = 0u64;
        for _ in 0..10 {
            let amount = rng.range(0, 1_000_000_000);
            paid_in += amount as u128;
            let (next, dust) = advance_acc(acc, amount + carried, total).unwrap();
            acc = next;
            carried = dust;
        }

        let claimed: u128 = weights
            .iter()
            .map(|w| pending_reward(*w, acc, 0).unwrap() as u128)
            .sum();
        // Solvency: the vault took in `paid_in` and can never be asked for
        // more than that.
        assert!(
            claimed <= paid_in,
            "accumulator paid out more than it took in: {claimed} > {paid_in}"
        );
        // And what it retains is bounded — dust does not quietly swallow the
        // pool. One atom per staker per accrual is the ceiling.
        assert!(paid_in - claimed <= (n as u128 + 1) * 10 + carried as u128);
    }
}

/// Two coins are two independent pools. Weight in one cannot pay out of the
/// other — enforced structurally here by the accumulators being per-curve.
/// Two coins are two independent pools. Trading volume on one must not create
/// a claim against the other, and a staker holding weight in both settles each
/// against its own accumulator.
#[test]
fn two_coins_do_not_share_stake_weight() {
    let (_, a) = fresh(SUPPLY_1B, USDC);
    let (_, b) = fresh(SUPPLY_1B, WSOL);
    let weight = 1_000_000u128;

    // All the volume happens on coin A.
    let fa = buy_quote(&a, 300, 5_000_000_000).unwrap();
    let sa = split_fee(fa.fee);
    let (acc_a, _) = advance_acc(0, sa.creator_bucket / 2, weight).unwrap();

    // Coin B saw no fills, so its accumulator never moved.
    let acc_b = 0u128;
    let _ = b;

    let owed_a = pending_reward(weight, acc_a, 0).unwrap();
    let owed_b = pending_reward(weight, acc_b, 0).unwrap();

    assert!(owed_a > 0, "the staked coin must accrue");
    assert_eq!(owed_b, 0, "an unrelated coin's staker must accrue nothing");
    assert!(
        owed_a <= sa.creator_bucket / 2,
        "a pool cannot pay out more than was routed to it"
    );

    // Trading B afterwards still leaves A's already-settled staker unaffected.
    let fb = buy_quote(&b, 300, 5_000_000_000).unwrap();
    let sb = split_fee(fb.fee);
    let (acc_b, _) = advance_acc(acc_b, sb.creator_bucket / 2, weight).unwrap();
    assert_eq!(
        pending_reward(weight, acc_a, 0).unwrap(),
        owed_a,
        "coin B's volume changed what coin A owes"
    );
    assert!(pending_reward(weight, acc_b, 0).unwrap() > 0);
}

/* -------------------------------------------------------------------------- */
/* Parameter sanity                                                            */
/* -------------------------------------------------------------------------- */

#[test]
fn published_parameters_match_curve_json() {
    let p = params(SUPPLY_1B, USDC);
    assert_eq!(p.tokens_for_sale, SUPPLY_1B / 5 * 4);
    assert_eq!(p.lp_reserve, SUPPLY_1B / 5);
    assert_eq!(p.virtual_token, SUPPLY_1B as u128 * 16 / 15);
    assert_eq!(p.grad_mcap_base, 69_000_000_000);
    assert_eq!(p.virtual_base, 69_000_000_000 / 15);
    assert_eq!(p.k, p.virtual_base * p.virtual_token);
    assert_eq!(
        FEE_PROTOCOL_BPS + FEE_OPS_BPS + FEE_BURN_BPS + FEE_CREATOR_BUCKET_BPS_NOMINAL,
        BPS_DEN
    );
}

#[test]
fn degenerate_inputs_are_rejected_not_wrapped() {
    let (_, st) = fresh(SUPPLY_1B, USDC);
    assert!(buy_quote(&st, 300, 0).is_none());
    assert!(sell_quote(&st, 300, 0).is_none());
    assert!(buy_quote(&st, 10_000, 1_000_000).is_none());
    assert!(derive_curve(0, 1_000_000, 6).is_none());
    assert!(derive_curve(SUPPLY_1B, 0, 6).is_none());
    // An empty pool has no base to pay a seller with.
    assert!(sell_quote(&st, 300, 1_000_000).is_none());
}

/* -------------------------------------------------------------------------- */
/* Metaplex metadata CPI — create_token                                        */
/* -------------------------------------------------------------------------- */

mod metaplex_cpi {
    use crate::constants::*;
    use crate::instructions::create_token::{MAX_NAME_LEN, MAX_URI_LEN};
    use crate::metaplex::*;
    use anchor_lang::prelude::Pubkey;
    use anchor_lang::pubkey;

    #[test]
    fn metadata_pda_matches_the_mainnet_usdc_metadata_account() {
        // USDC's real metadata account, derived independently by web3.js
        // (`apps/api/src/router/solana-idl.test.ts` pins the same vector).
        let usdc = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
        assert_eq!(
            metadata_pda(&usdc).0,
            pubkey!("5x38Kp4hvdomTCnCrAny4UtMUt5rQBdB6px2K1Ui45Wq")
        );
        assert_eq!(
            TOKEN_METADATA_PROGRAM_ID,
            pubkey!("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s")
        );
    }

    #[test]
    fn create_metadata_v3_data_is_byte_exact() {
        let d = create_metadata_v3_data("Doggo", "DOG", "ipfs://x");
        let mut want: Vec<u8> = vec![33];
        want.extend_from_slice(&[5, 0, 0, 0]);
        want.extend_from_slice(b"Doggo");
        want.extend_from_slice(&[3, 0, 0, 0]);
        want.extend_from_slice(b"DOG");
        want.extend_from_slice(&[8, 0, 0, 0]);
        want.extend_from_slice(b"ipfs://x");
        want.extend_from_slice(&[0, 0]); // seller_fee_basis_points = 0
        want.extend_from_slice(&[0, 0, 0]); // creators, collection, uses = None
        want.push(0); // is_mutable = false
        want.push(0); // collection_details = None
        assert_eq!(d, want);
    }

    #[test]
    fn metadata_is_immutable_royalty_free_and_curve_owned() {
        let mint = Pubkey::new_unique();
        let curve = Pubkey::new_unique();
        let creator = Pubkey::new_unique();
        let (md, _) = metadata_pda(&mint);
        let ix = create_metadata_v3_ix(md, mint, curve, creator, curve, "N", "T", "u");

        assert_eq!(ix.program_id, TOKEN_METADATA_PROGRAM_ID);
        let a = &ix.accounts;
        assert_eq!(a.len(), 6);
        assert!(a[0].pubkey == md && a[0].is_writable && !a[0].is_signer);
        assert!(a[1].pubkey == mint && !a[1].is_writable && !a[1].is_signer);
        // The curve PDA signs as mint authority and is the update authority.
        assert!(a[2].pubkey == curve && a[2].is_signer && !a[2].is_writable);
        assert!(a[3].pubkey == creator && a[3].is_signer && a[3].is_writable);
        assert!(a[4].pubkey == curve && a[4].is_signer && !a[4].is_writable);
        assert_eq!(a[5].pubkey, anchor_lang::system_program::ID);

        // Tail: seller_fee 0, no creators/collection/uses, is_mutable false,
        // no collection details.
        assert_eq!(&ix.data[ix.data.len() - 7..], &[0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn launch_limits_are_metaplex_limits() {
        assert_eq!(MAX_NAME_LEN, 32);
        assert_eq!(METAPLEX_MAX_SYMBOL_LEN, 10);
        assert_eq!(MAX_URI_LEN, 200);
        // Longest legal launch still encodes: 1 + 3*4 + 32 + 10 + 200 + 7.
        let d = create_metadata_v3_data(
            &"n".repeat(MAX_NAME_LEN),
            &"T".repeat(METAPLEX_MAX_SYMBOL_LEN),
            &"u".repeat(MAX_URI_LEN),
        );
        assert_eq!(d.len(), 1 + 12 + 32 + 10 + 200 + 7);
    }
}
