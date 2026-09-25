# Rolling out the four-leg fee split (Phase 3)

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
