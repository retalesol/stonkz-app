# Robinhood Chain trade atomicity — closed by `StonkzRouter`

**Status: closed, on both the contract and API sides, for every base asset an
operator has configured.** `programs/evm/src/StonkzRouter.sol` makes a
native-in trade genuinely atomic in one signature, and `apps/api`'s
`POST /trade/prepare` now calls it: `router/universal-router.ts` builds the
Universal Router `execute()` commands itself, `router/evm-router.ts` composes
the `buyViaAggregator`/`sellViaAggregator` call, and `routes/trade.ts` prefers
that path and returns `atomic: true`.

**What "for every base asset an operator has configured" means in practice —
the two remaining reasons a trade still gets the non-atomic `EvmStep[]`
fallback below, both operator-config gaps rather than per-trade ones:**

1. **No `StonkzRouter` deployment recorded.** `ApiEnv.rhRouterAddress`
   defaults to the zero-address placeholder (same posture as
   `rhLaunchpadAddress`), and `stonkzRouterDecision` treats that as "use the
   fallback". Set `RH_ROUTER_ADDRESS` once the contract is deployed.
2. **An aggregator-hop base asset with no pinned Uniswap v3 fee tier.** The
   direct-pair case (base = WETH) needs no pool at all — see below — but
   trading against any other base asset needs to know *which* v3 pool to
   route through, and `docs/robinhood-chain.md` row 43's "~1,900 hookless v4
   pools carry 88-100% LP fees" warning is exactly why that pool is an
   explicit human-pinned allow-list (`ApiEnv.rhV3FeeTierOverrides`,
   `RH_V3_FEE_TIER_OVERRIDES` env var), never a guessed or probed default.
   Deliberately empty out of the box, same posture as `router/base-mints.ts`'s
   sparse RH entries.

The `EvmStep[]` fallback (`router/evm-tx.ts`) is kept, unchanged, for exactly
those two gaps — it is not deleted, because refusing the trade outright until
every base asset has a pinned pool would be worse than the documented
non-atomic sequence. Its own header now says this explicitly.

## The gap, as it stood

Uniswap Trading API calldata targets the Universal Router with the caller's own
EOA as the swap recipient. Handing that calldata to the wallet as "step 1 of 2"
ends with the base token sitting in the user's wallet, not in a contract that
can then call `StonkzLaunchpad.buy`. A trader who stops signing partway is left
holding whatever the last completed step produced — wrapped ETH, an
approved-but-unspent balance, or the launched token with no ETH received — and
not their original ETH.

