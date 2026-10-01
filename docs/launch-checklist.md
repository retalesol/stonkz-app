# Launch checklist

Every line here is a gate, not a suggestion. If any box is unchecked, the
correct action is to not launch, or to launch with the corresponding claim
explicitly withheld.

Source of truth for what is currently real:
[`real-vs-simulated.md`](real-vs-simulated.md). This checklist is what has to
become true before that file has no SIMULATED or MISSING rows in the
user-facing paths.

---

## Blocking: nothing settles without these

- [ ] **Real wallet connection ships, practice mode cannot.** `VITE_PRACTICE_WALLET` off in the production build, verified by inspecting a production bundle — not just the env file. A production build with the practice keypair reachable is a launch-stopping defect.
- [ ] **Real broadcast, both chains.** A funded wallet completes buy, sell, launch, fee claim, and tip on Solana and on Robinhood Chain, with real confirmations. No simulated confirm anywhere in the path.
- [ ] **Programs deployed and initialized on mainnet**, per [`deployment.md`](deployment.md): EVM through `script/DeployMainnet.s.sol` (RH 4663 first, Base 8453 with the same script), with every authority role held by a distinct key and none of them in the API's environment.
- [ ] **EVM governance landed in the deploy itself**: `StonkzLaunchpad`, every price source and the `ReferralVault` have `admin() == TimelockController` (`getMinDelay() >= 86400`, the Safe is proposer/canceller/executor), `pauser()` is the hot pauser key, and the deployer EOA holds no timelock role and is admin of nothing. Read it from the chain, not from the script log.
- [ ] **Pyth wired end to end**: `PYTH_HERMES_URL` (+ key) set on the API, `StonkzRouter.pyth()` is `0x8250f4aF…1487a` on the chain, and a real launch carried its Hermes update. Without one every launch is refused `stale oracle` (a deferral, not a wedge).
- [ ] **`MAX_BUY_NATIVE` decided and recorded.** `0` deploys an uncapped router; the script prints a warning. A capped soft launch needs the value chosen before the broadcast — the router is immutable.
- [ ] **Chain ids are the mainnet ids everywhere** (`RH_CHAIN_ID=4663`, `BASE_CHAIN_ID=8453`, `EVM_ALLOWED_CHAIN_IDS=4663,8453`): base mints, RPC/explorer defaults and the referral asset follow the id, and a chain id with no pinned table refuses to boot.
- [ ] **Indexer running in chain mode** (`INDEXER_SOURCE=chain`, the default), resuming from its persisted cursor, with reorg handling and confirmation-depth buffering active. Fixture mode refused in production without `INDEXER_ALLOW_FIXTURES=1`.
- [ ] **`RH_ROUTER_ADDRESS` set** (production boot requirement). Missing router or unpinned aggregator fee tiers return `rh_router_required` — there is no non-atomic fallback.
- [ ] **`RH_V3_FEE_TIER_OVERRIDES` pinned by hand** for every supported aggregator-hop base asset, each verified on the explorer. Never guessed — roughly 1,900 pools on this chain carry 88-100% LP fees.
- [ ] **External audit complete** and findings closed or accepted in writing. See [`audit-package.md`](audit-package.md).

## Verify on-chain, not in a test

- [ ] Graduate a throwaway token on **each** chain and confirm on a block explorer that the liquidity is out of every wallet's reach: Solana — the Meteora DLMM position is owned by the coin's `meteora_escrow` PDA with no operator; EVM — the full-range Uniswap V3 position is owned by the immutable `FeeLocker` (`lockOf(token)`), which has no function that removes liquidity, and `claimFees(token)` routes the pool's fees into the launchpad's ledgers.
- [ ] Confirm a real trade's fee split landed 15 / 69 / 10 / 6 in the four expected places (protocol treasury, creator bucket incl. the staker peel, `$STONKZ` buyback vault, RWA crate fund) — on the curve and, after graduation, on a `FeeLocker.claimFees`.
- [ ] Confirm the aggregator hop took **zero** platform fee.
- [ ] Confirm a memecoin staker cannot draw more than half the creator bucket.
- [ ] Confirm the protocol treasury and the ops vault are distinct addresses and that neither is reachable from a user-facing claim.
- [ ] Confirm `maxOracleStaleness` is the 90000 s clamp (heartbeat + grace for the Chainlink fallback), that `priceSource()` is the `PythPriceSource` (120 s per-feed bound, reachable because launches carry an update), and that `PythPriceSource.fallbackSource()` is the Chainlink source. A minute-scale clamp would make the fallback path permanently stale.
- [ ] Exercise the pause switches **from the pauser key**: `pause(true,…)`, confirm a buy is refused and a referral claim is refused, then have the Safe schedule `setPause(false,…)` through the timelock and confirm trading resumes after `MIN_DELAY`. The pauser must not be able to unpause.

