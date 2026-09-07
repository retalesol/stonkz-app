# programs/

On-chain code. Phase 2.A owns it, and both chains are built from one interface.

## Layout

```
programs/
  SPEC.md               The interface, the CPMM derivation, the rounding rules
  curve.json            Published CPMM parameters, read by both chains and both apps
  parity-vectors.json   Generated from Rust; the table all three implementations answer to
  curve-sim.ts          Dependency-free BigInt mirror, imported by the API and the launch preview
  solana/               Anchor workspace (Rust). Anchor.toml, programs/, tests/
  evm/                  Foundry workspace (Solidity) for Robinhood Chain
    ASSUMPTIONS.md      Divergences from the Anchor program, and why each one is forced
```

Neither chain is a port of the other: they are two implementations of one
interface, and the golden tests must agree across them.

Read [SPEC.md](SPEC.md) before changing anything in either tree — in particular
§1 (why the parameters graduate at $69K) and §2 (why the creator bucket is the
remainder rather than a third floor). If you are working in `evm/`, read
[evm/ASSUMPTIONS.md](evm/ASSUMPTIONS.md) as well: it lists the places the two
chains legitimately differ, so that a difference is never mistaken for drift.

## Keeping the three implementations honest

`parity-vectors.json` is generated from the Rust settlement math and is the
single table the Anchor program, the TypeScript simulate helper and the Solidity
mirror are all held to. A divergence fails a test suite here rather than
surfacing in production as a user whose quote did not match their fill.

```
cargo test -p launchpad --lib parity      # regenerate the vectors from Rust
pnpm --dir solana verify:parity           # hold curve-sim.ts to them
forge test --match-contract ParityTest    # hold CurveMath.sol to them  (from evm/)
```

Regenerate the vectors whenever the math changes, and expect the other two
suites to fail until they are brought back into line. That is the mechanism
working, not a nuisance.

## Running everything

```
cargo test -p launchpad --lib             # 21 host tests: fuzz, invariants, rounding
anchor test                               # 19 integration tests on a local validator
forge test                                # 52 tests                        (from evm/)
```

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

At an oracle-priced **$69K** market cap, migrate the token plus base reserves
into a real pool and burn 100% of the LP it mints, and set `lane=grad`. After
graduation the Stonkz curve fee is zero.

On Solana this is a CPI into Raydium CPMM (`migrate_liquidity`, in
`launchpad/src/instructions/graduate.rs`) followed by a genuine SPL `burn` —
`lp_mint.supply` reads `0` afterward, not merely "sent to an address nobody
uses." On Robinhood it is `UniswapV2Migrator.sol`'s Uniswap v2 pool +
burn-address mint. See `docs/security-review-findings.md` H1 for the fix
history and `SPEC.md` §5/§7 for both chains' exact guarantees.

## Before any of this ships

Fuzz the buy/sell invariants, verify the fee split to the lamport and the wei,
have someone who did not write it re-read the rounding on both programs, and run
a security review (plan item 168).