`POST /trade/prepare` on `net=RH` therefore returns a documented sequence of
separate transactions (`router/evm-tx.ts`'s `EvmTradePlan`), every response
carrying `atomic: false` and a `warning` string spelling out that consequence:

| Side | Base = WETH | Base = anything else |
|---|---|---|
| Buy | `WETH.deposit` → `approve` → `buy` | Uniswap swap (recipient = trader) → `approve` → `buy` |
| Sell | `approve` → `sell` → `WETH.withdraw` | `approve` → `sell` → Uniswap swap (recipient = trader) |

This was a usable placeholder, not a fix, and it should not be presented to
users trading real funds as if it were safe in the way the plan's "one atomic
tx" requirement means.

## What closes it

`StonkzRouter` makes **itself** the swap recipient, measures what actually
arrived, and calls the curve in the same transaction. Any leg reverting reverts
all of them. It holds no balance between transactions and has no owner, pause,
upgrade path or sweep function.

### Public interface

```solidity
constructor(IUniversalRouter universalRouter, StonkzLaunchpad launchpad)

struct AggregatorLeg {
    bytes    commands;        // Universal Router command bytes
    bytes[]  inputs;          // one blob per command
    uint256  deadline;        // passed through to the Universal Router
    uint256  amountIn;        // exact base handed to the router (sell only)
    uint256  quotedOut;       // what the aggregator said this leg delivers
    uint256  maxSlippageBps;  // tolerance, capped at MAX_SLIPPAGE_BPS = 500
}

struct PermitData { uint256 value; uint256 deadline; uint8 v; bytes32 r; bytes32 s; }
// deadline == 0 means "no permit, use an existing allowance"

function buyViaAggregator(
    address token,
    AggregatorLeg calldata leg,
    uint256 minTokenOut,
    uint256 deadline
) external payable returns (uint256 tokensOut);

function sellViaAggregator(
    address token,
    uint256 amountToken,
    PermitData calldata permitData,
    uint256 minBaseOut,
    AggregatorLeg calldata leg,
    uint256 minEthOut,
    uint256 deadline
) external returns (uint256 ethOut);

function shortfallFloor(uint256 quotedOut, uint256 maxSlippageBps) external pure returns (uint256);
```

Buy: ETH in with the call → Universal Router swaps it to the coin's base token
with the router as recipient → the whole delivered amount is spent on
`StonkzLaunchpad.buy` → launched tokens to the caller, unspent ETH swept back.

Sell: launched token pulled from the caller (via `permit`, so no prior approval
transaction) → `StonkzLaunchpad.sell` → exactly `leg.amountIn` base handed to
the Universal Router → ETH to the caller. Any base the curve returned above
`leg.amountIn` is refunded to the seller, so a favourable fill between quote and
inclusion belongs to them rather than to the router.

## How the API side does it

**1. The recipient is `MSG_SENDER`, not `ADDRESS_THIS` — pinned by a regression
test, not just by memory.**

An earlier revision of this file and of `docs/robinhood-chain.md` §3.3 both
named `ADDRESS_THIS`, which was wrong; both have been corrected. The Universal
Router's sentinels are `MSG_SENDER = address(1)` — whoever called `execute`,
which is `StonkzRouter` — and `ADDRESS_THIS = address(2)`, which is **the
Universal Router itself**. `router/universal-router.ts` uses `MSG_SENDER` on
every command whose output must land back in `StonkzRouter`, and `ADDRESS_THIS`
only for an intermediate hop inside a multi-command sequence that the same
`execute` call keeps spending from (the `WRAP_ETH` step of an aggregator-hop
buy, and the `V3_SWAP_EXACT_IN` step of an aggregator-hop sell).
`router/universal-router.test.ts` decodes every input blob this module builds
and asserts the recipient is always one of the two sentinels, and that the
*final* leg of both the direct-pair and aggregator-hop paths is `MSG_SENDER`
specifically — the same mis-encoding `programs/evm/test/Router.t.sol` pins on
the contract side.

**2. The command bytes are built directly, never forwarded from `/v1/swap`
calldata.** The Trading API's `/v1/quote` is used for pricing only
(`router/uniswap.ts`); `router/universal-router.ts` encodes
`execute(commands, inputs, deadline)` itself:

- **Direct pair (base = WETH):** a single `WRAP_ETH` (buy) or `UNWRAP_WETH`
  (sell). No v3 pool is involved at all — the only job is turning the
  `msg.value` `StonkzRouter` just received into spendable WETH, or the curve's
  WETH proceeds back into ETH.
- **Aggregator hop:** `WRAP_ETH` → `V3_SWAP_EXACT_IN` (buy), or
  `V3_SWAP_EXACT_IN` → `UNWRAP_WETH` (sell), against the one v3 pool pinned in
  `ApiEnv.rhV3FeeTierOverrides` for that base asset. `payerIsUser = false` on
  every router-paid leg, so the Universal Router spends from its own balance
  rather than trying to pull from whoever signed the outer transaction.

  **One nuance `programs/evm/test/Router.t.sol`'s own mock does not exercise:**
  that suite's `MockUniversalRouter` lets a single `V3_SWAP_EXACT_IN` command
  accept `msg.value` directly, as a test simplification — the real Universal
  Router's v3 module always settles from an ERC-20 balance (v3 pools do not
  hold native ETH), confirmed by reading Uniswap's `Payments.pay()`: a
  non-ETH-sentinel token paid from `address(this)`'s own balance is moved with
  a plain `transfer`, nothing wraps it implicitly. A real aggregator-hop trade
  therefore needs the two-command sequence above, not the mock's one-command
  shortcut. `router/universal-router.test.ts` is the correctness backstop for
  this until a fork test or an upgraded mock exercises it at the contract
  layer too — flagged here rather than silently assumed correct.

**3. The aggregator's quote is passed through as `quotedOut`**, independently
of the curve's own floor — see point 4 — so the "zero platform fee on the
aggregator hop" invariant is enforced on-chain (`AggregatorShortfall`) and not
only by the API's `portionBips` assertion. `maxSlippageBps` is the caller's
`Settings.slip`, clamped to the contract's `MAX_SLIPPAGE_BPS` ceiling (500) so
a wide slippage setting produces a working, bounded call instead of a
guaranteed `SlippageTooWide` revert — clamping only *tightens* the on-chain
tolerance relative to what the trader asked for, never widens it. On the
direct-pair path (an exact 1:1 wrap/unwrap) `maxSlippageBps` is `0`: there is
no market risk to tolerate.

**4. The two minimums are kept independent**, per side:

- **Buy:** `minTokenOut` (the curve floor) vs. `leg.quotedOut` (the aggregator
  floor) — already distinct in `composeCurveTrade`'s existing
  `curveMinOutAtoms`, no new field needed.
