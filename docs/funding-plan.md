# Mainnet funding plan

Prepared 2026-10-01 from live reads (ETH ≈ $2,693, SOL ≈ $118; RH gas 0.0209 gwei, Base gas 0.006 gwei; Solana rent-exemption 0.00000696 SOL/byte).
Every figure below is what a key must hold **before** the step that spends it; most are
one-off. Nothing here is protocol revenue — the treasuries fill themselves from fees.

## Current state of the keys we have (all effectively empty on mainnet)

| Key           | Role today                  | RH 4663      | Base 8453     | Solana mainnet |
| ------------- | --------------------------- | ------------ | ------------- | -------------- |
| `0x1FA9…Bdca` | testnet admin / deployer    | 0.00100 ETH  | 0.00100 ETH   | —              |
| `0xFf88…4879` | protocol withdraw authority | 0.000001 ETH | 0.0000006 ETH | —              |
| `EJ9q…ADLn`   | devnet upgrade authority    | —            | —             | 0 SOL          |

The mainnet deployer should be a **fresh hardware-wallet key** (`--ledger`), not `0x1FA9`
(see `docs/deployment.md` §2.1). The fork rehearsal (`test/fork/MainnetDeployFork.t.sol`,
passed on both chains 2026-10-01) measured the full stack plus a complete user journey at
**61.4 M gas on RH and 61.2 M gas on Base**; the broadcast itself is ~50 M of that.

## One-off: deployment

| Who pays                                                               | What                                                                                                                                                                                                           | RH 4663                                                                     | Base 8453                                                                                       | Solana                                                                     |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Deployer                                                               | `DeployMainnet` (11 contracts + timelock handover)                                                                                                                                                             | 61 M gas ≈ 0.0013 ETH; **fund 0.05 ETH (~$135)** for gas spikes and retries | 61 M gas ≈ 0.0004 ETH + L1 data fee (~$5–15 for ~150 KB of bytecode); **fund 0.05 ETH (~$135)** | —                                                                          |
| Deployer                                                               | Verification, `emit-chains`, smoke launch + buy + sell + graduate (see §2.3)                                                                                                                                   | included above                                                              | included above                                                                                  | —                                                                          |
| Upgrade authority (Squads vault, or the deployer that then hands over) | `solana program deploy` of the 853,840 B program: ProgramData rent **4.37 SOL (~$515)** + a write buffer of **4.34 SOL (~$511)** held only during the deploy and reclaimed by `solana program close --buffers` | —                                                                           | —                                                                                               | **fund 10 SOL (~$1,178)** (≈4.4 stays locked as rent; the rest comes back) |
| Admin                                                                  | `init-deployment.ts` (Global, params PDA, pauser PDA, protocol/ops/burn vaults for every base mint, referral config) ≈ 0.02 SOL rent + fees                                                                    | —                                                                           | —                                                                                               | 0.1 SOL (~$12)                                                             |
| Operator                                                               | Launch address-lookup table (`create-launch-alt.ts`, 12+ entries)                                                                                                                                              | —                                                                           | —                                                                                               | 0.02 SOL (~$2)                                                             |

Pyth price updates cost **0 wei** on both RH and Base today (`getUpdateFee` on the live
contracts); the in-transaction Hermes updates every launch posts are free beyond gas.

## Standing: operational keys

