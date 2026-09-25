# Devnet beta findings — 2026-09-14

File-by-file audit of the Solana-devnet + Robinhood-testnet product (including
WIP referrals / SP levels / social caps), prior to adding Coinbase Base and
opening live-user beta.

Severity:

- **P0** — funds / auth / wrong-chain settlement / claimable phantom balances
- **P1** — broken journey or silent incorrect data
- **P2** — copy / polish / non-blocking ops

Reuse [`security-review-findings.md`](security-review-findings.md) as the
security baseline. Closed items there (H1, M1, M3, M4, L1–L3) are not
re-litigated. **M2** (crate HMAC ≠ VRF) remains **accepted for beta** — do not
market odds as provably fair.

Status legend in the tables below: **OPEN** → must close before beta invite;
**ACCEPT** → documented, not a beta blocker; **FIXED** → closed in the same
pass as this plan.

---

## P0

| ID    | Status     | File                                         | Impact                                                                                                                                                                    | Fix                                                                                                          |
| ----- | ---------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| B0-01 | OPEN→FIXED | `apps/indexer/src/rollback.ts`               | Reorg rollback reverses protocol treasury but **not** `referral_fee_events` / `referral_fee_balances`. Referrers can claim Optionz from fills that no longer exist.       | Unwind referral fee events/balances (and related claim ledger rows) on position delete; add durability test. |
| B0-02 | OPEN→FIXED | `apps/web/src/api/live.ts` (`liveLaunch`)    | Confirm returns `mint` but local `SimCoin` is built **without** `mint` / `tradeable: true`. Post-launch trade box disabled; RH dev-buy can fail against a mint-less coin. | Apply `confirmed.mint`, set `tradeable: true`, navigate with `?mint=`.                                       |
| B0-03 | OPEN→FIXED | `apps/web/src/wallet/chain.ts` + staging env | Web defaults `VITE_RH_CHAIN_ID=4663` (mainnet) while staging is **46630**. Wrong-chain SIWE / trades.                                                                     | Default staging builds to 46630; document mainnet override.                                                  |
| B0-04 | OPEN→FIXED | Share / OG                                   | Share copies `/t/SYM` without `?mint=`; OG `/u/:addr` hardcodes `SOL` in `vercel.json`. Wrong token / wrong-net previews.                                                 | Share with mint; infer net from address shape for OG rewrite.                                                |

## P1

