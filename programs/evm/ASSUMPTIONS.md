# programs/evm — assumptions, divergences, and what to re-verify

The EVM tree is a second implementation of the interface in [`../SPEC.md`], not
a port of the Anchor program. Where the two chains differ, this file says so and
says why. Where a decision rests on a fact about Robinhood Chain, it cites
[`docs/robinhood-chain.md`](../../docs/robinhood-chain.md) rather than restating
it, because that document carries the sources and the confidence levels.

Nothing here is a preference. Every divergence below is forced by a difference
between the two machines.

---

## 1. Divergences from the Anchor program

### 1.1 The launched token is 18 decimals, not 6

Solana launches 6-decimal SPL mints. This tree launches 18-decimal ERC-20s,
because 18 is what every EVM tool, wallet and DEX assumes and because Robinhood
Chain's own stock tokens are 18.

This changes no arithmetic. Both programs derive the curve from `supplyAtoms`,
and every formula in `SPEC.md` is expressed in atoms. It does change one
constant — see §1.2 — and it means a `supply` of `1_000_000_000` produces
`1e27` atoms here against `1e15` on Solana.

### 1.2 `ACC_PRECISION` is `1e36` here and `1e18` on Solana

**This is the only constant the two chains are allowed to disagree on**, and it
is worth understanding why, because getting it wrong fails silently.

The staking accumulator divides a reward denominated in the *base* token by a
weight denominated in the *launched* token. The right scale therefore depends on
the gap between two unrelated magnitudes, and that gap is twelve orders wider
here than on Solana purely because of §1.1.

Both trees originally used `1e12`. That is wrong on both:

| | float weight, fully staked at 365d | `reward · 1e12 / weight` for a $1 accrual |
|---|---|---|
| Solana, 1e9 supply | 8e15 | 125 — about 1% quantisation per accrual |
| Solana, 1e12 supply | 8e18 | **0** |
| EVM, 1e9 supply | 8e27 | **0** |

A zero means the accumulator does not move, the pool holds the accrual as dust,
and stakers earn nothing. Nothing reverts and nothing logs. It presents as
"staking is broken" with no error anywhere to explain it.

Both trees now carry a regression test over the whole allowed-supply set
(`the_accumulator_resolves_a_fill_on_every_allowed_supply` in Rust,
`testFuzz_AStakerAlwaysResolvesAFill` in Solidity). Neither existing fuzz caught
it, because neither happened to stake an entire 1e12 float.

Headroom, since these numbers look alarming: the products are bounded by
`totalRewards · ACC_PRECISION` regardless of weight, which peaks near 1.8e37
against `u128`'s 3.4e38 on Solana and near 1e66 against `uint256`'s 1.15e77
here.

### 1.3 The EVM is strictly more permissive on base-token decimals

Solana's `create_token` rejects any (supply, price, decimals) combination whose
graduated base reserve would not fit a `u64`, which in practice rules out
cheap 18-decimal bases. Every amount here is a `uint256`, so no such rejection
exists and an 18-decimal base like WETH is ordinary. `CurveMath` is otherwise
identical, and `Parity.t.sol` holds it to the vectors generated from the Rust
implementation.

### 1.4 Per-coin PDA vaults become internal ledgers

Solana gives each coin its own program-derived vault accounts. Solidity has one
contract balance, so the separation is enforced by bookkeeping instead: the
protocol treasury, the ops treasury, the creator's claimable balance and the
stake pool are four independent ledgers, and no function lets one draw on
another. `test_TreasuriesHaveNoUserFacingClaimPath` and
`test_ClaimDrainsOnlyTheCreatorLedger` are the assertions that keep that true.

### 1.5 The oracle is a source contract, not a program account

Solana carries a program-owned `BaseOracle` written by an `oracle_authority`.
Here the launchpad reads an `IPriceSource`, and the deployed implementation on
Robinhood Chain is `ChainlinkPriceSource` — Chainlink is the only oracle on
chain 4663 and Pyth is not present. `PushPriceSource` mirrors the Solana shape
and is what the test suite drives, so the suite does not depend on a forked
mainnet aggregator.

