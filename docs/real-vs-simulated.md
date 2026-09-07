# What is real vs simulated

**Read this before describing Stonkz to anyone outside the build.** Phases 0-6
produced a complete, well-tested codebase. It is **not** a launched product.
The gap is not "polish" — it is that no transaction this app builds has ever
been broadcast to a real chain by a real user wallet, and no board data has
ever come from a real chain event.

This file is the single place that says which is which. Every row is checked
against code, not against a phase's exit notes.

Status legend:

- **REAL** — production-shaped, exercised by tests, no stand-in.
- **REAL, UNCONFIGURED** — code is complete; an operator value (address, env
  var, deployment) is missing, so it does not take effect yet.
- **SIMULATED** — a deliberate, documented stand-in. Works end to end in the
  app, but not against a real chain or real third party.
- **MISSING** — not built.

---

## 1. Wallets and settlement

| Surface | Status | Evidence |
|---|---|---|
| Wallet connect (Solana + RH) | **SIMULATED** | `apps/web/src/app/keys.ts` generates a browser-local practice keypair. No Wallet Standard, wallet-adapter, wagmi, or WalletConnect dependency exists in `apps/web/package.json`. `app/wallet.ts` still carries the Phase 1.B `TODO`. |
| Transaction signing + broadcast | **SIMULATED** | `apps/web/src/app/signer.ts` fakes the wallet prompt and the broadcast-and-confirm wait. Its own header states no code path in `apps/web` or `apps/api` broadcasts a signed transaction to a real RPC. |
| SIWS / SIWE login handshake | **REAL** (over simulated keys) | `apps/web/src/app/session.ts` posts to `/auth/siws` / `/auth/siwe`; `apps/api` verifies real signatures, including an ERC-1271 fallback. The cryptography is real; the key holder is the practice keypair, not an extension or mobile wallet. |
| Tip broadcast | **SIMULATED, fails honestly** | `apps/web/src/app/tip.ts` builds and submits a genuine Solana transfer via a real RPC, but the practice key is unfunded so it always fails with a "connect a funded wallet" toast. RH tips are refused outright. |
| Tip verification (server) | **REAL** | `apps/api/src/social/tips.ts::verifyTip` re-derives sender/recipient/amount from the RPC. A client cannot assert a tip happened or inflate the amount. |

**Consequence:** trading, launching, fee claims, and tips cannot move real
funds today. Anything that says otherwise is wrong.

## 2. Chain data (board, tape, KOTH, charts)

| Surface | Status | Evidence |
|---|---|---|
| Indexer event source | **SIMULATED** | `apps/indexer/src/worker.ts` reads `INDEXER_SOURCE`, defaults to `fixtures`, and **throws** for any other value: `INDEXER_SOURCE=chain requires the Phase 2 programs; only "fixtures" works today`. Both nets use `FixtureEventSource`. |
| Solana ingestion (Geyser / Helius) | **MISSING** | No consumer exists. See `docs/indexer-runbooks.md` §1. |
| RH ingestion (EVM logs) | **MISSING** | Same. |
| Reorg detection / rollback | **MISSING** | `docs/indexer-runbooks.md` §7. No confirmation-depth buffer either. |
| Cursor behaviour on boot | **UNSAFE FOR CHAIN** | `worker.ts` rewinds cursors to `0` on every boot. Correct for fixture replay, destructive the moment ingestion is real. |
| Dead-letter for rejected events | **MISSING** | An uncaught ingest error re-loops the same batch forever, and can stall the *other* chain's `drain()` — `docs/indexer-runbooks.md` §5. |
| Backfill tooling | **MISSING** | Manual cursor rewind only; no CLI. |
| REST/WS read API + frontend read path | **REAL** | `apps/api` routes and `apps/web`'s live mode consume them correctly. They are real code serving fixture-sourced rows. |

**Consequence:** every price, market cap, holder count, candle, and tape row a
user would see today traces back to a fixture scenario, not to chain state.

## 3. On-chain programs

| Surface | Status | Evidence |
|---|---|---|
| Solana launchpad (create/buy/sell/claim/stake/cashback) | **REAL** | `programs/solana`, with unit + integration tests. |
| Solana graduation: Raydium CPMM CPI + LP burn | **REAL** | `programs/solana/programs/launchpad/src/instructions/graduate.rs` performs the CPI and a real SPL `Burn` of 100% of minted LP; supply is verifiably `0` after. Closes security finding H1. |
| EVM launchpad + Uniswap v2 migrator + LP burn | **REAL** | `programs/evm`, Foundry tests. |
| `StonkzRouter` (atomic RH native-in trades) | **REAL** | `programs/evm/src/StonkzRouter.sol`, 20 passing tests, plus one fork test skipped unless `RH_RPC_URL` is set. |
| 20/70/10 fee split | **REAL, asserted on every fill** | `require!`/`require` identity checks in both chains' buy/sell paths, not just tests. |
| Any deployment (devnet/testnet/mainnet) | **MISSING** | Nothing in this repo records a deployed program ID or contract address for either chain. |
| Third-party audit | **MISSING** | Internal review only (`docs/security-review-findings.md`). |