| ID    | Status           | File                                       | Impact                                                                                                        | Fix                                                                                                                                                       |
| ----- | ---------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1-01 | OPEN→FIXED       | `packages/shared` `Net` / `nativeUnit`     | `Net = 'SOL' \| 'RH'`; non-RH → SOL. Blocks Base; mislabels gas.                                              | Add `'BASE'`, `isEvm()`, map native unit per net.                                                                                                         |
| B1-02 | OPEN→FIXED       | `apps/web` net picker / `state/wallet.ts`  | Subtitle **MAINNET-BETA** on a `devnet` default build.                                                        | Drive label from `SOLANA_CLUSTER`.                                                                                                                        |
| B1-03 | OPEN→FIXED       | `apps/api/src/router/solana-tx.ts`         | Jupiter ALT routes throw opaque 500.                                                                          | Structured `jupiter_alt_required` 422 + client toast.                                                                                                     |
| B1-04 | OPEN→FIXED       | Indexer rollback                           | SP-level crate inventory / `referral_sp` not unwound on reorg.                                                | Reconcile SP claims / reverse kickbacks after XP rollback.                                                                                                |
| B1-05 | OPEN→FIXED       | `apps/api/.../social-caps.ts`              | Parallel wall/like can exceed daily XP cap.                                                                   | Increment counter before award (atomic).                                                                                                                  |
| B1-06 | OPEN→FIXED       | RH/Base launch + dev buy                   | Second tx can fail after mint lives; UX partial.                                                              | Surface explicit “mint live, first buy failed” + navigate to token.                                                                                       |
| B1-07 | OPEN→FIXED       | Graduated tokens                           | “CURVE TRADING IS CLOSED” with no DEX link.                                                                   | Explorer / Uniswap link when pool address known; honest copy otherwise.                                                                                   |
| B1-08 | OPEN→FIXED (ops) | WalletConnect project id                   | Desktop RH Wallet disabled until configured.                                                                  | Staging sets `VITE_WALLETCONNECT_PROJECT_ID`.                                                                                                             |
| B1-09 | OPEN→FIXED       | `base-mints.ts` vs `SOLANA_CLUSTER=devnet` | Default Solana majors are mainnet mints.                                                                      | Cluster-aware defaults or boot fail-closed when overrides missing.                                                                                        |
| B1-10 | OPEN→FIXED       | Oracle graduation with `realBase == 0`     | Graduated but migrate always reverts.                                                                         | Require `realBase > 0` before marking graduated (both chains).                                                                                            |
| B1-11 | ACCEPT           | `StonkzRouter` permit value                | No `value >= amountToken` check; wrong permit size reverts sell.                                              | Require permit value ≥ sell size (defense in depth).                                                                                                      |
| B1-12 | OPEN→FIXED       | Profile fetch uses `WALLET.net`            | Viewing `0x` profile while on SOL hits wrong net.                                                             | Infer net from address shape.                                                                                                                             |
| B1-13 | OPEN→FIXED (ops) | Meteora config on Solana init              | Migration fails if `set_meteora_config` never run.                                                            | 2026-09-14: switched from Raydium CPMM to Meteora DLMM (`LBUZKhRx…` + PresetParameter2 index 1). Script: `programs/solana/scripts/set-meteora-config.ts`. |
| B1-14 | OPEN→FIXED       | EVM sell `permitTypedData.domain.name`     | Used indexed ticker (`BASEDOG`) instead of on-chain ERC-20 `name()` (`Base Dog`) → `bad signature` on permit. | `/trade/prepare` eth_calls `name()` for EIP-712 domain.                                                                                                   |
| B1-14 | ACCEPT           | `splitFee` float vs on-chain int           | Preview pie can drift.                                                                                        | Prefer curve-sim bigint for authoritative paths over time.                                                                                                |
| B1-15 | ACCEPT           | `circ() = supply × 0.8`                    | Display / staker fraction vs chain.                                                                           | Document for beta; wire reserve-derived circ later.                                                                                                       |

## P2

| ID    | Status     | Notes                                                                     |
| ----- | ---------- | ------------------------------------------------------------------------- |
| B2-01 | ACCEPT     | Crate HMAC (security M2) — keep odds disclosure, no “provably fair”.      |
| B2-02 | ACCEPT     | Legal copy placeholder; friends PnL “—”; X provider stub.                 |
| B2-03 | OPEN→FIXED | Stake modal still says “AWAITING PROGRAM DEPLOY” despite staging deploys. |
| B2-04 | OPEN→FIXED | Whale achievement copy ignores RH ETH threshold.                          |
| B2-05 | ACCEPT     | WS upgrade unrate-limited; `GET /rewards` without limit — add if abused.  |
| B2-06 | OPEN→FIXED | Footer HTML placeholder before JS disclosure.                             |

## Already-known plan blockers (tracked here)

| Item                                                   | Status                                    |
| ------------------------------------------------------ | ----------------------------------------- |
| Coinbase Base absent                                   | Phase 2 — add `Net='BASE'`, Sepolia 84532 |
| Funded integration harness never PASS                  | Phase 4                                   |
| Real Phantom / Robinhood Wallet unproven in product UI | Phase 4 manual smoke                      |
| Practice wallet off in prod                            | Keep gated                                |

## Beta invite gate

Zero **OPEN** P0/P1 remaining in code (ops checklist item **B1-13** Meteora
DLMM config is set on Global for Solana graduation). Base Sepolia contracts are
**deployed** (`84532.json`); funded harness **PASS**ed Solana + RH + Base
atomic round-trips (including EIP-2612 sells). Staging UI shows three nets
(`DEVNET / RH TESTNET / BASE SEPOLIA`) and Connect lists all three.

Still required before inviting live users: one **manual** real-wallet smoke
per net (Phantom / MetaMask·Coinbase / RH WalletConnect) — CI cannot drive
extensions or the Robinhood phone app.

Findings closed in this pass are marked FIXED above.
