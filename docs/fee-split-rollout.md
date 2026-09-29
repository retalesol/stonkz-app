# Rolling out the four-leg fee split

> **Current schedule: v2, 69 / 15 / 10 / 6** (creator / platform / `$STONKZ`
> buyback / RWA crate fund). See "v2 rollout" at the end of this file. The
> sections below document the v1 (20 / 10 / 10 / 60) rollout for history.

The deployed testnets still settle 20 / 70 / 10. The code on
`phase1/net-registry` settles **20% protocol / 10% Stonkz Game buyback
(`stonkz_ops`) / 10% burn / 60% creator bucket** and the indexer refuses any
fill that does not match it. So the rollout order matters: **programs first,
then database, then indexer and API, then web.** Rolling the indexer before
the programs dead-letters every fill.

Old fills (before the upgrade) use the narrower event layout. They are
already indexed; a backfill over that range will not decode under the new
ABI. Acceptable on testnets; note the cut-over block in the deployment JSON.

## 0. Before you start

- `pnpm typecheck && pnpm test` green; `forge test` in `programs/evm`;
  `cargo test -p launchpad --lib` and `anchor build` in `programs/solana`
  (the IDL in `target/idl/launchpad.json` must carry `burn_vault`).
- A fresh deployer key with the admin role on each launchpad. The old
  testnet key is burned (`deployments/46630.json`).
- Announce a short trading pause on staging: between the program upgrade and
  the indexer roll, new fills are correct on chain but not yet indexed.

## 1. Programs

### Robinhood testnet (46630)

```
cd programs/evm
export PRIVATE_KEY=0x...                                   # launchpad admin
export LAUNCHPAD_ADDRESS=0x2588E500B1e5fCF18253F44b6f2607BF2B14161C
export EXPECT_CHAIN_ID=46630
forge script script/UpgradeLaunchpad.s.sol:UpgradeLaunchpad \
  --rpc-url https://rpc.testnet.chain.robinhood.com --broadcast -vvv
```

The script reads `stonkzBurn(address(0))` back through the proxy, so a
half-applied upgrade fails loudly. Record `newImpl` in
`deployments/46630.json` under the launchpad entry.

### Base Sepolia (84532)

```
export LAUNCHPAD_ADDRESS=0x02032371b6B2173211b8aa0Fa90c216d6a3a4E3A
export EXPECT_CHAIN_ID=84532
forge script script/UpgradeLaunchpad.s.sol:UpgradeLaunchpad \
  --rpc-url https://sepolia.base.org --broadcast -vvv
```

The `StonkzRouter` is immutable and unchanged by the split; it does not need
a redeploy (its new per-buy cap defaults to 0 = unlimited on both testnets).

### Solana devnet

```
cd programs/solana
anchor build
anchor deploy --provider.cluster devnet         # program id stays FF1f3V47…
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=~/.config/solana/deployer.json \
  pnpm exec tsx scripts/init-treasury.ts        # wrapped SOL burn vault
# then once per non-native base mint the deployment allows (USDC, stock tokens):
#   pnpm exec tsx scripts/init-treasury.ts <baseMint> [<baseMint> ...]
```

`buy` / `sell` pass `burn_vault` and revert until it exists for that curve's
base mint, so run `init-treasury.ts` for every base mint before lifting the
pause. Record `upgradeSignature` / `upgradedAt` in `deployments/devnet.json`.

## 2. Database (Neon, direct host)

```
pnpm --filter @stonkz/api migrate
```

Applies `0015_net_arc` (if not yet) and `0016_burn_vault`: the `burn`
treasury kind and a burn vault row per net. Idempotent.

## 3. Railway

`stonkz-indexer` and `stonkz-backend` redeploy from the branch. Env changes:

| Service | Key                       | Value                                                         | Why                                                                                                    |
| ------- | ------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| both    | `STONKZ_CHAINS_FILE`      | `apps/web/public/chains.json` (repo path inside the image)    | fills blank launchpad / router / program keys from the deployment record                               |
| both    | `STONKZ_ENV`              | `dev`                                                         | selects the dev block of that file                                                                     |
| indexer | `INDEXER_CHAIN_NETS`      | `SOL,RH,BASE` (unchanged; add `ARC` only after an Arc deploy) |                                                                                                        |
| indexer | `INDEXER_ARC_START_BLOCK` | leave unset until Arc is deployed                             | required only when `ARC` is in the list                                                                |
| api     | `ARC_*`                   | leave unset                                                   | the API refuses Arc trades and keeps 5042 off the SIWE allow-list until `ARC_LAUNCHPAD_ADDRESS` is set |

