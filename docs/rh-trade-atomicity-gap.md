# Robinhood Chain trade atomicity — status after Phase 2.R/2.B

**Status: no atomic native-in trade exists on Robinhood Chain.** This is
expected and was predicted by `docs/robinhood-chain.md` §3.3 before this phase
started; this document records what was actually shipped against that
prediction, for whoever picks up the `StonkzRouter` work.

## What `docs/robinhood-chain.md` §3.3 already established

Uniswap Trading API calldata targets the Universal Router with the caller's
own EOA as the swap recipient. Handing that calldata to the wallet as "step 1
of 2" ends with the base token sitting in the user's wallet, not in a contract
that can then call `StonkzLaunchpad.buy`. The only construction that makes a
native-in trade genuinely atomic is a **`StonkzRouter` periphery contract**
that receives the swap output itself (Universal Router recipient =
`ADDRESS_THIS`), asserts a minimum, approves the curve, and forwards the
result to the user — all inside one Solidity call, so a revert on any leg
reverts the whole transaction.

## What this phase confirmed by reading `programs/evm`

`StonkzRouter.sol` (or any periphery contract with an equivalent job) **does
not exist anywhere in `programs/evm`**. `StonkzLaunchpad.buy`/`sell` take the
base token only (by design — see `programs/evm/ASSUMPTIONS.md` §2.7, which
explicitly reserves this composition for "a later phase"). Building it was out
of this phase's scope (`apps/api`, `apps/indexer`, and new `packages/*` only —
never `programs/`), so it was not attempted.

## What this phase shipped instead

`POST /trade/prepare` on `net=RH` returns a **documented, non-atomic sequence**
of separate transactions (`router/evm-tx.ts`'s `EvmTradePlan`), not a single
signature:

| Side | Base = WETH | Base = anything else |
|---|---|---|
| Buy | `WETH.deposit` \u2192 `approve` \u2192 `buy` | Uniswap swap (recipient = trader) \u2192 `approve` \u2192 `buy` |
| Sell | `approve` \u2192 `sell` \u2192 `WETH.withdraw` | `approve` \u2192 `sell` \u2192 Uniswap swap (recipient = trader) |

Every response carries `atomic: false` and a `warning` string spelling out the
consequence: a trader who stops signing partway through is left holding
whatever the last completed step produced (wrapped ETH, an approved-but-unspent
balance, or the launched token with no ETH received yet) — not their original
ETH. The frontend (Phase 2.C, deliberately deferred past this phase) must
present these as sequential prompts with that warning surfaced, never as one
button.

**This must not be presented to users trading real funds as if it were safe
in the way the plan's "one atomic tx" requirement means.** It is a usable
placeholder, not a fix.

## What actually closes the gap

Deploy `StonkzRouter.sol` on Robinhood Chain per `docs/robinhood-chain.md`
§3.3's construction:

1. `buyExactEthIn(bytes urCommands, bytes[] urInputs, address curve, uint256 minBaseOut, uint256 minTokenOut)` —
   calls `UniversalRouter.execute{value: msg.value}(...)` with recipient =
   `ADDRESS_THIS`, asserts the base balance delta, approves the curve, calls
   `buy`, forwards the launched token to the caller.
2. A sell path that pulls the launched token via **Permit2 `SignatureTransfer`
   or the token's own EIP-2612 `permit`** (already present on `StonkzToken`
   per `ASSUMPTIONS.md` §2.7) so selling stays one signature, not an
   approve-then-swap pair.
3. Encode Universal Router commands directly (v4/v3/v2 command mix) rather
   than forwarding Trading API `/v1/swap` calldata, which cannot express "swap
   into a contract that then does something else."

Once that contract exists, `router/evm-tx.ts` should be replaced with a single
calldata builder targeting it, and this document (and the `atomic: false` /
`warning` fields) should be deleted along with the two-step fallback.
