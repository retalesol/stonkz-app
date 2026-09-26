# What is real vs simulated

**Read this before describing Stonkz to anyone outside the build.** Phases 0-6
produced a complete, well-tested codebase. It is **not** a mainnet product.
Staging now settles real **testnet/devnet** trades (Solana + RH + Base Sepolia)
via the funded integration harness and chain-indexed board/tape — but no
**mainnet** program is deployed, and no end-user browser extension has driven
the staging UI end to end.

Phase B closed the client half of the first gap: real wallets sign and
broadcast now (§1). Robinhood **testnet** now has a live launchpad (§3);
Solana **devnet** program is deployed and upgraded. **Coinbase Base** is a
first-class `Net='BASE'` — Base Sepolia **84532** launchpad + `StonkzRouter`
are **deployed** (addresses in
[`programs/evm/deployments/84532.json`](../programs/evm/deployments/84532.json)).
Board/tape on staging come from `INDEXER_SOURCE=chain` (§2) — fixture mode is
refused in production.

Devnet beta findings and remediations: [`devnet-beta-findings.md`](devnet-beta-findings.md).

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

## 0. Networks (Phase 1 of the Base + Arc rollout)

`Net` is now `'SOL' | 'BASE' | 'ARC' | 'RH'`, and every fact about a net that is
not an environment secret (gas unit, decimals, colours, DEX, tip floor, trade
cap) lives in one place: `packages/shared/src/nets.ts` (`NET_INFO`). The web
wallet layer keys chain ids / RPCs / explorers off the same union in
`apps/web/src/wallet/chain.ts` (`EVM_CHAINS`). Adding a fifth net is one row
in each plus whatever the exhaustive `Record<Net, …>` maps then demand.

| Surface                                                      | Status           | Evidence                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Arc in the picker, chips, badges, wallet chip, connect sheet | **REAL (UI)**    | `ALL_NETS` drives the net chips on the board, the chain badge on every card and token header, the SWITCH NETWORK row in the wallet menu, and the environment block on the connect sheet (env, chain id, unit, faucet, mainnet warning).                        |
| Arc settlement                                               | **NOT DEPLOYED** | No launchpad / router on 5042. The API refuses Arc trade prepare and does not add 5042 to the SIWE allow-list until `ARC_LAUNCHPAD_ADDRESS` is set. Web falls back to `NET_INFO.ARC.maxTradeUsd` messaging only.                                               |
| Arc gas / decimals                                           | **DESIGNED**     | Native USDC is 18-decimal at the EVM layer (`wallet_addEthereumChain` declares `decimals: 18`, symbol `USDC`), 6-decimal as ERC-20. `formatEther` therefore yields whole USDC; display uses `NET_INFO.ARC.displayDecimals`. Unverified against a live Arc RPC. |
| Cross-chain guard                                            | **REAL (UI)**    | Opening a coin on a net other than the connected wallet's shows the WRONG CHAIN strip; the ticket button becomes SWITCH TO <net> and reopens the picker instead of signing.                                                                                    |
| Sim sandbox                                                  | **REAL (sim)**   | Older sim coins are spread across BASE / ARC / RH so each chain chip has rows; the youngest coins and the ones "you" launched stay on Solana, which the sim journeys rely on.                                                                                  |

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

