# Phase 6 exit review — Robinhood Chain in the live app

Reviewer pass over `programs/evm`, `apps/api`'s RH-specific routes/auth, and
`apps/web`'s RH wiring end to end, as a cohesive whole rather than per-PR.
Scope, per the Phase 6 brief: enable the network picker for RH in the live
app, add e2e coverage for the RH flow, and review the whole RH surface for
mock values, client-authoritative logic that should not be, undocumented
Solana/RH divergence, and missing test coverage.

**Headline finding, stated up front because it changes what "enable the
network picker" meant in practice: there was nothing left to enable.** RH has
been selectable in the picker since `state/wallet.ts`'s very first commit
(`NETS.RH` has always existed alongside `NETS.SOL`; nothing gates it behind a
flag, a feature check, or a `net === 'SOL'` branch anywhere in `apps/web`).
`app/session.ts`'s SIWE handshake, `api/live.ts`'s atomic/non-atomic/permit
branching, and the RH-specific copy (`ROBINHOOD CHAIN` trade-box titles, `ETH`
vs `SOL` units, the non-atomic warning, the permit note) all landed in Phase
2.C, before this review started. What this pass actually did:

1. Read every source document (`docs/robinhood-chain.md`,
   `docs/rh-trade-atomicity-gap.md`, `programs/evm/ASSUMPTIONS.md`) and traced
   each of their decisions into the code that implements it (below).
2. Confirmed, by reading `state/wallet.ts`, `app/wallet.ts`,
   `modals/netpicker.ts`, `app/session.ts`, `app/keys.ts`, `app/signer.ts` and
   `api/live.ts`, that RH is already live and not gated.
3. Extended `e2e/live.spec.ts` with the two RH cases the existing suite
   didn't cover: an atomic `StonkzRouter` buy and an atomic sell that needs
   the first-time permit signature. Ran the whole file (15 tests) against a
   real local live stack — Postgres/Redis in Docker, `apps/api` and
   `apps/indexer` with the fixture producer, `apps/web`'s dev server in live
   mode — not just against mocks. All 15 pass.
4. Found and fixed one real bug (below), because it blocked step 3 from
   running at all.
5. Wrote this document.

## What closes cleanly

- **The atomic path is real, not a placeholder.** `signTradePlan` in
  `api/live.ts` branches on `prep.atomic` and, for RH, on
  `prep.permitTypedData`, and all three shapes now have e2e coverage: atomic
  buy (single signature, no modal — same as Solana), atomic sell with a
  standing allowance (same), and atomic sell with no standing allowance (two
  off-chain signatures, walked through `modals/steps.ts`, with copy that
  correctly does not read like the non-atomic warning — `docs/rh-trade-
  atomicity-gap.md`'s "still one on-chain transaction" framing is preserved
  verbatim in the UI, not just the docs).
- **The non-atomic fallback is real and distinguishable.** When
  `stonkzRouterDecision` has no route (no `RH_ROUTER_ADDRESS`, or no pinned
  v3 fee tier for that base asset), the response is `atomic: false` with a
  `warning`, and `modals/steps.ts` pins that warning on screen for the whole
  walk rather than collapsing it into a single "confirm". e2e-covered.