Roll the indexer first, then the API. Check
`https://stonkz-indexer-production.up.railway.app/health`: cursors advance,
`deadLetters` stays at 0. A rising dead-letter count right after the roll
means a program was not upgraded; stop and fix the program, the indexer will
retry the range.

## 4. Vercel

Push the branch; the production deploy builds from `main` once the PR
merges. Set `VITE_ENV=dev` (new; selects the `chains.json` block) next to the
existing `VITE_*` keys. Nothing else changes for the web.

## 5. Verify

- Buy and sell one coin per net. On the token page, FEES shows the four legs
  and `GET /tokens/:sym/fees?net=…` returns them; `treasury_credits` gains a
  `burn` row per fill.
- `GET /treasuries` lists three vaults per net.
- The Rust and Foundry suites already assert the split on every fill; the
  funded harness (`apps/api/integration`) is the end-to-end check.

## What this does not do yet

- Referrals are still settled by the API from the protocol leg (Phase 3b adds
  the on-chain `referrer` argument for the 15% tier).
- The game and burn vaults accrue in native units. Sweeping them into
  `$STONKZ` needs the token deployed per net (`StonkzProtocolToken.sol`,
  script exists for RH) and the keeper (`apps/api/src/jobs/sweep.ts`, not yet
  written). Until then the vaults simply grow, withdrawable by the ops
  authority through `withdrawTreasury(1|2, …)` / `Treasury::{Ops,Burn}`.

## Incident, 2026-09-27: shifted storage on RH 46630 and Base 84532

The first fee-split implementation (`0xA947…Ca9C` on RH, `0x4F01…0890` on
Base) declared `stonkzBurn` before `admin`, so behind both proxies every
variable from `admin` on reads one slot late: `admin()` returns zero,
`pendingAdmin()` returns the protocol withdraw authority, and so on. No
transaction touched either proxy under that implementation, so the stored
values are intact.

Recovery is `script/RecoverLaunchpadLayout.s.sol`, run once per chain with two
keys: the old protocol withdraw authority (`RECOVERY_KEY`, which the shifted
implementation accepts as `pendingAdmin`) and the admin (`PRIVATE_KEY`). It
takes admin through `acceptAdmin`, upgrades to the append-only implementation,
then has the admin restore the protocol authority and clear `pendingAdmin`.
`test/fork/RecoverLayout.t.sol` replays it on a fork of either proxy.

Rule going forward, pinned by `test_StorageLayoutIsAppendOnly`: new state on
`StonkzLaunchpad` goes after the last declared variable, `_lock` (slot 15, the
reentrancy guard; a variable inserted above it freezes every entry point),
never next to its siblings, and `forge inspect StonkzLaunchpad storage-layout`
is diffed against the deployed source before any `upgradeToAndCall`.

**Outcome (2026-09-27).** The protocol withdraw authority key was not held, so
both proxies were abandoned and fresh stacks deployed: RH launchpad
`0xe308…28e8` (block 124871527) and Base Sepolia `0x2f19…4D35` (block
47348724), recorded in `programs/evm/deployments/`. `reset-net RH BASE` wiped
the chain-derived rows, Railway and Vercel point at the new addresses, and
the indexer walks both chains from the new deploy blocks with no dead letters.
Solana devnet was upgraded in place (slot 504567336) with the burn vault seeded.

## Router redeploy, 2026-09-27 (pre-smoke audit)

The audit found two router bugs, fixed in `StonkzRouter.sol` and covered by
`test_ACurveCappingEthBuyRefundsTheRemainder`,
`test_ACurveCappingAggregatorBuyRefundsTheBase` and
`test_AFrontRunPermitStillSellsOnTheAllowance`:

- a buy larger than the curve's remaining allocation left the unspent base
  stranded in the router (it has no rescue function by design);
- a permit replayed by a front-runner made the sell revert instead of
  falling through to the allowance it had just granted.

The router is immutable, so the fix is a new router bound to the same
launchpad: `script/DeployRouter.s.sol` (now chain-generic) with
`LAUNCHPAD_ADDRESS` and `EXPECT_CHAIN_ID`, then `RH_ROUTER_ADDRESS` /
`BASE_ROUTER_ADDRESS` on both Railway services, the `StonkzRouter` entry in
`deployments/<chainId>.json`, `node scripts/emit-chains.mjs`, and a roll of
indexer, API and web. Until that lands, keep smoke-test buys small relative
to what the curve has left.

