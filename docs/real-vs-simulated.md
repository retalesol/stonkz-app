# What is real vs simulated

**Read this before describing Stonkz to anyone outside the build.** Phases 0-6
produced a complete, well-tested codebase. It is **not** a launched product.
The gap is not "polish" — it is that no transaction this app builds has ever
been broadcast to a real chain, and no board data has ever come from a real
chain event.

Phase B closed the client half of the first gap: real wallets sign and
broadcast now (§1). Robinhood **testnet** now has a live launchpad (§3);
Solana cluster deploy and RH mainnet remain outstanding. Board data still
defaults to fixtures until the indexer points at a live cluster (§2).

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

Phase B replaced the browser-local practice keypair with real wallet
integration on both chains. The simulated signer is gone: `app/signer.ts` no
longer fakes a prompt or a confirmation, and there is no code path left that
reports a fill without a wallet having signed one.

Two caveats apply to every **REAL** in this section, and neither is a
formality:

1. **End-user wallet broadcast through the product UI is still unproven.**
   RH **testnet** contracts are deployed and operator-smoked (§3); Solana
   cluster and RH mainnet are not. A funded browser wallet has not yet driven
   the staging UI end to end.
2. **No real wallet has ever driven it.** CI cannot install and authorise a
   browser extension, and Robinhood Wallet is a phone app. `e2e/mock-wallets.ts`
   implements the same standards a real wallet does — the Wallet Standard
   registry, EIP-1193, EIP-6963 — so the app's own detection, signing and
   confirmation code is genuinely exercised, but whether Phantom and Robinhood
   Wallet honour those standards as specified is not something a mock can
   settle. `docs/robinhood-chain.md` row 34 already flags `personal_sign`
   support in Robinhood Wallet as unconfirmed.