- **SIWE end-to-end is real cryptography against a real verifier.**
  `app/keys.ts`'s practice key signs the exact EIP-191 digest
  `auth/siwe.ts`'s `personalSignHash` recovers against (byte-for-byte, per
  that file's own comment), and `auth/service.ts` validates `Chain ID` against
  an environment allow-list rather than trusting the client. `verifySiweFull`
  falls back to ERC-1271 for smart accounts, exactly as `docs/robinhood-
  chain.md` §6.3 specifies, and `auth/siwe.test.ts` covers both the recovery
  path and the contract-account path (including "refuses when no caller is
  configured" and "an impostor's signature does not admit a different
  account").
- **`block.timestamp`-only, oracle-never-blocks-a-trade, and the v2-burn
  graduation split** (`ASSUMPTIONS.md` §2.1, §2.4, §2.5) are all reflected in
  `programs/evm/src` and pinned by `Oracle.t.sol` / `Migration.t.sol`, not
  just asserted in prose.
- **Zero-fee-on-the-aggregator-hop is enforced twice, deliberately, at
  different layers** — `router/uniswap.ts` asserts `portionBips` is absent/0
  on every quote (never sends `integratorFees`), and `StonkzRouter`'s balance
  check independently catches a fee smuggled into calldata the API didn't
  build. `ASSUMPTIONS.md` §2.8 explains why both checks earn their keep
  instead of being redundant, and the code matches that explanation.

## Bug found and fixed (apps/api, minimal, in scope per the brief)

**`DEFAULT_CORS` in `apps/api/src/env.ts` didn't include `http://127.0.0.1:*`,
only `http://localhost:*`.** Vite's dev/preview server prints (and
`e2e/live.spec.ts`'s own header instructions use)
`http://127.0.0.1:5173`/`:4173`. A browser treats `127.0.0.1` and `localhost`
as different origins even though they resolve to the same host, so every
authenticated request from a dev server bound that way got a same-origin-
looking `403 origin_not_allowed` — not a CORS preflight failure a browser
console explains well, just a silent auth-and-everything-else failure. This
is exactly the failure mode this review's own e2e run hit first: `boot()`
(`app/shell.ts`) awaits `api.ready()` with no `try/catch`, so a 403 there
means `data-booted` never gets set and the app looks hung, not errored.

Fixed by adding `http://127.0.0.1:5173` and `http://127.0.0.1:4173` to
`DEFAULT_CORS`. One-line-per-origin change, additive only, covered by the
existing `health.test.ts` CORS suite (still passing) plus this review's own
successful live-stack e2e run, which failed against `127.0.0.1` before the
fix and passed after it. No production behavior changes — `ston.kz` is
unaffected, and `RH_ROUTER_ADDRESS`/other prod config is untouched.

This is unrelated to the concurrent Phase 5 (`social/*`) work landing in the
same file at the same time — see "A note on repo concurrency" below for how
that was kept separate.

## Findings that are not blocking, in the order the brief asked for them

### 1. Remaining mock/placeholder RH values

- **`RH_ROUTER_ADDRESS` and `RH_V3_FEE_TIER_OVERRIDES` default to unset**
  (zero-address / empty), which is the documented, intentional posture — see
  `docs/rh-trade-atomicity-gap.md`'s "operator-config gaps rather than
  per-trade ones." Every base asset falls through to the non-atomic path
  until an operator sets these. **Not a bug**, but worth restating here since
  it means the atomic path this review just added e2e coverage for has never
  run against a real chain — only against the mocked shape of what
  `routes/trade.ts` returns once it is configured, and against
  `Router.t.sol`'s Foundry mocks on the contract side. `ASSUMPTIONS.md` §4
  and `docs/robinhood-chain.md` §12 both already carry a pre-mainnet
  re-verification checklist that covers this; nothing here adds to it beyond
  flagging that Phase 6 didn't change that checklist's status.
- **`apps/web`'s wallet is a practice keypair, not a real wallet
  connection**, and this is the one place this review pushed back on the
  Phase 6 brief's literal wording. The brief asked to "wire up wagmi/viem
  wallet connection for RH (WalletConnect required for desktop)." That does
  not exist anywhere in this repo, and `app/keys.ts`'s own header comment
  says why deliberately: `apps/api`'s chain clients default to real
  mainnet/testnet RPCs with nowhere to broadcast a signed transaction into,
  so a real WalletConnect connection would let a user sign with a real
  wallet and then fail at broadcast for lack of funds, or (worse) connect a
  funded wallet to an app that cannot safely custody that trust yet. Building
  real wagmi/viem + WalletConnect now would be a multi-day feature (a real
  WalletConnect Cloud project ID, a real device test against Robinhood
  Wallet per `docs/robinhood-chain.md` §6.2's own "verify on a device before
  SIWE ships to prod" caveat, and a real broadcast-and-confirm path in
  `app/signer.ts` to replace the current simulated one) layered on top of an
  architecture that has, so far, deliberately never claimed to be more real
  than it is. Doing it as a rushed add-on inside this review risks exactly
  the kind of undocumented divergence the brief also asked this review to
  watch for. **Recommendation: treat real wallet connection (both nets — SOL
  has the identical gap, per `app/wallet.ts`'s own Phase-1.B TODO) as its own
  phase with its own device-testing checklist, not a Phase 6 line item.** The
  practice-key architecture is honestly labeled everywhere it appears
  (`SIMULATED` in the connect toast, `PRACTICE` framing in code comments, the
  footer disclosure), so nothing here is presented to a user as more real
  than it is.
- **`fakeSellPermit()` in `api/live.ts`** sends an all-zero `PermitData` on
  the second `/trade/prepare` call. This is consistent with the point above —
  there is no real signer to produce a real EIP-712 signature from — and
  `apps/api`'s own test suite exercises the real permit-typed-data path
  independently (`router/evm-router.test.ts`'s "byte-for-byte match against
  `Router.t.sol`'s own `_noPermit()` fixture"). Not a new gap; flagged only
  because the exit review was asked to look for exactly this shape of thing.

### 2. Client-authoritative logic that should be server/contract-authoritative

Checked specifically because this is the highest-value thing an exit review
can catch. Nothing found that crosses the line:

- `api/live.ts`'s `applyConfirmedTrade` computes a local market-cap nudge
  (`push`) purely for the UI's optimistic redraw; the fill's actual `sol`/
  `tok`/`mc` numbers all come from the server's `/trade/prepare` response,
  never from client math. The next poll/WS tick overwrites it with the
  server's real number regardless. This is the same pattern `sim.ts` always
  used, extended honestly rather than newly invented.
- The permit-sign step order (`signTradePlan`'s RH branch) is a UI sequencing
  concern only — the actual permit validity, nonce, and deadline are the
  contract's problem (`StonkzToken.sol`'s EIP-2612 implementation), and the
  API resends the whole trade through `/trade/prepare` rather than trusting
  a client-held nonce.
- `router/uniswap.ts`'s `portionBips` assertion and `StonkzRouter`'s balance
  check are both server/contract-side, not client-side — the client never
  gets a chance to see or tamper with the aggregator leg's accounting.
- The one candidate that looked client-authoritative at first glance —
  `applyCandles`/`patchCoin`'s `t.supply || SUPPLY` fallback — turned out to
  be a display default for a coin whose supply the server hasn't sent yet
  (pre-launch UI states), not a value fed back into any trade or graduation
  decision. Confirmed by grep: nothing reads `SimCoin.supply` on the write
  path; `liveTrade`/`liveLaunch` only ever forward what `/trade/prepare` and
  `/launch/prepare` already composed.

### 3. Undocumented divergence between Solana and RH behavior

One found, worth a decision rather than a silent fix:

- **RH sells can need two off-chain signatures before the one on-chain
  transaction; Solana sells never need more than one signature, period.**
  This is disclosed in the UI (the permit-sign modal's note text, this
  review's new e2e test asserts it says so) and in `docs/rh-trade-
  atomicity-gap.md`, so it is not *undisclosed* — but it is a real UX
  asymmetry between the two nets that nothing in `docs/robinhood-chain.md`'s
  "Confirmed as planned — no change needed" section (§9.2) calls out. Every
  other net-conditional UI difference this review found (gas-token unit,
  `ROBINHOOD CHAIN` trade-box suffix, the non-atomic warning) is explicitly
  net-branched and intentional; this one is too, it's just not centrally
  documented as a *product* difference the way the others are. Recommend
  adding one line to `docs/robinhood-chain.md`'s planned-vs-actual table
  next time it's touched, not a code change.
- Everything else that differs — 18 vs 6 decimals, `ACC_PRECISION`, oracle
  staleness bound, `block.timestamp` vs Solana's slot clock — is exhaustively
  documented in `programs/evm/ASSUMPTIONS.md` §1-2 already, which is exactly
  the right place for it and was clearly written with this kind of review in
  mind.

### 4. Missing test coverage for RH-specific edge cases

The brief named three explicitly. Status on each:

- **Oracle staleness on graduation** — covered on the contract side
  (`programs/evm/test/Oracle.t.sol`, 13 tests: heartbeat-aware bound,
  `answeredInRound` check, the "stale oracle defers graduation but never
  blocks a trade" invariant from `ASSUMPTIONS.md` §2.4). **Not covered
  end-to-end through `apps/web`** — there is no e2e or API-level test that
  drives a stale-oracle response through `GET /tokens` or the trade/launch
  flow to confirm the UI degrades the way `ASSUMPTIONS.md` promises (no
  trade-blocking, graduation simply deferred). This is a real gap, but not
  one this review fixed: it needs a fake oracle response wired through
  `apps/api`'s test harness, which is an `apps/api` test-infrastructure
  change, not a web/e2e one, and is more naturally Phase 2.A/2.R's follow-up
  than Phase 6's.
- **Smart-account (ERC-1271) signature validation** — covered at the unit
  level (`auth/siwe.test.ts`, several cases including the impostor-signature
  negative test) but **not exercised through the UI at all**, because
  `app/keys.ts`'s practice wallet is always an EOA (a raw secp256k1 keypair)
  — there is no practice "smart account" to drive a real ERC-1271 login from
  the browser. This is a direct consequence of the wallet-integration gap in
  finding §1 above, not a separate oversight: a meaningful e2e test here
  needs either a real contract-wallet fixture on a devnet/fork or a mocked
  `eth_call` response, and the latter would test Playwright's ability to
  mock fetch, not the app. Recommend leaving this at the unit level until
  real wallet connection lands.
- **WalletConnect desktop flow** — no coverage anywhere, because there is no
  WalletConnect integration to cover (finding §1). `docs/robinhood-
  chain.md` §6.2 already flags this as needing "one manual device test...
  before SIWE ships to prod," which is correct and remains the right gate;
  an automated test cannot substitute for it since Robinhood Wallet is
  mobile-only with no automatable desktop surface today.

One more gap this review noticed but wasn't named in the brief: **the atomic
`StonkzRouter` path has zero coverage against a real chain or even a real
Uniswap-shaped mock beyond `Router.t.sol`'s Foundry mocks** — `docs/rh-trade-
atomicity-gap.md` §"one nuance `Router.t.sol`'s own mock does not exercise"
already says this about the contract test, and this review's new e2e tests
add UI-level coverage of the response *shape* but, like every other test in
`live.spec.ts`, mock `POST /trade/prepare` itself rather than a real
`StonkzRouter` deployment. The re-verification checklist in both
`docs/robinhood-chain.md` §12 and `ASSUMPTIONS.md` §4 already covers this
("confirm Uniswap v2 is deployed on testnet 46630," "re-read every address on
Blockscout") — restated here only to confirm Phase 6 didn't close it, since
closing it needs a funded testnet wallet and a real deployment, neither of
which exists in this environment.

## A note on repo concurrency, for whoever reads this next

This review ran while another agent was actively committing a "Phase 5
social layer" feature (`apps/api/src/social/*`, commits `3216a70` and
`fe9c060`) to the same working tree in real time. Two consequences worth
recording:

1. `pnpm typecheck` on `apps/api` currently fails — `app/deps.ts` is missing
   `chat`/`xCache` on `AppDeps`. This is that Phase 5 work mid-flight, not
   anything this review touched or introduced; confirmed by `git stash`-ing
   this review's own changes and re-running typecheck, which reproduced a
   different failure (`social/tips.ts`'s own two type errors) with this
   review's changes removed. **Not fixed here** — it's out of Phase 6's
   scope and actively being worked on by someone else; fixing it
   speculatively risks fighting a moving target.
2. This review's CORS fix landed inside that same agent's commit `fe9c060`
   (both edits touched `env.ts`; a concurrent `git add -A` on the shared
   working tree swept up this review's staged hunk along with theirs) before
   this review could commit it separately. The fix itself was verified
   correct before that happened (confirmed present in the file, confirmed by
   the e2e run passing against `127.0.0.1`) and is unrelated to their
   feature, but it is not attributable to a standalone commit — noted here so
   it isn't mistaken for scope creep into Phase 5's work.

## Test/build status at the end of this review

- `pnpm test` (root vitest, all workspaces): **515/515 passing**, 31 test
  files, including `apps/api`'s full RH-specific suite
  (`router/evm-router.test.ts`, `router/universal-router.test.ts`,
  `routes/trade.test.ts`, `auth/siwe.test.ts`).
- `e2e/live.spec.ts` against a real local live stack (Docker Postgres/Redis,
  `apps/api` + `apps/indexer` with fixtures, `apps/web` dev server in live
  mode): **15/15 passing**, including this review's two new RH atomic tests.
- `pnpm typecheck`: **`apps/web` and `packages/*` clean.** `apps/api` fails,
  pre-existing and unrelated to this review (see "repo concurrency" above).
- `programs/evm` Foundry suite was read but not re-run in this review (no
  Foundry toolchain invoked); `docs/rh-trade-atomicity-gap.md`'s own count
  (20/20 `Router.t.sol`, plus `Launchpad.t.sol`/`Parity.t.sol`/
  `Migration.t.sol`/`Oracle.t.sol`) was taken as read, not re-verified,
  since no contract code changed in this review.
