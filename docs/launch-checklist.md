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
- [ ] **Programs deployed and initialized on mainnet**, per [`deployment.md`](deployment.md), with all five authority roles held by distinct keys and none of them in the API's environment.
- [ ] **Indexer running in chain mode** (`INDEXER_SOURCE=chain`), resuming from its persisted cursor, with reorg handling and confirmation-depth buffering active. No fixture data reachable in production.
- [ ] **`RH_ROUTER_ADDRESS` set**, so RH trades take the atomic `StonkzRouter` path. If it is unset, the non-atomic fallback can strand a user mid-route holding an intermediate asset.
- [ ] **`RH_V3_FEE_TIER_OVERRIDES` pinned by hand** for every supported aggregator-hop base asset, each verified on the explorer. Never guessed — roughly 1,900 pools on this chain carry 88-100% LP fees.
- [ ] **External audit complete** and findings closed or accepted in writing. See [`audit-package.md`](audit-package.md).

## Verify on-chain, not in a test

- [ ] Graduate a throwaway token on **each** chain and confirm on a block explorer that the LP is gone: Solana LP mint supply is `0`; EVM LP sits at `0x…dEaD`.
- [ ] Confirm a real trade's fee split landed 20/70/10 in the three expected places.
- [ ] Confirm the aggregator hop took **zero** platform fee.
- [ ] Confirm a memecoin staker cannot draw more than half the creator bucket.
- [ ] Confirm the protocol treasury and the ops vault are distinct addresses and that neither is reachable from a user-facing claim.
- [ ] Confirm `maxOracleStaleness` is heartbeat-scale on RH (86400 + grace), not minute-scale. A short value here makes graduation permanently unreachable.
- [ ] Exercise the pause switches: pause trading, confirm a buy is refused, unpause, confirm it works.

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
- [ ] Robinhood Chain stock-token policy decided: the registry can freeze every stock token on the chain at once, and a frozen base asset wedges any curve trading against it. Decide whether stock tokens are supported bases at all, and what the UI says if a freeze happens.
- [ ] Marketing copy checked against [`real-vs-simulated.md`](real-vs-simulated.md)'s do-not-claim list.

## Do not claim until the specific gate passes

| Claim | Gated on |
|---|---|
| "Live", "trade real memecoins" | Real wallets + broadcast + deployment |
| Any price, market cap, or volume figure | Indexer in chain mode |
| "Atomic trades on Robinhood Chain" | `RH_ROUTER_ADDRESS` set and verified |
| "Liquidity is burned forever" | Explorer verification on both chains |
| Specific crate odds or drop rates | Commit-reveal VRF (finding M2) |
| "Audited" | Third-party audit complete |
| Anything about `$STONKZ` buybacks, burns, or POL | Phase 7 shipped, token exists |

## Post-launch, first week

- [ ] Watch indexer lag and reorg counters hourly for the first 24h.
- [ ] Reconcile on-chain fee accrual against the API's ledger daily; any drift is a bug, not rounding.
- [ ] Confirm the first real graduation's LP burn on the explorer, manually, before publicising that it happened.
- [ ] Re-read `real-vs-simulated.md` and update every row that changed.
