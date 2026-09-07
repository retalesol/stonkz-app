# Robinhood Chain trade atomicity — closed by `StonkzRouter`

**Status: closed on the contract side, open on the API side.**
`programs/evm/src/StonkzRouter.sol` now exists and makes a native-in trade
genuinely atomic in one signature. `apps/api` has not been wired to it yet, so
`POST /trade/prepare` still returns the non-atomic `EvmStep[]` fallback
described below. That fallback should be deleted once the API team switches
over; this document should go with it.

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

## What the API side must do

**1. Encode the recipient as `MSG_SENDER`, not `ADDRESS_THIS`.**

This corrects `docs/robinhood-chain.md` §3.3 and an earlier revision of this
file, both of which named `ADDRESS_THIS`. The Universal Router's sentinels are
`MSG_SENDER = address(1)` — whoever called `execute`, which is `StonkzRouter` —
and `ADDRESS_THIS = address(2)`, which is **the Universal Router itself**.
Encoding `ADDRESS_THIS` as the final recipient parks the output inside an
ownerless contract where anyone can sweep it. `StonkzRouter` catches this
(nothing arrives, `AggregatorShortfall` reverts), so the mistake costs a failed
transaction rather than the trade — but it will fail every time until the
encoding is right. `programs/evm/test/Router.t.sol` pins both mis-encodings.

**2. Build the command bytes directly, not from `/v1/swap` calldata.** The
Trading API cannot express "swap into a contract that then does something
else". Use the universal-router encoding (v4/v3/v2 command mix) with the quote's
route. On the sell leg the command must be encoded `payerIsUser = false` so the
Universal Router spends the base `StonkzRouter` transferred to it.

**3. Pass the quote through as `quotedOut`.** This is what the router checks the
delivered amount against, and it is where the "zero platform fee on the
aggregator hop" invariant is enforced on-chain rather than only in the API's
assertion. A `portionBips` service fee attached to an API key is taken from the
output token (`docs/robinhood-chain.md` §3.2), so a fee smuggled into calldata
presents as delivered-below-quoted and reverts with
`AggregatorShortfall(quoted, floor, received)`.

Note what this is and is not: a **bound**, not a detector. A fee smaller than
`maxSlippageBps` is by definition inside the declared tolerance and will be
accepted. Keep the API's own `portionBips` assertion — the two are complementary,
and the contract check is the backstop for calldata the API did not build.
`maxSlippageBps` is capped at 500, so it cannot be widened until the check stops
meaning anything.

**4. Set the two minimums independently.** `minTokenOut` / `minBaseOut` bound the
curve hop and `leg.quotedOut` bounds the aggregator hop. They move for unrelated
reasons; collapsing them into one number lets a bad fill on either leg hide
inside the other's tolerance.

**5. Sells need no approval transaction.** Collect an EIP-2612 signature over
`StonkzToken`'s `permit` (spender = `StonkzRouter`) and pass it in `PermitData`.
For a smart-contract account, or a user who already approved, pass
`deadline = 0` and the router uses the standing allowance instead.

**6. Deployment.** The router takes the Universal Router and launchpad addresses
at construction and both are immutable — a settable target on a contract that
grants token approvals is a drain waiting for a compromised key. Use
`RobinhoodChain.UNIVERSAL_ROUTER`, and re-read that address on-chain before
mainnet per `docs/robinhood-chain.md` §12.

## Tests

`programs/evm/test/Router.t.sol`, 20 passing. Covers the atomic buy and sell
happy paths against a mock with the real `execute(bytes,bytes[],uint256)` shape
and real `V3_SWAP_EXACT_IN` input encoding; a curve failure unwinding the
aggregator swap; an aggregator failure never reaching the curve; permit-based
sell with no prior approval and no signature replay; the fee-smuggling revert
and the in-tolerance case; both recipient mis-encodings; and that the router
holds nothing and exposes no admin surface.

One test is a real fork check, skipped unless `RH_RPC_URL` is set:

```
RH_RPC_URL=<robinhood chain rpc> forge test --match-test Fork
```

It asserts the pinned Universal Router and Permit2 addresses hold code on chain
4663 — the verification `docs/robinhood-chain.md` §12 asks for before mainnet,
and the one thing a mock cannot establish.
