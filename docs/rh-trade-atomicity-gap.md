# Robinhood Chain trade atomicity — closed by `StonkzRouter`

**Status: closed.** `programs/evm/src/StonkzRouter.sol` makes a native-in
trade genuinely atomic in one signature, and `apps/api`'s `POST /trade/prepare`
calls it exclusively: `router/evm-router.ts` composes
`buyViaAggregator`/`sellViaAggregator`, returns `atomic: true`, or fails with
`rh_router_required`.

**There is no multi-signature `EvmStep[]` fallback on the prepare path.** The
composer in `router/evm-tx.ts` remains for reference/tests only. Production
refuses to boot without `RH_ROUTER_ADDRESS`. An aggregator-hop base without a
pinned `RH_V3_FEE_TIER_OVERRIDES` entry also fails closed — never guessed
(`docs/robinhood-chain.md` fee-trap warning).

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

| Side | Base = WETH                          | Base = anything else                                   |
| ---- | ------------------------------------ | ------------------------------------------------------ |
| Buy  | `WETH.deposit` → `approve` → `buy`   | Uniswap swap (recipient = trader) → `approve` → `buy`  |
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
_final_ leg of both the direct-pair and aggregator-hop paths is `MSG_SENDER`
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
guaranteed `SlippageTooWide` revert — clamping only _tightens_ the on-chain
tolerance relative to what the trader asked for, never widens it. On the
direct-pair path (an exact 1:1 wrap/unwrap) `maxSlippageBps` is `0`: there is
no market risk to tolerate.

**4. The two minimums are kept independent**, per side:

- **Buy:** `minTokenOut` (the curve floor) vs. `leg.quotedOut` (the aggregator
  floor) — already distinct in `composeCurveTrade`'s existing
  `curveMinOutAtoms`, no new field needed.
- **Sell:** this is the one place `composeCurveTrade`'s pre-existing
  `curveMinOutAtoms` was computed in the _wrong_ terms for this purpose — it
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
router on that token. **This is now a live path**: Phase 2.C's trade-box wiring
in `apps/web/src/api/live.ts` walks a first-time RH sell as an explicit
two-signature flow (sign the permit typed data, resend with `body.permit`,
then sign the atomic swap) — see "Frontend impact" below.

**6. Deployment.** Unchanged from the contract's own design: the Universal
Router and launchpad addresses are immutable, set at construction. The API
only needs `RH_ROUTER_ADDRESS` (the deployment) and, per aggregator-hop base
asset, one `RH_V3_FEE_TIER_OVERRIDES` entry.

## Frontend impact

**Wired, as of Phase 2.C.** This section previously said "none" because
`apps/web` had no consumer of `POST /trade/prepare` at the time this document
was written; that is no longer true. `apps/web/src/api/live.ts` now handles all
three RH response shapes:

1. **`{ atomic: true, to, data, value }`** — the `StonkzRouter` path, signed as
   a single transaction, the same `to`/`data`/`value` shape
   `POST /launch/prepare`'s RH branch already returned.
2. **`{ atomic: true, …, permitTypedData, note }`** — a first-time sell with no
   standing allowance. Walked as an explicit two-signature flow: sign the
   EIP-712 typed data, resend the prepare call with `body.permit`, then sign
   the returned atomic call. Kept visually distinct from case 3 so a
   two-signature _atomic_ trade is never presented as a non-atomic one.
3. **`{ atomic: false, steps: EvmStep[], warning }`** — the fallback, walked in
   order by `modals/steps.ts` with the `warning` surfaced to the user, for the
   two operator-config gaps listed at the top of this document.

Playwright coverage for all three lives in `e2e/live.spec.ts` (atomic buy,
atomic sell with permit, and the non-atomic multi-signature walk with its
warning asserted visible).

**Still simulated at the wallet layer:** `apps/web`'s signing goes through
`app/signer.ts`'s practice keypair, which fakes the wallet prompt and the
broadcast/confirm wait. No RH transaction built by this path has ever been
broadcast to chain 4663. See [`real-vs-simulated.md`](real-vs-simulated.md).

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