| Surface | Status | Evidence |
|---|---|---|
| Wallet connect, Solana | **REAL** | `apps/web/src/wallet/solana.ts` reads the Wallet Standard registry (`@wallet-standard/app`'s `getWallets()`) directly — no React, no wallet-adapter. Detects installed wallets, filters to those that can sign for the configured cluster, connects, exposes the pubkey, follows account changes. Picker UI: `apps/web/src/modals/walletpicker.ts`. |
| Wallet connect, Robinhood Chain (injected) | **REAL** | `apps/web/src/wallet/evm.ts`: EIP-6963 discovery with a `window.ethereum` fallback, `viem` for chain reads. Addresses are EIP-55 checksummed so the SIWE message matches what the API echoes. |
| Wallet connect, Robinhood Chain (WalletConnect) | **REAL, UNCONFIGURED** | `apps/web/src/wallet/walletconnect.ts` (`@walletconnect/universal-provider`, chain pinned in the session namespace, QR drawn to a `<canvas>` in `modals/walletpicker.ts`). Required rather than optional: Robinhood Wallet is mobile-only, so desktop has no other route in. `VITE_WALLETCONNECT_PROJECT_ID` is unset by default, and with it unset the picker row renders **disabled with the reason shown** — it never falls back to a fake signer. |
| Chain-ID enforcement (4663) | **REAL** | `wallet/evm.ts::enforceRhChain`: reads `eth_chainId`, `wallet_switchEthereumChain`, `wallet_addEthereumChain` on `4902`, then **re-reads and refuses to sign** if the wallet stayed put. Deliberately not run before sign-in, because `personal_sign` is chain-agnostic and many mobile wallets cannot switch at all (`docs/robinhood-chain.md` §6.1). Unit-tested through the whole ladder. |
| Transaction signing + broadcast | **REAL, NEVER BROADCAST FOR REAL** | `app/signer.ts` delegates to the connected wallet. Solana prefers `signAndSendTransaction`, falls back to `signTransaction` + `sendRawTransaction`, then polls `getSignatureStatuses` until confirmed or `lastValidBlockHeight` passes. Robinhood pre-simulates with `eth_call`, sends `eth_sendTransaction`, waits for a receipt and rejects a reverted one. See caveat 1 above. |
| Failure states (rejection / funds / slippage / chain) | **REAL** | `wallet/errors.ts` maps provider errors to 13 distinct kinds; `views/token.ts`, `modals/launch.ts`, `modals/claim.ts` and `modals/steps.ts` report them separately. A decline is not a red failure, and a missed `min_out` reads as SLIPPAGE EXCEEDED rather than as a bare revert. 89 unit tests in `apps/web/src/wallet/`. |
| Write paths wired to the real signer | **REAL** | Trade (all three RH `/trade/prepare` shapes from `docs/rh-trade-atomicity-gap.md` plus Solana atomic), launch, fee claim and tips all go through `wallet/`. `api/live.ts` no longer has a `fakeSellPermit()`. |
| EIP-712 sell permit | **REAL, UNVERIFIABLE UNTIL DEPLOYED** | `wallet/permit.ts` reads `nonces(owner)` off the token immediately before signing (the API returns `nonce: null` on purpose), adds the `EIP712Domain` type entry, drops the API's `note` sibling, and splits the signature into `PermitData`. Whether the resulting digest is one `StonkzToken.permit` accepts cannot be checked without a deployed token (§3). |
| SIWS / SIWE login handshake | **REAL** | `apps/web/src/app/session.ts` posts to `/auth/siws` / `/auth/siwe`; `apps/api` verifies real signatures, including an ERC-1271 fallback. The key holder is now the connected wallet, not a `localStorage` keypair. |
| Tip broadcast | **REAL, both chains** | `apps/web/src/app/tip.ts`. The "RH tips need a real wallet" refusal is gone: an RH tip is an `eth_sendTransaction` of `value` wei, waited on for a receipt. Solana builds a real `SystemProgram.transfer` for the connected wallet to sign. |
| Tip verification (server) | **REAL** | `apps/api/src/social/tips.ts::verifyTip` re-derives sender/recipient/amount from the RPC. A client cannot assert a tip happened or inflate the amount. |
| Practice keypair | **SIMULATED, hard-gated** | `apps/web/src/wallet/practice.ts` keeps the browser-local keypair as a development convenience and nothing more. Four gates: `VITE_PRACTICE_WALLET=1` (unset by default, and not even `=true` opts in); `vite.config.ts` **fails a production build** with it set unless `VITE_PRACTICE_WALLET_ACK=1`; `wallet/manager.ts` ranks it behind every real wallet and never auto-selects it; and every result carries `simulated: true` behind a persistent, non-dismissible UI badge. It signs real SIWS/SIWE (the cryptography is genuine) and broadcasts nothing. `e2e/wallet.spec.ts` asserts it cannot activate in a default build. |

**Consequence:** the client can build and sign real txs. RH **testnet** now
has contracts to hit (§3); Solana and RH mainnet do not. The public board still
defaults to fixtures (§2) — staging seeded `BETADOG` for API prepare smoke
only. Indexer stays `INDEXER_SOURCE=fixtures` until Solana start-slot + chain
mode can be enabled together.

## 2. Chain data (board, tape, KOTH, charts)

| Surface | Status | Evidence |
|---|---|---|
| Indexer event source | **REAL code, defaults to fixtures** | `INDEXER_SOURCE=fixtures` (default) still replays `canonicalScenario()`. `INDEXER_SOURCE=chain` now boots real Solana + RH sources instead of throwing. Nothing in this repo has pointed chain mode at a live cluster. |
| Solana ingestion | **REAL code, NEVER RUN** | Polling `getSignaturesForAddress` + `getTransaction` against `SOLANA_LAUNCHPAD_PROGRAM_ID`, with Anchor event decode. No Geyser/Helius webhook path — polling is the primary, by design. |
| RH ingestion | **REAL code, NEVER RUN** | `viem` `getLogs` against the launchpad + router addresses, ABI-decoded. Requires `RH_LAUNCHPAD_ADDRESS` plus start slot/block; chain mode refuses the zero address at boot. |
| Reorg detection / rollback | **REAL code, NEVER RUN against a live reorg** | Confirmation-depth buffer (Solana `finalized` / RH `N` blocks), cursor hashes, and `ReorgRollback` that deletes orphaned materialized rows. Ledger policy: XP/SP awards for a reorged `chain_events` row are reversed with the market data. |
| Cursor behaviour on boot | **SAFE** | Rewind-to-0 runs only in fixture mode. Chain mode resumes the persisted cursor and will not walk from genesis. |
| Dead-letter for rejected events | **REAL** | `indexer_dead_letters`; a batch that fails `INDEXER_MAX_BATCH_ATTEMPTS` times is recorded and skipped. Per-chain `drain()` isolation means one net cannot stall the other. |
| Backfill tooling | **REAL CLI, NEVER RUN** | `pnpm --filter @stonkz/indexer backfill -- --net SOL\|RH --from N --to M`. Idempotent; `--dry-run` / `--rollback-first` / `--rewind` documented in `docs/indexer-runbooks.md`. |
| Health / metrics / single-replica lock | **REAL** | `GET :8788/health`, `/metrics`, `/dead-letters`. Session-level Postgres advisory lock on a dedicated connection. The lock **must** use Neon's direct (non-pooler) host — transaction pooling breaks session locks. |
| REST/WS read API + frontend read path | **REAL** | `apps/api` routes and `apps/web`'s live mode consume them correctly. Until chain mode is pointed at a deployment, they serve fixture-sourced rows. |

**Consequence:** every price, market cap, holder count, candle, and tape row a
user would see today traces back to a fixture scenario, not to chain state.

**Solana cluster default:** web and API default to **devnet**
(`VITE_CLUSTER` / `SOLANA_CLUSTER` + matching RPC URLs). Mainnet is an
environment switch only — flip cluster + RPC; no code change.

## 3. On-chain programs

| Surface | Status | Evidence |
|---|---|---|
| Solana launchpad (create/buy/sell/claim/stake/cashback) | **REAL** | `programs/solana`, with unit + integration tests. |
| Solana graduation: Raydium CPMM CPI + LP burn | **REAL** | `programs/solana/programs/launchpad/src/instructions/graduate.rs` performs the CPI and a real SPL `Burn` of 100% of minted LP; supply is verifiably `0` after. Closes security finding H1. |
| EVM launchpad + Uniswap v2 migrator + LP burn | **REAL** | `programs/evm`, Foundry tests. |
| `StonkzRouter` (atomic RH native-in trades) | **REAL** | `programs/evm/src/StonkzRouter.sol`, 20 passing tests, plus one fork test skipped unless `RH_RPC_URL` is set. |
| 20/70/10 fee split | **REAL, asserted on every fill** | `require!`/`require` identity checks in both chains' buy/sell paths, not just tests. |
| Deployment tooling | **REAL** | `programs/evm/script/Deploy.s.sol` (mainnet), `DeployTestnet.s.sol` (46630), and `programs/solana/scripts/init-deployment.ts`. Runbook: [`deployment.md`](deployment.md). |
| Robinhood **testnet** (46630) deployment | **REAL** | Addresses in [`programs/evm/deployments/46630.json`](../programs/evm/deployments/46630.json): UUPS `StonkzLaunchpad` + `PushPriceSource`, `StonkzRouter`, self-deployed V2 factory + migrator. Smoke: create/buy/sell `$BETADOG`, oracle `graduate` + `migrateLiquidity` (LP at `0x…dEaD`), and `upgradeToAndCall` succeeded on-chain. |
| Solana / RH **mainnet** deployment | **MISSING** | No mainnet program ID or contract address recorded. Solana bytecode remains upgradeable until authority is revoked (`docs/deployment.md` §1.1). |
| Third-party audit | **MISSING** | Internal review only (`docs/security-review-findings.md`). |

## 4. Trade routing

| Surface | Status | Evidence |
|---|---|---|
| Solana native-in route (Jupiter quote + curve, atomic) | **REAL** | `apps/api/src/router/`, `routes/trade.ts`. |
| RH atomic route via `StonkzRouter` | **REAL on RH testnet staging** | Railway `RH_ROUTER_ADDRESS` / `RH_LAUNCHPAD_ADDRESS` point at 46630 deploy. `POST /trade/prepare` for seeded `BETADOG` returned `atomic: true` → router `0xC414…9513`. Mainnet still defaults to the zero address / non-atomic fallback until a 4663 deploy. |
| Pinned RH Uniswap v3 fee tiers | **REAL, UNCONFIGURED** | `RH_V3_FEE_TIER_OVERRIDES` is deliberately empty. Required per aggregator-hop base asset, and deliberately never guessed — see `docs/robinhood-chain.md` on the ~1,900 hookless v4 pools carrying 88-100% LP fees. |
| Non-atomic `EvmStep[]` fallback | **REAL** | Kept intentionally, with a user-visible warning, for the two config gaps above. |

## 5. Game layer

| Surface | Status | Evidence |
|---|---|---|
| XP / SP / Stonk Optionz ledger | **REAL, server-authoritative** | `apps/api/src/game/ledger.ts` refuses any reason in `CHAIN_VERIFIED_REASONS` without a matching `chain_events` row. Live web hydrates from `GET /rewards` / `GET /me` and never seeds a guest LV-4 ledger (`state/user.ts`). |
| Streaks, achievements, ranks | **REAL** | Server-side, tested. Client `addXP`/`unlock`/`touchStreak` are no-ops in live mode. |
| Crate opening | **REAL, but HMAC not VRF** | Live `POST /rewards/crates/:tier/open`. `apps/api/src/game/crates.ts` rolls `HMAC-SHA256(secret, net\|wallet\|tier\|nonce)` with a server nonce. Not client-manipulable, but auditable-only, not publicly verifiable. Security finding M2: **do not market odds until this is a commit-reveal VRF.** |
| Crate/XP source events | **SIMULATED upstream** | The ledger is real, but the chain events feeding it come from fixtures (§2). |
| Per-memecoin staking (client/API) | **REAL prepare path, AWAITING DEPLOY** | `POST /stake/{prepare,unstake/prepare,claim/prepare}` compose launchpad instructions (Solana + RH). Settlement fails until programs are deployed (§3). Live UI no longer invents `otherStake` pool weight. |

## 6. Social

| Surface | Status | Evidence |
|---|---|---|
| Follows, wall posts, profile edits (writes) | **REAL** | Live REST against `apps/api` in live mode. |
| Profile reads | **REAL in live mode** | `views/profile.ts` loads `GET /users/:net/:addr` + `GET /wall/:net/:addr`. Sim still uses RNG `memberOf` / `wallOf`. |
| Chat | **REAL** | REST backfill + WS receive; send requires SIWS/SIWE. Live does not seed fake chatter. Unauthorized toasts ask the user to sign in. |
| X (Twitter) profile cache | **SIMULATED provider** | Structured for a real API key via env var; runs against a placeholder provider until one is supplied. |
| OG tags for crawlers | **REAL, unverified in prod** | `apps/api` OG routes + `apps/web/vercel.json` bot rewrite. `/u/:addr` has no net segment so it defaults to `SOL`. Never exercised against a live Vercel deploy. |
| Legal / risk disclosure | **PLACEHOLDER TEXT** | Footer-linked modal exists. Copy is explicitly placeholder and has had no legal review. |

## 7. `$STONKZ` (Phase 7)

| Surface | Status | Evidence |
|---|---|---|
| 10% ops-vault accrual | **REAL** | Enforced on-chain in both chains' fee split. |
| Buy-and-burn / POL seeding / LP locker | **MISSING (designed)** | `programs/SPEC.md`: "No `$STONKZ` buy / LP / burn logic exists anywhere in these programs." Implementation-ready design, with the per-chain locking mechanism chosen and the gate stated, in [`phase7-stonkz.md`](phase7-stonkz.md). |
| `$STONKZ` staker fee claims | **MISSING** | Distinct from per-memecoin staking, which is real. |
| Sweep recipe math (50 / 25 / 25) | **REAL (math only)** | `packages/shared/src/fees.ts::opsSplit`. Nothing executes it. |
| Guard against leaking a spendable balance early | **REAL** | `apps/api/src/routes/rewards.test.ts` pins that no `$STONKZ` balance is exposed pre-Phase 7. |

## 8. Testing and capacity

| Surface | Status | Evidence |
|---|---|---|
| Unit tests | **REAL** | 542+ across packages, green. |
| Playwright sim + live suites | **REAL, mocked writes** | Live suite mocks only the write endpoints (`/trade/prepare`, `/launch/*`, `/fees/*`) because no wallet in CI holds balance. Reads, quotes, and auth hit the real stack. |
| Playwright wallet suites | **REAL, against mock wallets** | `e2e/mock-wallets.ts` implements the Wallet Standard registry and EIP-1193/EIP-6963, so `apps/web/src/wallet/` runs unmodified; only the keys and the chain behind them are fake. `e2e/wallet.spec.ts` runs in the default suite and asserts practice mode cannot activate; `e2e/wallet-live.spec.ts` needs `LIVE_E2E=1` because the picker only opens in a live-mode build. Does not prove a real extension or a real Robinhood Wallet behaves the same way — see §1 caveat 2. |
| Funded-testnet integration harness | **REAL code, NEVER RUN** | `apps/api/integration/` drives prepare → sign → broadcast → confirm → indexer with real keypairs. Every scenario currently reports SKIP: there is no deployment and no funded wallet. See [`phase-f-e2e.md`](phase-f-e2e.md). |
| Load tests | **REAL, not a capacity sign-off** | `docs/load-test-results.md`: run on one laptop, against stubbed RPC/oracle, with no WS broadcast fan-out from a live indexer. Treat the PASS as "no obvious bottleneck", not as a production SLA. |
| WS fan-out load test | **REAL code, NEVER RUN** | `apps/api/loadtest/k6/ws-fanout.js` measures real delivery lag and fails closed if no publisher is running. Its thresholds are targets; no run has produced a number against them. |
| Program tests | **REAL** | Anchor + Foundry, including a Raydium integration path and a skipped-by-default RH fork test. |

### Token identity (duplicate tickers / names)

Canonical token id is **`(net, mint)`**. Display ticker (`sym`) and name are
reusable after a **5-minute per-net cooldown** from the most recent matching
launch (`POST /launch/prepare` → `409 name_or_ticker_cooldown`). Deep links
`/t/SYM` without `?mint=` open the **newest** instance.

**Redeploy required for on-chain reuse:** Solana mint PDAs now seed on
`[mint, creator, salt_u64]` (not ticker); RH launchpad no longer reverts on
`"ticker taken"`. Until the Solana program and RH launchpad are redeployed /
upgraded on the target cluster, chain create will still reject or collide
with the old rules even though the API/DB allow duplicates.

---

## Do not claim, until the phases that fix them land

- "Live on mainnet", "trade real memecoins", or anything implying settlement —
  **no longer blocked on the client** (§1 is real), but still **blocked on §3**:
  nothing is deployed, so there is nothing to settle against.
- "Works with Phantom / Robinhood Wallet" as a tested claim — **blocked on §1
  caveat 2**. It is written against their published standards and tested
  against mocks of them; no real wallet has run it.
- Any price, market cap, or volume figure as real — **blocked on §2**.
- "Atomic trades on Robinhood Chain" without qualification — **blocked on §4** (config).
- Specific crate odds or drop rates — **blocked on §5** (M2 / VRF).
- "Audited" — **blocked on §3**.
- Anything about `$STONKZ` buybacks, burns, or POL — **blocked on §7**.

The forward plan that closes these is tracked in the post-build forward plan
(Phases A-H); this file should be updated in the same commit as whichever
phase changes a row.
