# programs/

On-chain code lands here. Empty on purpose — Phase 2.A owns it, and both chains
are built in parallel from the same interface.

## Planned layout

```
programs/
  launchpad-solana/     Anchor workspace (Rust). Anchor.toml, programs/, tests/
  launchpad-evm/        Foundry or Hardhat workspace (Solidity) for Robinhood Chain
  curve.json            Published CPMM virtual-reserve parameters, shared by both
```

Neither chain is a port of the other: they are two implementations of one
interface, and the golden tests must agree across them.

## Interface both families implement

- `create_token(name, ticker, uri, supply, base_mint, fee_bps, cashback)` —
  fixed supply, mint and freeze authority revoked, curve vault seeded, creator
  recorded.
- `buy(amount_base, min_out)` / `sell(amount_token, min_out)` — the curve only
  ever handles the **base mint**, never native SOL/ETH unless the base _is_
  native. The user's native-in routing happens outside the curve, via Jupiter on
  Solana and Uniswap on Robinhood, with a Stonkz fee of zero on that hop.
- `claim_creator_fees()` — creator vault only. Never the protocol vault, never
  the `$STONKZ` ops vault.

## Fee split is settled on-chain, not by the client

Every curve fill splits `fee_bps` of the base amount three ways:

| Share | Destination                                 |
| ----- | ------------------------------------------- |
| 20%   | `protocol_revenue` vault (native SOL / ETH) |
| 70%   | `creator_vault` for that token              |
| 10%   | `stonkz_ops` vault (native SOL / ETH)       |

Phase 4.B adds an additive split _inside_ the 70%: `poolFrac` of the creator
bucket peels off to that memecoin's stakers, capped at half the bucket. That is
not a rewrite of the 20/10 — those two never enter the stake pool.

`packages/shared` holds the mirror of this arithmetic (`splitFee`,
`creatorVsStakers`, `opsSplit`) for previews and accounting. The chain is the
source of truth for settlement.

## Graduation

At an oracle-priced **$69K** market cap, migrate the token plus base reserves to
Raydium/Meteora on Solana or a Uniswap-style pool on Robinhood, burn the LP, and
set `lane=grad`. After graduation the Stonkz curve fee is zero.

## Before any of this ships

Fuzz the buy/sell invariants, verify the fee split to the lamport and the wei,
have someone who did not write it re-read the rounding on both programs, and run
a security review (plan item 168).