---

## 2. Robinhood Chain facts this tree is built on

Each of these changed the code. All are sourced in `docs/robinhood-chain.md`.

### 2.1 Time is `block.timestamp`, everywhere, without exception

`block.number` on this chain returns an estimate of the **L1** height, not L2
(§5.1). A 300-second cashback window denominated in blocks would run for hours;
a 30-day stake lock would run for years. `block.number` appears nowhere in this
tree, and the Foundry lint for `block.timestamp` is disabled in `foundry.toml`
with that reasoning — there is also no proposer to manipulate it, since ordering
is first-come-first-served on a single sequencer.

### 2.2 The oracle staleness bound is 90,000 seconds, not 3,600

The ETH/USD feed (`0x78F3556b…d3A9`) has a heartbeat of **86,400 seconds** and
publishes 8 decimals (§8). A conventional one-hour guard would read a healthy
feed as stale roughly 23 hours in every 24 and make oracle-triggered graduation
unreachable — §4.4 names this the single most likely way to ship a graduation
function that can never fire. The default is `86400 + 3600`, and the effective
bound is the tighter of ours and the feed's own, because equity feeds update
24/5 and one global number is wrong for one of them.

The consequence is accepted rather than hidden: the $69K threshold is fuzzy at
the margin. It is a trigger, not a settlement price. Nothing is *priced* off the
oracle — fills are priced off the curve.

### 2.3 There is no L2 Sequencer Uptime Feed for chain 4663

Chainlink's documented L2 practice is unavailable here (§8, row 42). What stands
in for it: the heartbeat-aware bound, an `answeredInRound < roundId` check, a
per-feed sanity band, and a `try/catch` so an aggregator that reverts reads as
"no answer" rather than taking the launchpad down with it.

### 2.4 A stale oracle must never block a trade

`buy` and `sell` do not read the oracle at all. `createToken` refuses a stale
price, and `graduate` defers on one. This is why `IPriceSource` returns a zero
price instead of reverting: each call site needs a different answer to "the
oracle is down", and a design where a Chainlink hiccup reverts fills turns an
oracle outage into a launchpad outage (§4.4, point 6).

`oracleGraduationPaused` stops the price trigger only. An exhausted curve reads
no oracle and graduates regardless, so the pause cannot strand a finished coin.

### 2.5 Graduation is a Uniswap v2 pool with the LP genuinely burned

The plan's original wording was "burn the LP **and** keep the fee-claim
authority". Those two clauses are mutually exclusive on v2 and this tree does
not attempt them (§4.2): a v2 pool has no `collect`, fees accrue into reserves,
and the LP token *is* the fee claim — burning it forfeits every past and future
fee at the same instant it locks the principal. Burning a v3/v4 position NFT
would be worse, since only the owner or an approved operator can collect at all.

We take the burn and give up the fees, because:

- Nobody is promised them. After graduation the curve fee stops and remaining
  venue fees are the DEX's.
- "The liquidity is gone" becomes verifiable by anyone with a block explorer,
  trusting no Stonkz contract. For a launchpad that is a product asset.
- Burned v2 LP autocompounds by construction — fees accrue into reserves that
  no surviving token can withdraw — with no locker, no keeper and no upgrade
  surface in a one-way migration of real user funds.

**`$STONKZ` protocol-owned liquidity in Phase 7 has the opposite requirement**
and will need a v3/v4 position in an immutable locker, not a burn. That is
deliberately absent from this tree: Phase 7 is out of scope and the token does
not exist. No buy, LP or burn logic for `$STONKZ` is implemented anywhere here.

### 2.6 The migrator refuses a manipulated pool

A v2 pair address is deterministic from the token pair, so anyone can create and
seed it ahead of the graduation transaction (§4.4, point 2). `mint` prices a
deposit off existing reserves and silently keeps the excess of the over-supplied
side, so migrating into a manipulated pair hands the curve's raise to whoever
seeded it. `UniswapV2Migrator` reverts if the pair's reserve ratio is more than
1% from the ratio being deposited. An empty pre-created pair is fine — we set
the price — as is a pair already at our price, which is what a retry looks like.

