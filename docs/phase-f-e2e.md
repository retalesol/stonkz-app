# Phase F — dual-chain E2E and staging load

What Phase F built, and what it honestly cannot conclude yet.

## The two gaps Phase F closes

**1. Every write path was mocked.** `e2e/live.spec.ts` intercepts
`/trade/prepare`, `/launch/*`, and `/fees/*` because the app's practice wallets
hold no balance. It proves the UI handles each response shape; it proves
nothing about settlement.

**2. The load test never measured broadcast fan-out.**
[`load-test-results.md`](load-test-results.md)'s PASS was one laptop, stubbed
RPC, and no publisher running — so WS coverage amounted to "idle sockets are
cheap", which was never the launch-day risk.

## What now exists

### Funded-testnet integration harness

[`apps/api/integration/`](../apps/api/integration/README.md). Signs with real
keypairs from the environment and drives prepare → sign → broadcast → confirm →
indexer, across seven scenarios: Solana round trip, RH atomic buy/sell with the
EIP-2612 permit, both chains' graduation LP burn, the RH oracle staleness
bound, ERC-1271 smart-account login, and tip verification including replay
refusal.

Two properties worth calling out, because they are what make it worth running:

- **It cannot pass vacuously.** Unset environment means SKIP, never PASS, and
  the summary states in plain text that a skipped run is not evidence.
- **It does not take the API's word for atomicity.** The RH scenario asserts
  the account's transaction count moved by exactly one. Trusting the response's
  own `atomic: true` would be circular reasoning; the nonce is the chain's
  answer. A trade that comes back on the non-atomic fallback fails the scenario
  outright rather than proceeding — the fallback is a documented degraded mode
  and must not take real funds.

### WS fan-out load test

[`apps/api/loadtest/k6/ws-fanout.js`](../apps/api/loadtest/k6/ws-fanout.js).
Measures **delivery lag** — `Date.now() - msg.at`, end to end across Redis
pub/sub, the hub's fan-out loop, and the socket write — as the subscriber count
ramps, with REST reads running concurrently so the fan-out loop competes with
request handling the way it does in production.

`publisher.ts` stamps every event with `at` before publishing, which is what
makes this measurable from the client at all.

Thresholds: p95 delivery lag under 1s, p99 under 2.5s. Two of the thresholds
exist purely to stop a vacuous pass:
`ws_connection_received_traffic > 0.9` fails the run if most connections saw no
traffic (i.e. no publisher was running), and `ws_messages_unstamped < 1`
catches a payload-shape regression that would silently disable the measurement.

```bash
BASE_URL=https://staging-api WS_URL=wss://staging-api/ws \
  WS_VUS=500 DURATION=5m k6 run loadtest/k6/ws-fanout.js
```

## What Phase F cannot conclude yet

Honest limits, so nobody cites this phase for more than it did:

- **No scenario has been executed.** There is no deployed program, no funded
  testnet wallet, and no staging deploy in this repo. Every scenario currently
  reports SKIP. The harness is verified only insofar as it typechecks, runs,
  and skips correctly.
- **The load thresholds are targets, not measurements.** They encode what
  "good" should mean; no run has produced a number against them.
- **Graduation checks are read-only.** They verify a graduation that already
  happened. Forcing one costs roughly $13.8k of base asset and belongs in a
  dedicated funded run (`INTEGRATION_RUN_GRADUATION=1`).
- **Browser wallet flows are not covered here.** Extension and WalletConnect
  paths belong in Playwright with injected mock providers, which is Phase B's
  scope.

## To actually finish Phase F

1. Complete [`deployment.md`](deployment.md) against a shared testnet.
2. Fund two Solana keypairs and one RH account; deploy an ERC-1271 smart
   account owned by the RH key.
3. Stand up a staging API + indexer in chain mode.
4. Run the harness. Expect real failures on the first pass — that is the point.
5. Run `ws-fanout.js` against staging with the indexer publishing, and record
   the numbers in [`load-test-results.md`](load-test-results.md) alongside the
   existing local run rather than replacing it.
6. Only then tick the corresponding boxes in
   [`launch-checklist.md`](launch-checklist.md).