## 4. Trade routing

| Surface | Status | Evidence |
|---|---|---|
| Solana native-in route (Jupiter quote + curve, atomic) | **REAL** | `apps/api/src/router/`, `routes/trade.ts`. |
| RH atomic route via `StonkzRouter` | **REAL, UNCONFIGURED** | `routes/trade.ts` returns `atomic: true` when `stonkzRouterDecision` resolves; `RH_ROUTER_ADDRESS` defaults to the zero address, so today every RH trade takes the non-atomic `EvmStep[]` fallback. |
| Pinned RH Uniswap v3 fee tiers | **REAL, UNCONFIGURED** | `RH_V3_FEE_TIER_OVERRIDES` is deliberately empty. Required per aggregator-hop base asset, and deliberately never guessed — see `docs/robinhood-chain.md` on the ~1,900 hookless v4 pools carrying 88-100% LP fees. |
| Non-atomic `EvmStep[]` fallback | **REAL** | Kept intentionally, with a user-visible warning, for the two config gaps above. |

## 5. Game layer

| Surface | Status | Evidence |
|---|---|---|
| XP / SP / Stonk Optionz ledger | **REAL, server-authoritative** | `apps/api/src/game/ledger.ts` refuses any reason in `CHAIN_VERIFIED_REASONS` without a matching `chain_events` row. No client-mint path found in review. |
| Streaks, achievements, ranks | **REAL** | Server-side, tested. |
| Crate opening | **REAL, but HMAC not VRF** | `apps/api/src/game/crates.ts` rolls `HMAC-SHA256(secret, net\|wallet\|tier\|nonce)` with a server nonce. Not client-manipulable, but auditable-only, not publicly verifiable. Security finding M2: **do not market odds until this is a commit-reveal VRF.** |
| Crate/XP source events | **SIMULATED upstream** | The ledger is real, but the chain events feeding it come from fixtures (§2). |

## 6. Social

| Surface | Status | Evidence |
|---|---|---|
| Follows, wall posts, profile edits (writes) | **REAL** | Live REST against `apps/api` in live mode. |
| Profile reads / flavour text | **PARTLY SIMULATED** | `docs/phase5-social-notes.md`: other users' profiles still render sim-sourced flavour; only writes are live. |
| Chat | **REAL** | REST backfill + WS send/receive, with rate limiting and moderation hooks. |
| X (Twitter) profile cache | **SIMULATED provider** | Structured for a real API key via env var; runs against a placeholder provider until one is supplied. |
| OG tags for crawlers | **REAL, unverified in prod** | `apps/api` OG routes + `apps/web/vercel.json` bot rewrite. `/u/:addr` has no net segment so it defaults to `SOL`. Never exercised against a live Vercel deploy. |
| Legal / risk disclosure | **PLACEHOLDER TEXT** | Footer-linked modal exists. Copy is explicitly placeholder and has had no legal review. |

## 7. `$STONKZ` (Phase 7)

| Surface | Status | Evidence |
|---|---|---|
| 10% ops-vault accrual | **REAL** | Enforced on-chain in both chains' fee split. |
| Buy-and-burn / POL seeding / LP locker | **MISSING** | `programs/SPEC.md`: "No `$STONKZ` buy / LP / burn logic exists anywhere in these programs." |
| `$STONKZ` staker fee claims | **MISSING** | Distinct from per-memecoin staking, which is real. |
| Sweep recipe math (50 / 25 / 25) | **REAL (math only)** | `packages/shared/src/fees.ts::opsSplit`. Nothing executes it. |
| Guard against leaking a spendable balance early | **REAL** | `apps/api/src/routes/rewards.test.ts` pins that no `$STONKZ` balance is exposed pre-Phase 7. |

## 8. Testing and capacity

| Surface | Status | Evidence |
|---|---|---|
| Unit tests | **REAL** | 542+ across packages, green. |
| Playwright sim + live suites | **REAL, mocked writes** | Live suite mocks only the write endpoints (`/trade/prepare`, `/launch/*`, `/fees/*`) because practice wallets hold no balance. Reads, quotes, and auth hit the real stack. |
| Load tests | **REAL, not a capacity sign-off** | `docs/load-test-results.md`: run on one laptop, against stubbed RPC/oracle, with no WS broadcast fan-out from a live indexer. Treat the PASS as "no obvious bottleneck", not as a production SLA. |
| Program tests | **REAL** | Anchor + Foundry, including a Raydium integration path and a skipped-by-default RH fork test. |

---

## Do not claim, until the phases that fix them land

- "Live on mainnet", "trade real memecoins", or anything implying settlement — **blocked on §1**.
- Any price, market cap, or volume figure as real — **blocked on §2**.
- "Atomic trades on Robinhood Chain" without qualification — **blocked on §4** (config).
- Specific crate odds or drop rates — **blocked on §5** (M2 / VRF).
- "Audited" — **blocked on §3**.
- Anything about `$STONKZ` buybacks, burns, or POL — **blocked on §7**.

The forward plan that closes these is tracked in the post-build forward plan
(Phases A-H); this file should be updated in the same commit as whichever
phase changes a row.