- **Sell:** this is the one place `composeCurveTrade`'s pre-existing
  `curveMinOutAtoms` was computed in the *wrong* terms for this purpose — it
  floors the trade's **final native output** (post-aggregator-conversion),
  which is right for `minEthOut` but was the only number available for what
  should have been a **base-terms** floor on the curve leg alone. Two new
  `CurveTradeComposition` fields fix this without touching what the
  already-shipped Solana sell instruction reads: `curveNetBaseOutAtoms`
  (`fill.netBase`, feeding `AggregatorLeg.amountIn`) and
  `curveMinBaseOutAtoms` (`applySlippageFloor(fill.netBase, slippagePct)`,
  feeding `minBaseOut`). A bad fill on the curve leg can no longer hide inside
  the aggregator leg's tolerance, or vice versa.

**5. Sells default to no approval transaction being required at signing time**,
but nothing in this repo signs an EIP-2612 permit yet. `POST /trade/prepare`
accepts an optional `permit: { value, deadline, v, r, s }` in the request body
for a sell; if present it is embedded in `PermitData` verbatim. If absent, the
response takes the standing-allowance branch (`PermitData.deadline == 0`) and
additionally returns `permitTypedData` — ready-to-sign EIP-712 typed data
against `StonkzToken`'s own domain (`name` = the token's name, `version =
"1"`, matching `StonkzToken.sol` exactly) — plus a `note` explaining the caller
must either sign that and resend it as `permit`, or have already approved the
router on that token. **Nothing calls this yet**: `apps/web`'s trade-box wiring
(Phase 2.C) has not landed (confirmed by grep, not assumed — see "Frontend
impact" below), so this is forward-compatible plumbing, not a live UX path.

**6. Deployment.** Unchanged from the contract's own design: the Universal
Router and launchpad addresses are immutable, set at construction. The API
only needs `RH_ROUTER_ADDRESS` (the deployment) and, per aggregator-hop base
asset, one `RH_V3_FEE_TIER_OVERRIDES` entry.

## Frontend impact

None, as of this round. `apps/web` has no consumer of `POST /trade/prepare`
yet — grepped for `trade/prepare`, `tradePrepare`, and `EvmStep` across
`apps/web/src` and found only forward-looking doc comments in
`apps/web/src/app/session.ts` and `apps/web/src/modals/steps.ts`, no actual
`fetch` call. Whichever round wires up the trade box (Phase 2.C) needs to know
the RH atomic response shape changed from `{ atomic: false, steps: EvmStep[],
warning }` to `{ atomic: true, to, data, value }` — the same `to`/`data`/`value`
shape `POST /launch/prepare`'s RH branch already returns — for every base asset
that reaches the `StonkzRouter` path, with the ordered-step walker in
`modals/steps.ts` only needed for whatever still falls through to the
fallback.

## Tests

**Contract side** — `programs/evm/test/Router.t.sol`, 20 passing. Covers the
atomic buy and sell happy paths against a mock with the real
`execute(bytes,bytes[],uint256)` shape and real `V3_SWAP_EXACT_IN` input
encoding; a curve failure unwinding the aggregator swap; an aggregator failure
never reaching the curve; permit-based sell with no prior approval and no
signature replay; the fee-smuggling revert and the in-tolerance case; both
recipient mis-encodings; and that the router holds nothing and exposes no
admin surface. One test is a real fork check, skipped unless `RH_RPC_URL` is
set:

```
RH_RPC_URL=<robinhood chain rpc> forge test --match-test Fork
```

It asserts the pinned Universal Router and Permit2 addresses hold code on chain
4663 — the verification `docs/robinhood-chain.md` §12 asks for before mainnet,
and the one thing a mock cannot establish.

**API side** — `apps/api/src/router/universal-router.test.ts` (7 tests) and
`apps/api/src/router/evm-router.test.ts` (12 tests), both pure unit tests with
no HTTP layer: pin `MSG_SENDER` vs `ADDRESS_THIS` on every command this module
builds (direct-pair and aggregator-hop, buy and sell), `payerIsUser = false` on
every router-paid swap input, the `maxSlippageBps` clamp to the contract's
`MAX_SLIPPAGE_BPS`, both the permit and standing-allowance branches of
`sellViaAggregator`'s `PermitData` (including a byte-for-byte match against
`Router.t.sol`'s own `_noPermit()` fixture), the explicit-allow-list-only
`pinnedV3FeeTierFor`/`stonkzRouterDecision` behaviour, and the EIP-712 permit
typed-data domain against `StonkzToken.sol`'s own construction. `apps/api/src/
routes/trade.test.ts` adds HTTP-level coverage: an atomic direct-pair buy and
sell, an atomic aggregator-hop buy through a pinned pool, both permit-supplied
and standing-allowance sell responses, and the fallback actually triggering
when no fee tier is pinned for a base asset. 325/325 `apps/api` tests pass;
`tsc`/`eslint` clean.
