# Stonkz on-chain spec (Phase 2.A + Phase 4.A/4.B/4.C)

Two implementations, one interface: `solana/` (Anchor) and `evm/` (Foundry).
`curve.json` is the machine-readable parameter artifact both programs and both
apps read. If any of the three disagree numerically, the chain wins and the
other two are the bug.

## 1. Why the CPMM parameters graduate at exactly $69,000

The curve is a constant product over **virtual** reserves, denominated in the
**base mint** — never in native SOL/ETH unless the base mint *is* native.

Let

- `S` = fixed supply in atoms
- `t` = fraction of `S` sellable on the curve
- `v` = initial virtual token reserves as a multiple of `S`
- `VB0` = initial virtual base reserves, `VT0 = v·S`, `k = VB0·VT0`

Selling the whole curve allocation `t·S` leaves `VT_f = (v−t)·S`, so

```
VB_f          = k / VT_f      = VB0 · v/(v−t)
price_f       = VB_f / VT_f   = VB0 · v / ((v−t)² · S)
mcap_f (base) = price_f · S   = VB0 · v / (v−t)²
raised (base) = VB_f − VB0    = VB0 · t/(v−t)
```

Two constraints pin `t` and `v`:

**(a) The LP must open at the curve's closing price.** Graduation moves
`raised` base and the `(1−t)·S` LP reserve into the pool, so the pool's opening
price is `raised / ((1−t)·S)`. Setting that equal to `price_f`:

```
t·(v − t) / v = 1 − t        ⟹        v = t² / (2t − 1)
```

**(b) `t` is chosen as 4/5.** 80% of supply sells on the curve, 20% is escrowed
for the pool. This is a product choice (round number, close to the ~79.3% the
market is used to). Constraint (a) then forces

```
v = (16/25) / (3/5) = 16/15
```

So the published parameters are exact rationals:

| Parameter                   | Value                 |
| --------------------------- | --------------------- |
| `tokens_for_sale`           | `4/5 · S`             |
| `lp_reserve`                | `1/5 · S`             |
| `virtual_token_reserves_0`  | `16/15 · S`           |
| `virtual_base_reserves_0`   | `grad_mcap_base / 15` |

Substituting back:

```
VT_f    = (16/15 − 12/15)·S = (4/15)·S
VB_f    = 4·VB0
price_f = 4·VB0 / ((4/15)·S) = 15·VB0 / S
mcap_f  = price_f · S = 15·VB0 = grad_mcap_base      ← by construction
raised  = 3·VB0 = grad_mcap_base / 5                 ← 20% of graduation mcap
```

Setting `VB0 = grad_mcap_base / 15` therefore makes the curve close **exactly**
at `grad_mcap_base`, and `grad_mcap_base` is the base-atom value of $69,000 read
from the oracle at `create_token`. Consequences worth knowing:

- **Price multiple to graduation is exactly 16×.** Start mcap is
  `grad_mcap_base/16` = **$4,312.50**; graduation is $69,000.
- **Base raised is exactly 20% of graduation mcap** = **$13,800**.
- **No gap at graduation.** The pool opens at the same price the curve closed
  at, by constraint (a).

### Integer exactness

`VT0 = floor(16·S/15)` is not an exact integer for the four allowed supplies, so
the program floors it. The truncation is at most `14/15` of one atom against a
`VT0` of order `10^15`–`10^18`, i.e. a relative error below `1e-15`. Graduation
mcap is off by well under a millionth of a cent. `tokens_for_sale = 4/5·S` and
`lp_reserve = 1/5·S` *are* exact for all four allowed supplies (all divisible by
5), so no supply is ever stranded.

`k = VB0 · VT0` is held in `u128`. Worst realistic case (1e12 supply, 5-decimal
base at $1e-5) is ~`5e31`, four orders of magnitude below the `u128` ceiling.
`create_token` still asserts the bound explicitly.

### Rounding direction

Every rounding is **toward the pool**, never toward the trader:

| Quantity                | Rounding                                 |
| ----------------------- | ---------------------------------------- |
| buy: new virtual token  | `ceil(k / (VB + net))` → tokens out floor |
| sell: new virtual base  | `ceil(k / (VT + amt))` → base out floor   |
| fee on gross            | floor                                    |

So `VB · VT ≥ k` holds after every fill; the invariant test asserts it.

## 2. Fee split — settled on-chain, exact to the lamport

On every curve fill, on the **base** amount:

```
fee            = floor(gross_base · eff_fee_bps / 10_000)
protocol       = floor(fee · 2_000 / 10_000)      → protocol_revenue vault
stonkz_ops     = floor(fee · 1_000 / 10_000)      → stonkz_ops vault
creator_bucket = fee − protocol − stonkz_ops      → creator bucket vault
```

`protocol + stonkz_ops + creator_bucket == fee` **exactly, always** — the
creator bucket is defined as the remainder, so the ≤2 atoms of floor dust land
there. Dust never accumulates in the program and is never lost.