## Operational readiness

- [ ] Indexer metrics scraped, with alerts on cursor lag (slots/blocks and seconds), dead-letter count, and reorg count. Thresholds per [`indexer-runbooks.md`](indexer-runbooks.md).
- [ ] Single-replica indexer enforced (advisory lock or leader key), so two instances cannot double-materialize.
- [ ] Backfill procedure rehearsed once against staging, not read for the first time during an incident.
- [ ] Load test re-run against staging with real WS fan-out from a live indexer. The existing PASS in [`load-test-results.md`](load-test-results.md) was one laptop with stubbed RPC and no broadcast fan-out; it is not a capacity sign-off.
- [ ] Rate limits verified behind the real edge proxy, with `TRUSTED_PROXY_DEPTH` matching the actual topology. Confirm a spoofed `X-Forwarded-For` does not get a fresh bucket.
- [ ] Withdraw-authority keys are multisig or cold, with a rehearsed signing procedure and a documented recovery path.
- [ ] Incident runbook names who can pause, and how, without a deploy.

## Legal and claims

- [ ] Disclosure text reviewed by actual counsel. What ships today is placeholder copy written by the build.
- [ ] Jurisdictional restrictions decided and enforced, if any apply.
- [ ] Robinhood Chain stock-token policy: **v1 ships no stock bases on either mainnet** (`StockBases.sol` mainnet branches are empty; `StockPriceSourceV2` is deployed with no base configured). Before opting one in through the timelock (`deployment.md` §2.3): counsel on the jurisdiction gate, and a UI state for the registry freeze — it can freeze every stock token on the chain at once, and a frozen base asset wedges any curve trading against it.
- [ ] Marketing copy checked against [`real-vs-simulated.md`](real-vs-simulated.md)'s do-not-claim list.

## Do not claim until the specific gate passes

| Claim                                            | Gated on                                   |
| ------------------------------------------------ | ------------------------------------------ |
| "Live", "trade real memecoins"                   | Real wallets + broadcast + deployment      |
| Any price, market cap, or volume figure          | Indexer in chain mode                      |
| "Atomic trades on Robinhood Chain"               | `RH_ROUTER_ADDRESS` set and verified       |
| "Liquidity is locked forever"                    | Explorer verification on both chains       |
| Crate odds are "fair" or "provable"              | Commit-reveal VRF (finding M2) — see below |
| "Audited"                                        | Third-party audit complete                 |
| Anything about `$STONKZ` buybacks, burns, or POL | Phase 7 shipped, token exists              |

### On crate odds specifically

The row above is narrower than it first looks, and the distinction matters
because the product already contradicts the blunt version of this rule.

The app **publishes the drop table today**: the rewards view renders a
`DROP TABLE · ODDS PER OPEN` column, and `GET /rewards` serves the same
percentages. So "do not publish crate odds" is not a gate anyone can pass —
it is already shipped, and removing the table would break parity with the
visual oracle in `legacy/index.html`.

What makes that acceptable right now is that the payout is **simulated**: the
view says so in the same breath, and crate rewards ($STONKZ credits and RWA
positions) are not yet claimable on chain.
Publishing a number nobody can independently verify is fine when the number
buys nothing.

It stops being acceptable the moment crate rewards become claimable, because
then an unverifiable server-side roll decides real value. The rolls use an
HMAC of a server secret ([`apps/api/src/game/crates.ts`](../apps/api/src/game/crates.ts)) —
uniform and unpredictable to the client, but entirely trust-me: nothing lets a
user check that the roll they got was the roll the server committed to.

So the real gate, in order:

- [ ] Before $STONKZ or RWA crate rewards are claimable: either ship commit-reveal
      VRF, or replace the exact percentages with rarity tiers carrying no
      numeric claim.
- [ ] Never describe the current rolls as "provably fair", "verifiable", or
      "on-chain randomness". They are none of those things.
- [ ] Keep the simulated-payout disclosure adjacent to the table for as long
      as the table shows numbers.

## Post-launch, first week

- [ ] Watch indexer lag and reorg counters hourly for the first 24h.
- [ ] Reconcile on-chain fee accrual against the API's ledger daily; any drift is a bug, not rounding.
- [ ] Confirm the first real graduation's locked position (`FeeLocker.lockOf`, Meteora escrow) on the explorer, manually, before publicising that it happened.
- [ ] Re-read `real-vs-simulated.md` and update every row that changed.