### 2.7 `buy` and `sell` take the base mint only

Kept deliberately narrow so `StonkzRouter` can compose a Uniswap leg in front of
them in one transaction (§2.8). `minOut` is enforced on the curve hop alone; the
router carries its own bound on its own leg. The launched token also implements
EIP-2612 `permit`, so the sell path stays a single signature instead of an
approve-then-swap pair that strands a user who signs only the first.

### 2.8 `StonkzRouter` judges the aggregator hop on its outcome, not its calldata

The Universal Router commands are built off-chain and arrive as opaque bytes.
The router does not parse them: a decoder is a second implementation of
Uniswap's encoding and would rot the first time they add a command. It pins the
Universal Router address at construction and checks the balance actually
delivered against the `quotedOut` the caller declares, within a tolerance capped
at 500 bps. An arbitrary payload can therefore do nothing useful, because one
that fails to deliver the quote reverts the transaction.

That single check also carries the "zero platform fee on the aggregator hop"
invariant. Uniswap's `portionBips` service fee is taken from the output token,
so a fee smuggled into calldata the API did not build presents as
delivered-below-quoted. It is a bound rather than a detector — a fee inside the
declared tolerance is, by definition, tolerated — so the API's own `portionBips`
assertion stays worth keeping. Two checks measuring the same quantity in the
same contract would be theatre; one check plus an off-chain assertion at a
different layer is not.

The recipient encoding is the one thing the caller must get right, and
`docs/robinhood-chain.md` §3.3 gets it wrong: it names `ADDRESS_THIS`, which is
the Universal Router itself, where output would sit in an ownerless contract for
anyone to sweep. `MSG_SENDER` is correct, since this contract is the one calling
`execute`. Both mis-encodings are pinned as tests, and the balance check turns
either into a revert rather than a loss.

The router has no owner, pause, upgrade path or rescue function. It holds no
balance between transactions — every path forwards the output and sweeps the
residue — so there is nothing to rescue, and an admin key on a contract sitting
in the middle of a trade is a liability rather than a safety net.

Not implemented here, and correctly so: Universal Router command encoding, and
anything that reads the Trading API. Both belong to `apps/api`; see
`docs/rh-trade-atomicity-gap.md` for what it must send.

---

## 3. Deliberately not implemented

- **`$STONKZ` buy / LP / burn.** Phase 7.
- **Universal Router command encoding.** `StonkzRouter` consumes it but does
  not build it; that is `apps/api`'s job.
- **A v3/v4 immutable locker.** Needed for POL, not for memecoin graduation.
- **Native-ETH curves.** Every curve here is against an ERC-20 base. A native
  path needs WETH wrapping or a payable variant; the base allow-list starts at
  WETH and USDG.

---

## 4. Re-verify before mainnet

The chain is young and several facts below are single-sourced. `docs/robinhood-chain.md`
§12 carries the full list; these are the ones that would break *this tree*:

- [ ] Re-read every address in `src/config/RobinhoodChain.sol` on Blockscout.
      Uniswap's own docs warn against assuming cross-chain address parity, and
      `@uniswap/sdk-core` does not carry chain 4663 at all.
- [ ] Re-read the ETH/USD feed address, decimals and heartbeat from Chainlink's
      canonical directory, and set `maxAgeSecs` per feed from what it says
      rather than from the constant in this repo.
- [ ] Confirm Uniswap v2 is deployed on **testnet 46630**; third-party testnet
      addresses do not match the mainnet set, so the migration integration test
      may need a mainnet fork instead.
- [ ] Decide whether stock-token bases ship at all in v1. They are tokenised
      debt securities barred from US persons; that is a jurisdiction gate and a
      legal question, not an engineering one (§7.5).
- [ ] Confirm the base token can be paused or can block an address mid-transfer
      (a single registry transaction freezes every stock token on the chain) and
      that the UI surfaces it as a first-class state rather than an unexplained
      revert (§7.3).