| Surface                                               | Status                                | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wallet connect, Solana                                | **REAL**                              | `apps/web/src/wallet/solana.ts` reads the Wallet Standard registry (`@wallet-standard/app`'s `getWallets()`) directly — no React, no wallet-adapter. Detects installed wallets, filters to those that can sign for the configured cluster, connects, exposes the pubkey, follows account changes. Picker UI: `apps/web/src/modals/walletpicker.ts`.                                                                                                                                                                                                                                                                                 |
| Wallet connect, Robinhood Chain (injected)            | **REAL**                              | `apps/web/src/wallet/evm.ts`: EIP-6963 discovery with a `window.ethereum` fallback, `viem` for chain reads. Addresses are EIP-55 checksummed so the SIWE message matches what the API echoes.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Wallet connect, Coinbase Base                         | **REAL on staging**                   | Same EVM wallet layer with `Net='BASE'`, chain id **84532** (Sepolia). Staging `VITE_BASE_*` points at the 84532 deploy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Wallet connect, Robinhood Chain (WalletConnect)       | **REAL on staging**                   | `apps/web/src/wallet/walletconnect.ts` (`@walletconnect/universal-provider`, chain pinned in the session namespace, QR drawn to a `<canvas>` in `modals/walletpicker.ts`). Required rather than optional: Robinhood Wallet is mobile-only, so desktop has no other route in. Staging sets `VITE_WALLETCONNECT_PROJECT_ID`; with it unset the picker row renders **disabled with the reason shown** — it never falls back to a fake signer.                                                                                                                                                                                          |
| Chain-ID enforcement (4663)                           | **REAL**                              | `wallet/evm.ts::enforceRhChain`: reads `eth_chainId`, `wallet_switchEthereumChain`, `wallet_addEthereumChain` on `4902`, then **re-reads and refuses to sign** if the wallet stayed put. Deliberately not run before sign-in, because `personal_sign` is chain-agnostic and many mobile wallets cannot switch at all (`docs/robinhood-chain.md` §6.1). Unit-tested through the whole ladder.                                                                                                                                                                                                                                        |
| Transaction signing + broadcast                       | **REAL, NEVER BROADCAST FOR REAL**    | `app/signer.ts` delegates to the connected wallet. Solana prefers `signAndSendTransaction`, falls back to `signTransaction` + `sendRawTransaction`, then polls `getSignatureStatuses` until confirmed or `lastValidBlockHeight` passes. Robinhood pre-simulates with `eth_call`, sends `eth_sendTransaction`, waits for a receipt and rejects a reverted one. See caveat 1 above.                                                                                                                                                                                                                                                   |
| Failure states (rejection / funds / slippage / chain) | **REAL**                              | `wallet/errors.ts` maps provider errors to 13 distinct kinds; `views/token.ts`, `modals/launch.ts`, `modals/claim.ts` and `modals/steps.ts` report them separately. A decline is not a red failure, and a missed `min_out` reads as SLIPPAGE EXCEEDED rather than as a bare revert. 89 unit tests in `apps/web/src/wallet/`.                                                                                                                                                                                                                                                                                                        |
| Write paths wired to the real signer                  | **REAL**                              | Trade (all three RH `/trade/prepare` shapes from `docs/rh-trade-atomicity-gap.md` plus Solana atomic), launch, fee claim and tips all go through `wallet/`. `api/live.ts` no longer has a `fakeSellPermit()`.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| EIP-712 sell permit                                   | **REAL on RH testnet + Base Sepolia** | `wallet/permit.ts` reads `nonces(owner)` off the token immediately before signing (the API returns `nonce: null` on purpose), adds the `EIP712Domain` type entry, drops the API's `note` sibling, and splits the signature into `PermitData`. `/trade/prepare` now eth_calls `name()` for the EIP-712 domain (indexer `tokens.name` is the ticker). Funded harness: RH + Base atomic sell with permit **PASS**.                                                                                                                                                                                                                     |
| SIWS / SIWE login handshake                           | **REAL**                              | `apps/web/src/app/session.ts` posts to `/auth/siws` / `/auth/siwe`; `apps/api` verifies real signatures, including an ERC-1271 fallback. The key holder is now the connected wallet, not a `localStorage` keypair.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Tip broadcast                                         | **REAL, both chains**                 | `apps/web/src/app/tip.ts`. The "RH tips need a real wallet" refusal is gone: an RH tip is an `eth_sendTransaction` of `value` wei, waited on for a receipt. Solana builds a real `SystemProgram.transfer` for the connected wallet to sign.                                                                                                                                                                                                                                                                                                                                                                                         |
| Tip verification (server)                             | **REAL**                              | `apps/api/src/social/tips.ts::verifyTip` re-derives sender/recipient/amount from the RPC. A client cannot assert a tip happened or inflate the amount.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Practice keypair                                      | **SIMULATED, hard-gated**             | `apps/web/src/wallet/practice.ts` keeps the browser-local keypair as a development convenience and nothing more. Four gates: `VITE_PRACTICE_WALLET=1` (unset by default, and not even `=true` opts in); `vite.config.ts` **fails a production build** with it set unless `VITE_PRACTICE_WALLET_ACK=1`; `wallet/manager.ts` ranks it behind every real wallet and never auto-selects it; and every result carries `simulated: true` behind a persistent, non-dismissible UI badge. It signs real SIWS/SIWE (the cryptography is genuine) and broadcasts nothing. `e2e/wallet.spec.ts` asserts it cannot activate in a default build. |

**Consequence:** the client can build and sign real txs. RH **testnet** and
Solana **devnet** have contracts to hit (§3); Solana / RH **mainnet** do not.
Staging board/tape are chain-indexed (§2), not fixture-replayed.

## 2. Chain data (board, tape, KOTH, charts)

| Surface                                | Status                              | Evidence                                                                                                                                                                                                                      |
| -------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Indexer event source                   | **REAL on staging (chain default)** | `INDEXER_SOURCE` defaults to `chain`; `fixtures` is refused in production unless `INDEXER_ALLOW_FIXTURES=1`. Staging Railway runs chain mode against Solana devnet + RH 46630 + Base Sepolia 84532 with start slot/block set. |
| Solana ingestion                       | **REAL on staging**                 | Polling `getSignaturesForAddress` + `getTransaction` against `SOLANA_LAUNCHPAD_PROGRAM_ID`, with Anchor event decode. No Geyser/Helius webhook path — polling is the primary, by design.                                      |
| RH ingestion                           | **REAL on staging**                 | `viem` `getLogs` against the launchpad + router addresses, ABI-decoded. Requires `RH_LAUNCHPAD_ADDRESS` plus start block; chain mode refuses the zero address at boot.                                                        |
| Base Sepolia ingestion                 | **REAL on staging**                 | Same EVM source with `net: 'BASE'`, `INDEXER_BASE_START_BLOCK` from the 84532 deploy, launchpad + router addresses.                                                                                                           |
| Reorg detection / rollback             | **REAL code, lightly exercised**    | Confirmation-depth buffer (Solana `finalized` / RH `N` blocks), cursor hashes, and `ReorgRollback`. Staging RH has seen reorg counters > 0.                                                                                   |
| Cursor behaviour on boot               | **SAFE**                            | Rewind-to-0 runs only in fixture mode. Chain mode resumes the persisted cursor and will not walk from genesis.                                                                                                                |
| Dead-letter for rejected events        | **REAL**                            | `indexer_dead_letters`; a batch that fails `INDEXER_MAX_BATCH_ATTEMPTS` times is recorded and skipped. Per-chain `drain()` isolation means one net cannot stall the other.                                                    |
| Backfill tooling                       | **REAL CLI, NEVER RUN**             | `pnpm --filter @stonkz/indexer backfill -- --net SOL\|RH --from N --to M`. Idempotent; `--dry-run` / `--rollback-first` / `--rewind` documented in `docs/indexer-runbooks.md`.                                                |
| Health / metrics / single-replica lock | **REAL**                            | `GET :8788/health`, `/metrics`, `/dead-letters`. Session-level Postgres advisory lock on a dedicated connection. The lock **must** use Neon's direct (non-pooler) host — transaction pooling breaks session locks.            |
| REST/WS read API + frontend read path  | **REAL**                            | `apps/api` routes and `apps/web`'s live mode consume them. Board hides `legacy:` / empty-mint rows.                                                                                                                           |

**Consequence:** staging board/tape rows come from chain ingest. Fixture replay
is test-only. Mainnet still needs its own start slot/block after deploy.

**Solana cluster default:** web and API default to **devnet**
(`VITE_CLUSTER` / `SOLANA_CLUSTER` + matching RPC URLs). Mainnet is an
environment switch only — flip cluster + RPC; no code change.

## 3. On-chain programs

| Surface                                                       | Status                           | Evidence                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Solana launchpad (create/buy/sell/claim/stake/cashback)       | **REAL**                         | `programs/solana`, with unit + integration tests.                                                                                                                                                                                                                                                                                      |
| Solana graduation: Meteora DLMM CPI + permanent position lock | **REAL**                         | `programs/solana/programs/launchpad/src/instructions/graduate.rs` — `migrate_create_pool` + `migrate_seed_liquidity`; position `lock_release_point = u64::MAX`, operator cleared to incinerator. Closes security finding H1 (DLMM has no fungible LP mint).                                                                            |
| EVM launchpad + Uniswap v2 migrator + LP burn                 | **REAL**                         | `programs/evm`, Foundry tests.                                                                                                                                                                                                                                                                                                         |
| `StonkzRouter` (atomic RH native-in trades)                   | **REAL**                         | `programs/evm/src/StonkzRouter.sol`, 20 passing tests, plus one fork test skipped unless `RH_RPC_URL` is set.                                                                                                                                                                                                                          |
| 20/60/10/10 fee split                                         | **REAL, asserted on every fill** | `require!`/`require` identity checks in both chains' buy/sell paths, not just tests.                                                                                                                                                                                                                                                   |
| Deployment tooling                                            | **REAL**                         | `programs/evm/script/Deploy.s.sol` (mainnet), `DeployTestnet.s.sol` (46630), and `programs/solana/scripts/init-deployment.ts`. Runbook: [`deployment.md`](deployment.md).                                                                                                                                                              |
| Robinhood **testnet** (46630) deployment                      | **REAL**                         | Addresses in [`programs/evm/deployments/46630.json`](../programs/evm/deployments/46630.json): UUPS `StonkzLaunchpad` + `PushPriceSource`, `StonkzRouter`, self-deployed V2 factory + migrator. Smoke: create/buy/sell `$BETADOG`, oracle `graduate` + `migrateLiquidity` (LP at `0x…dEaD`), and `upgradeToAndCall` succeeded on-chain. |
| Base **Sepolia** (84532) deployment                           | **REAL**                         | Addresses in [`programs/evm/deployments/84532.json`](../programs/evm/deployments/84532.json): UUPS launchpad + `PushPriceSource`, `StonkzRouter`, Stonkz V2 factory + migrator. Smoke token `$BASEDOG`. Staging API/indexer/web env wired.                                                                                             |
| Solana / RH / Base **mainnet** deployment                     | **MISSING**                      | No mainnet program ID or contract address recorded. Solana bytecode remains upgradeable until authority is revoked (`docs/deployment.md` §1.1).                                                                                                                                                                                        |
| Third-party audit                                             | **MISSING**                      | Internal review only (`docs/security-review-findings.md`).                                                                                                                                                                                                                                                                             |

## 4. Trade routing

| Surface                                                | Status                           | Evidence                                                                                                                                                 |
| ------------------------------------------------------ | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Solana native-in route (Jupiter quote + curve, atomic) | **REAL**                         | `apps/api/src/router/`, `routes/trade.ts`.                                                                                                               |
| RH atomic route via `StonkzRouter`                     | **REAL on RH testnet staging**   | Railway `RH_ROUTER_ADDRESS` / `RH_LAUNCHPAD_ADDRESS` point at 46630 deploy. Production boots refuse a zero router. `POST /trade/prepare` is atomic-only. |
| Base atomic route via `StonkzRouter`                   | **REAL on Base Sepolia staging** | Railway `BASE_ROUTER_ADDRESS` / `BASE_LAUNCHPAD_ADDRESS` point at 84532 deploy. Same prepare shape as RH.                                                |
| Pinned RH Uniswap v3 fee tiers                         | **REAL on staging (USDG:3000)**  | Unpinned aggregator-hop bases fail closed with `rh_router_required` — never guessed.                                                                     |
| Non-atomic `EvmStep[]` fallback                        | **REMOVED from prepare path**    | `buildEvmTradePlan` remains for tests/reference only; `/trade/prepare` and the live client refuse multi-signature RH trades.                             |

## 5. Game layer

| Surface                           | Status                                    | Evidence                                                                                                                                                                                                                                                                                             |
| --------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| XP / SP / Stonk Optionz ledger    | **REAL, server-authoritative**            | `apps/api/src/game/ledger.ts` refuses any reason in `CHAIN_VERIFIED_REASONS` without a matching `chain_events` row. Live web hydrates from `GET /rewards` / `GET /me` and never seeds a guest LV-4 ledger (`state/user.ts`).                                                                         |
| Streaks, achievements, ranks      | **REAL**                                  | Server-side, tested. Client `addXP`/`unlock`/`touchStreak` are no-ops in live mode.                                                                                                                                                                                                                  |
| Crate opening                     | **REAL, but HMAC not VRF**                | Live `POST /rewards/crates/:tier/open`. `apps/api/src/game/crates.ts` rolls `HMAC-SHA256(secret, net\|wallet\|tier\|nonce)` with a server nonce. Not client-manipulable, but auditable-only, not publicly verifiable. Security finding M2: **do not market odds until this is a commit-reveal VRF.** |
| Crate/XP source events            | **REAL on staging when indexer is chain** | Ledger awards still require matching `chain_events` rows; staging indexer feeds those from chain.                                                                                                                                                                                                    |
| Per-memecoin staking (client/API) | **REAL prepare path, AWAITING DEPLOY**    | `POST /stake/{prepare,unstake/prepare,claim/prepare}` compose launchpad instructions (Solana + RH). Settlement fails until programs are deployed (§3). Live UI no longer invents `otherStake` pool weight.                                                                                           |

## 6. Social

| Surface                                     | Status                       | Evidence                                                                                                                                                        |
| ------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Follows, wall posts, profile edits (writes) | **REAL**                     | Live REST against `apps/api` in live mode.                                                                                                                      |
| Profile reads                               | **REAL in live mode**        | `views/profile.ts` loads `GET /users/:net/:addr` + `GET /wall/:net/:addr`. Sim still uses RNG `memberOf` / `wallOf`.                                            |
| Chat                                        | **REAL**                     | REST backfill + WS receive; send requires SIWS/SIWE. Live does not seed fake chatter. Unauthorized toasts ask the user to sign in.                              |
| X (Twitter) profile cache                   | **SIMULATED provider**       | Structured for a real API key via env var; runs against a placeholder provider until one is supplied.                                                           |
| OG tags for crawlers                        | **REAL, unverified in prod** | `apps/api` OG routes + `apps/web/vercel.json` bot rewrite. `/u/:addr` has no net segment so it defaults to `SOL`. Never exercised against a live Vercel deploy. |
| Legal / risk disclosure                     | **PLACEHOLDER TEXT**         | Footer-linked modal exists. Copy is explicitly placeholder and has had no legal review.                                                                         |

## 7. `$STONKZ` (Phase 7)

| Surface                                         | Status                 | Evidence                                                                                                                                                                                                                             |
| ----------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 10% ops-vault accrual                           | **REAL**               | Enforced on-chain in both chains' fee split.                                                                                                                                                                                         |
| Buy-and-burn / POL seeding / LP locker          | **MISSING (designed)** | `programs/SPEC.md`: "No `$STONKZ` buy / LP / burn logic exists anywhere in these programs." Implementation-ready design, with the per-chain locking mechanism chosen and the gate stated, in [`phase7-stonkz.md`](phase7-stonkz.md). |
| `$STONKZ` staker fee claims                     | **MISSING**            | Distinct from per-memecoin staking, which is real.                                                                                                                                                                                   |
| Sweep recipe math (50 / 25 / 25)                | **REAL (math only)**   | `packages/shared/src/fees.ts::opsSplit`. Nothing executes it.                                                                                                                                                                        |
| Guard against leaking a spendable balance early | **REAL**               | `apps/api/src/routes/rewards.test.ts` pins that no `$STONKZ` balance is exposed pre-Phase 7.                                                                                                                                         |

## 8. Testing and capacity

| Surface                            | Status                            | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit tests                         | **REAL**                          | 542+ across packages, green.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Playwright sim + live suites       | **REAL, mocked writes**           | Live suite mocks only the write endpoints (`/trade/prepare`, `/launch/*`, `/fees/*`) because no wallet in CI holds balance. Reads, quotes, and auth hit the real stack.                                                                                                                                                                                                                                                                                                                |
| Playwright wallet suites           | **REAL, against mock wallets**    | `e2e/mock-wallets.ts` implements the Wallet Standard registry and EIP-1193/EIP-6963, so `apps/web/src/wallet/` runs unmodified; only the keys and the chain behind them are fake. `e2e/wallet.spec.ts` runs in the default suite and asserts practice mode cannot activate; `e2e/wallet-live.spec.ts` needs `LIVE_E2E=1` because the picker only opens in a live-mode build. Does not prove a real extension or a real Robinhood Wallet behaves the same way — see §1 caveat 2.        |
| Funded-testnet integration harness | **REAL, run on staging**          | `apps/api/integration/` drives prepare → sign → broadcast → confirm → indexer. **PASS** (2026-09-14, refreshed same day): Solana buy/sell; RH + Base atomic buy/sell+permit; Solana stake flex→unstake; RH + Base stake (approve→stake→unstake) after ERC-20 approve + EIP-55 wallet join fix; creator fees list + referral code path. Graduation LP-burn SKIP until a graduated board row exists. ERC-1271 / tip SKIP without extra env keys. See [`phase-f-e2e.md`](phase-f-e2e.md). |
| Load tests                         | **REAL, not a capacity sign-off** | `docs/load-test-results.md`: run on one laptop, against stubbed RPC/oracle, with no WS broadcast fan-out from a live indexer. Treat the PASS as "no obvious bottleneck", not as a production SLA.                                                                                                                                                                                                                                                                                      |
| WS fan-out load test               | **REAL code, NEVER RUN**          | `apps/api/loadtest/k6/ws-fanout.js` measures real delivery lag and fails closed if no publisher is running. Its thresholds are targets; no run has produced a number against them.                                                                                                                                                                                                                                                                                                     |
| Program tests                      | **REAL**                          | Anchor + Foundry, including a Raydium integration path and a skipped-by-default RH fork test.                                                                                                                                                                                                                                                                                                                                                                                          |

### Token identity (duplicate tickers / names)

Canonical token id is **`(net, mint)`**. Display ticker (`sym`) and name are
reusable after a **5-minute per-net cooldown** from the most recent matching
launch (`POST /launch/prepare` → `409 name_or_ticker_cooldown`). Deep links
`/t/SYM` without `?mint=` open the **newest** instance.

**On-chain reuse (staging, 2026-09-13):** Solana mint PDAs seed on
`[mint, creator, salt_u64]` (not ticker); RH launchpad no longer reverts on
`"ticker taken"`. Devnet program
`FF1f3V47FtApwWWMHX462Gm7NVqNpUJ7K4yqKrYGSMbg` and RH testnet proxy
`0x2588E500B1e5fCF18253F44b6f2607BF2B14161C` are upgraded in place — addresses
unchanged. See `docs/deployment.md` and `programs/evm/deployments/46630.json`.

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