| Key                                      | Spends on                                                                                                                                                                               | Per action                                       | Hold                                                                                  | Refill trigger    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------- | ----------------- |
| Pauser (hot, EVM ×2)                     | `pause(...)` only                                                                                                                                                                       | ~60 k gas                                        | 0.01 ETH (~$27) per chain                                                             | never below 0.005 |
| Pauser (hot, Solana)                     | `pause` only                                                                                                                                                                            | 5 k lamports                                     | 0.05 SOL (~$6)                                                                        | —                 |
| Migration authority (EVM ×2)             | `migrateLiquidity` per graduation (V3 pool create + mint + lock) ≈ 1.5–2 M gas                                                                                                          | ≈ 0.00004 ETH (RH) / 0.00002 ETH + L1 fee (Base) | 0.02 ETH (~$54) per chain                                                             | at 50 graduations |
| Migration authority (Solana)             | `migrate_create_pool` + `migrate_seed_liquidity`: LbPair + oracle + reserves rent ≈ 0.03 SOL paid directly, plus 0.15 SOL fronted through the escrow and mostly refunded in the same tx | ≈ 0.05 SOL net per graduation                    | 1 SOL (~$118)                                                                         | at 15 graduations |
| Safe (timelock proposer, EVM ×2)         | schedule/execute: `setParams`, `setConfig`, unpause, upgrades                                                                                                                           | ~150–300 k gas each                              | 0.02 ETH (~$54) per chain inside the Safe (signers pay from their own keys otherwise) | yearly            |
| Squads vault (Solana admin)              | `set_params`, `set_pause`, `set_pauser`, program upgrades (upgrade = new buffer rent 4.34 SOL (~$511), reclaimed)                                                                       | 5 k lamports; upgrades need the buffer           | 0.5 SOL (~$59) + 5 SOL (~$589) parked for the first upgrade                           | per upgrade       |
| Ops withdraw authority (EVM ×2, Solana)  | `withdrawTreasury` sweeps (buyback + RWA legs)                                                                                                                                          | ~80 k gas / 5 k lamports                         | 0.01 ETH (~$27) per chain, 0.05 SOL (~$6)                                             | quarterly         |
| Protocol withdraw authority              | `withdrawTreasury(0, …)`                                                                                                                                                                | ~80 k gas                                        | 0.01 ETH (~$27) per chain, 0.05 SOL (~$6)                                             | quarterly         |
| API referral signer (`0x104D…`, `rwp1…`) | signs vouchers only, never transacts                                                                                                                                                    | 0                                                | **0**                                                                                 | —                 |
| API stock attester (`0x7DB8…`)           | signs attestations only                                                                                                                                                                 | 0                                                | **0**                                                                                 | —                 |

Users pay their own gas for launches, trades, stakes, claims and `graduate`; the router's
`graduateWithPriceUpdate` makes graduation a user action, so no keeper is budgeted.

## Seed money (optional, product decisions)

| Pool                                                                         | Purpose                                                         | Suggested seed                            | Notes                                                                                                                                            |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Referral vaults (`ReferralVault` on RH/Base, `referral_vault` PDA on Solana) | Pays self-serve referral claims before protocol revenue accrues | 0.1 ETH (~$269) per chain, 1 SOL (~$118)  | Otherwise the first claims wait for the first `withdrawTreasury(0)` → vault top-up; `REFERRAL_MAX_PER_DAY` caps exposure (1 ETH/day on testnet). |
| Launch buy cap                                                               | Not money, but decide `MAX_BUY_NATIVE` for day one              | 0 = uncapped (changeable via `setConfig`) | A cap of 2–5 ETH limits early-curve sniping; see `docs/parameters.md`.                                                                           |
| Dev-buy for the house launches ($STONKZ / showcase coins)                    | Marketing, not infrastructure                                   | your call                                 | Comes from the launcher wallet, not any key above.                                                                                               |

## Totals to fund before launch day

| Chain                   | Infrastructure (one-off + standing)                                                                                | With optional referral seed |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| RH 4663                 | 0.13 ETH (~$350) (deployer 0.05, pauser 0.01, migration 0.02, Safe 0.02, ops 0.01, protocol 0.01, slack 0.01)      | 0.23 ETH (~$619)            |
| Base 8453 (if it ships) | 0.13 ETH (~$350)                                                                                                   | 0.23 ETH (~$619)            |
| Solana                  | 16.7 SOL (~$1,967) (deploy 10 of which ~5.6 returns, init 0.1, ALT 0.02, migration 1, Squads 5.5, pausers/ops 0.1) | 17.7 SOL (~$2,084)          |

Not on-chain but recurring: QuickNode (six endpoints), Railway (API + indexer), Vercel, Neon,
Upstash/Redis, Pinata — already in place for testnet; mainnet traffic is the only variable.

## Order of operations on the day

1. Fund the deployer (EVM) / upgrade authority (Solana) per the first table.
2. EVM: dry-run `DeployMainnet`, broadcast, verify, `emit-chains`, smoke (deployment.md §2.1–2.3).
3. Solana: `solana program deploy` → `init-deployment.ts` → `create-launch-alt.ts` → `mainnet-guard.ts` handover to Squads.
4. Move every standing-key balance per the second table; park the Squads upgrade buffer.
5. Flip Railway/Vercel env (`docs/mainnet-readiness.md` §"API / indexer / web"), unset `STONKZ_STAGING`.
6. Seed the referral vaults if chosen; set `MAX_BUY_NATIVE` through `setConfig` if not 0.