The client never computes this for settlement. `packages/shared`'s `splitFee`
is the float mirror used for previews only.

### The staker peel lives *inside* the 70%

Phase 4.B is an additive split of the creator bucket, applied after the 20/10
have already been moved to their own vaults:

```
circulating = tokens_for_sale − real_token_reserves        (tokens actually sold)
stakers     = floor(creator_bucket · eligible_staked / (2 · circulating))
              clamped to floor(creator_bucket / 2)
creator     = creator_bucket − stakers
```

`eligible_staked / (2·circulating)` is `poolFrac` from `packages/shared`
(`0.5 × staked/circulating`), and the clamp is the `min(0.5, …)` in
`creatorVsStakers`. Fully staked ⟹ stakers take 35% of the curve fee and the
creator floors at 35%. Protocol 20% and ops 10% are already in different
accounts by the time this runs and are structurally unable to enter the stake
pool.

**`eligible_staked` excludes FLEX.** A 0-day position is escrow only: it earns
zero pool weight (anti-wash, plan step 134) and is also excluded from the
`poolFrac` numerator, so it cannot dilute the pool it does not participate in.

## 3. Cashback (Phase 4.A)

For 300 seconds after a cashback launch:

```
eff_fee_bps = base_bps + floor((5_000 − base_bps) · remaining_secs / 300)
```

decaying from 5000 bps (50%) to the creator's own `fee_bps`. `cb_start` is set
once, by the program, from `Clock` at `create_token`; there is no instruction
that can move it, so no client can extend the window.

The 20/10/70 split runs **first and unchanged** — protocol and ops always stay
in the base mint. Only the 70% creator bucket is then swapped, through the same
curve at **zero fee**, into the launched token and credited to the creator (and,
if a stake pool exists, split by the same `poolFrac` on the token side).

The swap runs on **buys only**. Sells inside the window pay the same elevated
fee, but their creator bucket accrues in base — swapping base into the token on
a sell would be a hidden buy pressure the seller did not ask for.

If the remaining curve reserve cannot cover the cashback swap, the bucket falls
back to accruing in base. It never partially fills.

## 4. Treasuries (Phase 4.C)

`protocol_revenue` and `stonkz_ops` are one vault per (treasury, base mint),
owned by the `global` PDA. There is **no user-facing claim path to either**;
`claim_creator_fees` can only touch the creator bucket vault.

Withdrawals are gated on `global.protocol_withdraw_authority` and
`global.ops_withdraw_authority`, which are separate keys from `global.admin` and
are documented to be multisig/cold. The API server holds none of the three.

`ops_withdrawals_paused` is the runbook switch from plan step 141: it stops
funds leaving the ops vault while **trading continues** and accrual continues.
Halting accrual is deliberately *not* offered — diverting the 10% mid-flight
would put protocol and ops money in one account and break the 4.C review gate.

No `$STONKZ` buy / LP / burn logic exists anywhere in these programs. That is
Phase 7 and the token does not exist.

## 5. Graduation

`graduate` is permissionless and accepts either trigger:

1. **`curve_complete`** — the 80% allocation is exhausted. Needs no oracle. By
   §1 this is exactly $69,000 at the price recorded at creation.
2. **`oracle_price`** — a *fresh* oracle read puts the USD mcap at or above
   $69,000 while curve tokens remain (i.e. the base appreciated). Requires
   `now − publish_time ≤ global.max_oracle_staleness` and a confidence band
   within tolerance. Unsold curve tokens are **burned**, which preserves
   "LP opens at the closing price" and can only raise the floor.

If the oracle is stale, trigger 2 is unavailable and trigger 1 still works, so
staleness can never wedge a token — it can only delay an early graduation.

Migration moves `real_base` + `lp_reserve` into the pool, and the LP position is
burned. See §7 for what "burn the LP" means on each chain.

## 6. Solana specifics

- Launched mints are SPL Token with 6 decimals. Supply is minted once, in full,
  at `create_token`; mint authority and freeze authority are then set to `None`.
- Base mints may be SPL Token or Token-2022 (`TokenInterface`, `transfer_checked`).
- `min_out` is enforced on the **curve hop only** — `tokens_out ≥ min_out` on
  buy, `base_out_after_fee ≥ min_out` on sell. The aggregator hop carries its
  own slippage bound. This keeps the instruction safely composable inside a
  larger atomic transaction built by the router agent.
- The oracle is a program-owned `BaseOracle` account written by
  `global.oracle_authority`. **Assumption:** in production that authority is a
  Pyth/Switchboard crank or a dedicated pusher, never the API process. Swapping
  in a direct Pyth account read is a localized change to `oracle.rs`.

## 7. EVM specifics and Robinhood Chain assumptions

See `evm/ASSUMPTIONS.md`. Every unconfirmed Robinhood Chain fact is isolated in
config so it can be corrected without touching curve or fee code.