## v2 rollout: 69 / 15 / 10 / 6 (2026-09-28)

| Leg            | v1 bps            | v2 bps            | On-chain name (unchanged)                | v2 meaning                                  |
| -------------- | ----------------- | ----------------- | ---------------------------------------- | ------------------------------------------- |
| Creator bucket | remainder (6,000) | remainder (6,900) | `creator_bucket`                         | creator, stakers up to half (34.5% of fee)  |
| Platform       | 2,000             | 1,500             | `protocol` / protocol vault              | platform revenue                            |
| Buyback        | 1,000             | 1,000             | `stonkz_ops` / `ops_vault` / `stonkzOps` | buys `$STONKZ`: half to crates, half burned |
| RWA crate fund | 1,000             | 600               | `burn` / `burn_vault` / `stonkzBurn`     | buys real-world assets for crates           |

The Stonkz Game is removed; the vault that funded it is the buyback vault.
Vault accounts, seeds and event field names do not change, so no new PDAs,
no storage-layout change on the EVM proxies, and no ABI change for the
indexer. The database renames the kinds (`stonkz_ops` to `buyback`, `burn`
to `rwa`) in migration 0018, which also retires Stonk Optionz in favour of
`$STONKZ` reward credits and adds `rwa_rewards`.

Order, and why it is safe in any order this time: the indexer accepts a fill
that matches **either** the v1 or the v2 split (`LEGACY_V1_SPLIT_BPS` in
`apps/indexer/src/chain/market.ts`) while the programs are upgraded, so web,
API, migration and indexer ship first and the programs follow.

1. Web, API (runs migration 0018), indexer: `railway up` both services, `vercel --prod`.
2. EVM, per chain (admin key):

```
cd programs/evm
LAUNCHPAD_ADDRESS=0xe308287C9A85E2B53F1027a1c589B5e3969928e8 EXPECT_CHAIN_ID=46630 \
  forge script script/UpgradeLaunchpad.s.sol:UpgradeLaunchpad --rpc-url https://rpc.testnet.chain.robinhood.com --broadcast -vvv
LAUNCHPAD_ADDRESS=0x2f197741C3ca71e3FE885a4F74C0D44e3A774D35 EXPECT_CHAIN_ID=84532 \
  forge script script/UpgradeLaunchpad.s.sol:UpgradeLaunchpad --rpc-url https://sepolia.base.org --broadcast -vvv
```

Before broadcasting, `forge inspect StonkzLaunchpad storage-layout` must be
identical to the deployed source (v2 changes constants only). 3. Solana devnet (upgrade authority wallet): `anchor build` then
`solana program deploy target/deploy/launchpad.so --program-id FF1f3V47FtApwWWMHX462Gm7NVqNpUJ7K4yqKrYGSMbg -u devnet`.
No `init-treasury` run: the vaults already exist. 4. Verify one buy per chain lands 69 / 15 / 10 / 6 in the Fees tab, then
remove `LEGACY_V1_SPLIT_BPS` from the indexer and redeploy it.

**Step 4 status (2026-09-29).** `LEGACY_V1_SPLIT_BPS` and the `'v1'` branches
are removed; the indexer dead-letters anything but the integer 15 / 10 / 6 / 69
split. Evidence, read off the chains (`scripts/reconcile-fees.ts` repeats it):

| Net        | Programs at v2 since | Fills since the 09-27 redeploy / layout upgrade                                    |
| ---------- | -------------------- | ---------------------------------------------------------------------------------- |
| Base 84532 | block 47423325       | 1 coin (MEMEMAN); lifetime ledgers are an exact 15 / 10 / 6 / 69 split — all v2    |
| RH 46630   | block 125797509      | `tokenCount() == 0`: no launch, so no fill of either split                         |
| SOL devnet | slot 505228004       | no fill since the four-leg layout; the 13 older fills predate it and do not decode |

So no v1-split fill exists in any range the indexer can ingest, on any net,
and the fallback could never fire. RH and Solana still await their first
live v2 buy; `pnpm exec tsx scripts/reconcile-fees.ts --net RH|SOL --mint …`
checks it when one lands.
