# EVM governance: single EOA → multisig + timelock, with an instant pauser

Status: **scripted and tested, not broadcast.**

| What            | Where                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Handover script | `programs/evm/script/GovernanceHandover.s.sol`                                                                                  |
| Shared logic    | `programs/evm/script/GovernanceLib.sol` (also used by the mainnet deploys)                                                      |
| Mainnet guard   | `programs/evm/script/MainnetGuard.sol`                                                                                          |
| Tests           | `test/Governance.t.sol`, `test/Pauser.t.sol`, `test/MainnetGuard.t.sol`, `test/fork/RolloutFork.t.sol` (live proxies on a fork) |

## Why

On RH testnet (46630) and Base Sepolia (84532) one EOA,
`0x1FA9D4Ad76D53FbF1274d10ACBA12463ae90Bdca`, holds all of these powers:

| Power                  | Where                                                           | What it can do                                                                                                                                                                                       |
| ---------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin`                | `StonkzLaunchpad` proxy (slot 5)                                | `upgradeToAndCall` (which can replace all logic and take every balance), `setPause`, `setPauser`, `setMigrator`, `setWithdrawAuthorities`, `setPriceSource`, `setMaxOracleStaleness`, `proposeAdmin` |
| `admin`                | `PushPriceSource` proxy (slot 0), and the new `PythPriceSource` | upgrade (push oracle only), feed configuration, `setOracleAuthority`                                                                                                                                 |
| `oracleAuthority`      | `PushPriceSource`                                               | push any price                                                                                                                                                                                       |
| `opsWithdrawAuthority` | launchpad                                                       | withdraw the ops (`which = 1`) and RWA-crate (`which = 2`) treasuries                                                                                                                                |
| `migrationAuthority`   | launchpad                                                       | `migrateLiquidity`                                                                                                                                                                                   |

Its key may have been shared in chat. The notes in `deployments/*.json` already treat the deployer key as burned for mainnet. Every one of these powers moves as follows:

- **admin** (the launchpad and every price source) goes to an OpenZeppelin `TimelockController` (v5.7, `lib/openzeppelin-contracts`).
  - Its only proposer and canceller is the team Safe.
  - It administers itself, with no separate admin role.
- **pauser** goes to a new launchpad role, `pauser` (storage slot 16, appended after `_lock`).
  - The pauser can only _set_ pause flags, and it is deliberately **not** behind the timelock, so a stop is instant.
  - It can never unpause, withdraw, upgrade or change configuration. Unpausing stays with admin, meaning the timelock.
- **ops-withdraw** and **migration** authorities go to new addresses you choose.
- The protocol-withdraw authority (`0xFf88…4879`) stays as is unless you set `PROTOCOL_WITHDRAW_AUTHORITY`.

These contracts have no admin at all: `StonkzRouter`, `UniswapV2Migrator`, `StonkzV2Factory` and `StonkzToken`. None of them has a pause switch either. The launchpad's pause stops every router path, because the router only reaches a curve through the launchpad. The router's per-buy cap is an immutable, not a switch.

## The emergency pauser

```
launchpad.pause(bool trading, bool launch, bool protocolWithdrawals, bool opsWithdrawals, bool oracleGraduation)
```

- Callable by `pauser` (or `admin`).
- Each `true` sets that flag. `false` leaves the flag as it is; it never clears it.
- Unpausing is `setPause(...)`, which only the admin can call. After the handover that means a timelocked operation, which waits `MIN_DELAY`.
- `setPauser(address)` is admin-only. `address(0)` means no pauser. It emits `PauserSet`.

A leaked pauser key can at worst halt the launchpad until governance unpauses it. For that reason the pauser should be a hot ops key or a separate 1-of-N Safe, not the governance Safe behind the timelock.

## Before you run the handover

1. **A Safe on the chain.** This is `PROPOSERS`. Also decide `EXECUTORS`:
   - the Safe too (the default), or
   - `0x0000000000000000000000000000000000000000`, which lets anyone execute a proposal once its delay has passed.
2. **`MIN_DELAY`, in seconds.** It must be at least 86400 on mainnet. Every admin action, including an unpause, waits this long. Pausing does not.
3. **`PAUSER`.** Required. It may not be the old EOA.
4. **`NEW_OPS_WITHDRAW_AUTHORITY` and `NEW_MIGRATION_AUTHORITY`.** Neither may be the old EOA; the script refuses.
5. **The launchpad must already run the implementation that has `pauser`.** That is `UpgradeAtomicLaunch.s.sol`, step 2 of the testnet order below. The handover refuses otherwise.

## Testnet rollout order (RH 46630, then Base Sepolia 84532)

Every step is a dry run first (without `--broadcast`), then the same command with `--broadcast`.

`PRIVATE_KEY` is the current admin EOA. It must be exported for every step, dry runs included, because the scripts derive the signer from it.

Run from `programs/evm`:

```sh
cd programs/evm
export PRIVATE_KEY=0x...          # current admin EOA

# RH testnet
export RPC=https://rpc.testnet.chain.robinhood.com LAUNCHPAD_ADDRESS=0xe308287C9A85E2B53F1027a1c589B5e3969928e8 EXPECT_CHAIN_ID=46630
# Base Sepolia
# export RPC=https://sepolia.base.org LAUNCHPAD_ADDRESS=0x2f197741C3ca71e3FE885a4F74C0D44e3A774D35 EXPECT_CHAIN_ID=84532
```

**1. Tests.**

```sh
forge build --sizes && forge test
```

Optionally run the fork rehearsal of steps 2 to 6 against the live proxy:

```sh
ROLLOUT_FORK_RPC=$RPC ROLLOUT_FORK_PROXY=$LAUNCHPAD_ADDRESS forge test --match-path test/fork/RolloutFork.t.sol -vv
```

**2. New router + implementation + PythPriceSource, with the price source NOT switched yet.** Set `PAUSER` here too if you want it before the handover:

```sh
SWITCH_PRICE_SOURCE=false PAUSER=0x<pauser> \
  forge script script/UpgradeAtomicLaunch.s.sol:UpgradeAtomicLaunch --rpc-url $RPC -vvv
# then append --broadcast
```

Record `NEW StonkzRouter` and `NEW PythPriceSource` from the log.

**3. Point the API, web and indexer at `NEW StonkzRouter`.** Every launch must go through `createAndBuyWithEth` or `createWithPriceUpdate` with a Hermes `priceUpdate`. Also record the new addresses in `deployments/<chainId>.json`.

**4. Only then, switch pricing to Pyth.** The staleness bound defaults to 120 s:

```sh
PRICE_SOURCE=0x<NEW PythPriceSource> \
  forge script script/SwitchPriceSource.s.sol:SwitchPriceSource --rpc-url $RPC -vvv
# then append --broadcast
```

From here on, a launch without an in-transaction update is refused as `stale oracle`.

**5. Griefing-proof migrator.** On testnets this also deploys a new `StonkzV2Factory`:

```sh
forge script script/DeployMigrator.s.sol:DeployMigrator --rpc-url $RPC -vvv
# then append --broadcast
```

**6. Governance handover.** This sets the pauser, rotates the authorities and hands admin to the timelock:

```sh
PROPOSERS=0x<safe> MIN_DELAY=172800 PAUSER=0x<pauser> \
NEW_OPS_WITHDRAW_AUTHORITY=0x... NEW_MIGRATION_AUTHORITY=0x... \
  forge script script/GovernanceHandover.s.sol:GovernanceHandover --rpc-url $RPC -vvv
# then append --broadcast
```

**7. Verify** (next section). After step 6, steps 2, 4 and 5 still work: run by a non-admin, they deploy and print the batch for the Safe to schedule through the timelock.

## What the handover broadcast does

It runs these steps in order, all signed by the EOA:

1. Deploys `TimelockController(minDelay, proposers, executors, admin = 0)`.
   - Proposers are also cancellers.
   - No address other than the timelock itself holds `DEFAULT_ADMIN_ROLE`.
2. Configures the launchpad:
   - `setWithdrawAuthorities(PROTOCOL, NEW_OPS)`
   - `setMigrator(MIGRATOR, NEW_MIGRATION)`
   - `setPauser(PAUSER)`
3. Handles price sources. By default these are the launchpad's `priceSource()` plus its `fallbackSource()` if it has one. A pre-handover `PushPriceSource` is upgraded in place so that it gains a two-step admin. The new variable `pendingAdmin` packs into unused bytes of slot 4, and a test pins it.
4. Calls `proposeAdmin(timelock)` on the launchpad and on every price source.
5. Accepts, according to `HANDOVER_MODE`:

### `HANDOVER_MODE=atomic` (default, recommended; the only mode on mainnet)

The timelock is created with delay `0` and the EOA as a _temporary_ proposer and executor. In the same broadcast it schedules and executes one batch:

```
launchpad.acceptAdmin()
priceSource.acceptAdmin()          (one per price source)
timelock.updateDelay(MIN_DELAY)
```

Then the EOA calls `renounceRole` for `PROPOSER_ROLE`, `CANCELLER_ROLE` and `EXECUTOR_ROLE`. **The Safe does not need to accept anything.**

### `HANDOVER_MODE=propose`

The timelock is created with `MIN_DELAY`. The EOA stays admin until the Safe sends two transactions to the **timelock**, `MIN_DELAY` apart. The script prints both calldatas:

```
salt        = 0x42de6d78772e9b9320287bdf51e9152201e92d3d4e1fbe9625394a6d0275ce2d   (keccak256("stonkz.governance-handover.v1"))
predecessor = 0x0
targets     = [LAUNCHPAD_PROXY, PRICE_SOURCE_1, (PRICE_SOURCE_2)]
values      = [0, 0, (0)]
payloads    = [0x0e18b681, 0x0e18b681, (0x0e18b681)]      // acceptAdmin()

Safe tx 1 → timelock.scheduleBatch(targets, values, payloads, predecessor, salt, MIN_DELAY)   // 0x8f2a0bb0
   … wait MIN_DELAY …
Safe tx 2 → timelock.executeBatch(targets, values, payloads, predecessor, salt)              // 0xe38335e5
```

To do this in the Safe UI, use the Transaction builder:

- Contract: the timelock address.
- ABI: OpenZeppelin `TimelockController`.
- Call `scheduleBatch`, then `executeBatch` after the delay.

Until tx 2 lands, the old EOA can still act as admin.

## Verify

```sh
TL=0x...   # from the script log
cast call $LAUNCHPAD_ADDRESS "admin()(address)"                --rpc-url $RPC   # == $TL
cast call $LAUNCHPAD_ADDRESS "pendingAdmin()(address)"         --rpc-url $RPC   # == 0x0
cast call $LAUNCHPAD_ADDRESS "pauser()(address)"               --rpc-url $RPC   # == PAUSER
cast call $LAUNCHPAD_ADDRESS "opsWithdrawAuthority()(address)" --rpc-url $RPC
cast call $LAUNCHPAD_ADDRESS "migrationAuthority()(address)"   --rpc-url $RPC
cast call $PRICE_SOURCE "admin()(address)"                     --rpc-url $RPC   # == $TL (each source)
cast call $TL "getMinDelay()(uint256)"                         --rpc-url $RPC   # == MIN_DELAY
# the old EOA holds no timelock role; all four print false:
for r in 0xb09aa5aeb3702cfd50b6b62bc4532604938f21248a27a1d5ca736082b6819cc1 \
         0xd8aa0f3194971a2a116679f7c2090f6939c8d4e01a2a8d7e41d55e5351469e63 \
         0xfd643c72710c63c0180259aba6b2d05451e3591a24e58b62239378085726f783 \
         0x0000000000000000000000000000000000000000000000000000000000000000; do
  cast call $TL "hasRole(bytes32,address)(bool)" $r 0x1FA9D4Ad76D53FbF1274d10ACBA12463ae90Bdca --rpc-url $RPC
done   # PROPOSER, EXECUTOR, CANCELLER, DEFAULT_ADMIN
```

Record the timelock, the Safe, the pauser and the rotated authorities under `authorities` in `programs/evm/deployments/<chainId>.json`.

## Governing afterwards

| Action                              | Who      | How                                                                                                                                                  |
| ----------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pause                               | pauser   | `launchpad.pause(...)` directly. Instant.                                                                                                            |
| Unpause, and every other admin call | the Safe | `timelock.schedule(target, 0, data, 0x0, salt, MIN_DELAY)`, wait `MIN_DELAY`, then an executor calls `timelock.execute(target, 0, data, 0x0, salt)`. |

Example: to unpause, schedule a call to `launchpad.setPause(false, false, false, false, false)`.

The Safe can `cancel(id)` anything pending. Changing the delay is itself a timelocked `updateDelay`, and so is changing the pauser (`setPauser`).

## Stock bases (TSLA, AMZN, PLTR, NFLX, AMD)

Stock tokens trade on DEXs 24/7, but Pyth's `Equity.US.*` feeds only publish in US market hours. `StockPriceSource` prices a stock base from a Uniswap V3 TWAP (stock/WETH, 30 min, times Pyth ETH/USD) and cross-checks it against the equity feed when that is fresh; if the two disagree by more than `MAX_DEVIATION_BPS` it returns no price. It sits behind the live `PythPriceSource` as its `fallbackSource`, so the launchpad needs no call and no storage change, and nobody has to push prices. The old `PushPriceSource` stays behind it as the last resort. `createAndBuyViaV3` on a new router launches a stock-base coin and dev-buys it with ETH in one transaction.

**Off hours, the last close is an anchor.** When the equity feed is stale but its last print is at most 4 days old (`ANCHOR_MAX_AGE`, long enough to cover a long weekend), two things change:

- The TWAP runs over 2 hours (`OFF_HOURS_TWAP_SECS`) instead of 30 minutes.
- The TWAP must stay within 15% (`OFF_HOURS_MAX_MOVE_BPS`) of that last print. Outside that range the source returns no price and does not fall back. Launches and the oracle graduation trigger then refuse (`stale oracle`) until the pool comes back.

If the pool's observation history does not reach 2 hours back, the TWAP counts as unavailable off hours. No shorter window is tried: anyone could churn the history to force one. For a pool that trades in most blocks, raise `OBSERVATION_CARDINALITY` in step 2. With no anchor at all (the feed was never posted, as on RH testnet today, or the last print is over 4 days old), the TWAP prices as before: 30 minutes, gated by the liquidity floor and the band.

The steps run from `programs/evm`, with the same `PRIVATE_KEY`, `RPC`, `LAUNCHPAD_ADDRESS` and `EXPECT_CHAIN_ID` exports as the rollout above. Do a dry run first, then append `--broadcast`.

**0. Tests, and a rehearsal on a fork of the live chain.**

```sh
forge build --sizes && forge test
STOCK_FORK_RPC=$RPC forge test --match-path test/fork/StockLaunchFork.t.sol -vv
```

**1. New router and implementation** (`createAndBuyViaV3`). Only the implementation's `trustedRouter` changes, and the storage layout does not:

```sh
forge script script/UpgradeStockLaunch.s.sol:UpgradeStockLaunch --rpc-url $RPC -vvv
```

As soon as this lands, the previous router can no longer launch (`not router`). Switch `RH_ROUTER_ADDRESS` in the API and web to `NEW StonkzRouter` in the same window. Also add it to the indexer's `AtomicBuy` sources and record it, with the new implementation, in `deployments/46630.json`.

**2. Deploy the stock price source.** This configures the five stocks from `src/config/StockBases.sol`, calls `increaseObservationCardinalityNext(64)` on each pool, and sets `PythPriceSource.setFallbackSource`:

```sh
forge script script/DeployStockPriceSource.s.sol:DeployStockPriceSource --rpc-url $RPC -vvv
```

Steps 1 and 2 are independent. Until a pool is seeded, its stock falls through to the push oracle exactly as it does today.

Step 2's defaults per stock come from `src/config/StockBases.sol`. Each env var below overrides the value for every stock:

| Env                       | Default         |
| ------------------------- | --------------- |
| `TWAP_SECS`               | 1800            |
| `MIN_LIQUIDITY`           | `1e17`          |
| `STOCK_PYTH_MAX_AGE`      | 120             |
| `MAX_DEVIATION_BPS`       | 500             |
| `ANCHOR_MAX_AGE`          | 345600 (4 days) |
| `OFF_HOURS_MAX_MOVE_BPS`  | 1500            |
| `OFF_HOURS_TWAP_SECS`     | 7200            |
| `OBSERVATION_CARDINALITY` | 64              |

**3. Seed each pool.** The testnet pools exist but sit at a placeholder 1:1 price with no liquidity. Get stock tokens from Robinhood's testnet faucet into the signer's wallet. Then, for each stock, give the current share price and the ETH price:

```sh
STOCK_TOKEN=0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E STOCK_USD_1E6=250000000 QUOTE_USD_1E6=4000000000 \
STOCK_PRICE_SOURCE=0x<NEW StockPriceSource> \
  forge script script/SeedStockPool.s.sol:SeedStockPool --rpc-url $RPC -vvv
```

The script does two things:

- It moves an empty pool to the reference price at no cost.
- It mints a full-range position from the whole stock balance (`STOCK_AMOUNT`) plus the matching WETH, wrapping ETH for any shortfall. The signer owns the position.

The log says whether the liquidity clears `MIN_LIQUIDITY` (default `1e17`). **Wait 30 minutes** after seeding: a pool counts only once its whole TWAP window has had liquidity in it.

**4. Check.** Each `legs` call returns the TWAP and Pyth prices. `priceUsd1e6` returns what a launch would snapshot:

```sh
cast call 0x<NEW StockPriceSource> "legs(address)" 0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E --rpc-url $RPC
cast call 0x4DF51B8a92ce0c634Cd4bb7a799f8762A800cecA "priceUsd1e6(address)(uint256,uint256,uint256)" 0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E --rpc-url $RPC
```

The WETH leg comes from Pyth ETH/USD, which has a 120 s tolerance. The app's `priceUpdate` for a stock-base launch must therefore include **ETH/USD**, and, in market hours, the stock's equity feed.

**Base, later.** Add a branch for the chain to `StockBases.forChain()` with each stock token's address and its stock/WETH V3 pool. Create a pool with `UniswapV3Factory.createPool` if none exists, then seed it. The feed ids and bands are the same on every chain. Then run steps 1 to 3 against Base. On Base mainnet (8453), `MainnetGuard` applies: the scripts deploy and configure, then print the `setFallbackSource` and `acceptAdmin` calls for the timelock. `SeedStockPool` is a testnet-only tool.

## Mainnet guard

Testnets may skip the multisig, but mainnet may not. Every deploy or upgrade script that can target a mainnet chain (RH 4663, Base 8453, Arc 5042) calls `MainnetGuard.requireOnMainnet()` before anything else. The scripts are:

- `Deploy`, `DeployArc`
- `DeployRouter`, `DeployMigrator`
- `UpgradeAtomicLaunch`, `UpgradeStockLaunch`, `UpgradeLaunchpad`, `SwitchPriceSource`
- `DeployStockPriceSource`
- `GovernanceHandover`

The guard reverts with the name of what is missing, for example `MainnetGuard: PAUSER is required on mainnet`. It requires:

- `PROPOSERS` (the Safe; no zero entry)
- `MIN_DELAY` of at least 86400
- `PAUSER`
- `NEW_OPS_WITHDRAW_AUTHORITY`
- `NEW_MIGRATION_AUTHORITY`

How the two kinds of script behave on mainnet:

- **Fresh deploys** (`Deploy` on 4663, `DeployArc`) make the signer admin only for the length of the broadcast.
  - They wire everything, including the feeds, migrator and trusted router.
  - Then they run `GovernanceLib.handover` in atomic mode, so when the broadcast lands, admin is held by the timelock and no EOA holds any role.
  - `Deploy` on 4663 needs a single signer (`--ledger`, `--private-key`, or `--account` with `--sender`) and also reads `STONKZ_PROTOCOL_WITHDRAW_AUTHORITY`.
- **Upgrade scripts** (`UpgradeAtomicLaunch`, `UpgradeStockLaunch`, `UpgradeLaunchpad`, `DeployMigrator`, `SwitchPriceSource`, `DeployStockPriceSource`, and `DeployRouter`, which binds to the proxy) first require `MainnetGuard.requireTimelockAdmin`. That check requires:
  - the launchpad admin is a `TimelockController` with a delay of at least 24 h;
  - `PROPOSERS` hold the proposer role;
  - the launchpad's ops and migration authorities and its pauser match the env.

  They then deploy and **print the timelock calldata**. They never call the proxy directly.

## Not covered by the script

- `PushPriceSource.oracleAuthority` is also the old EOA on both testnets. After the Pyth switch, the push oracle only prices bases Pyth does not cover (the RH testnet stock tokens), as a fallback. Rotate it through the timelock with `setOracleAuthority`, or stop relying on it.
- `StonkzProtocolToken`'s own admin, which `DeployStonkzProtocolToken.s.sol` sets.
- The deployer EOA's funds and any other contracts it owns.

## Decisions for the team

- **`EXECUTORS`:** Safe-only (the default), or open (`0x0`).
- **Pauser custody:** a hot ops key, or a separate 1-of-N Safe.
- **`MIN_DELAY`:** 48 h is suggested, with a floor of 24 h on mainnet.

## Solana

The Solana launchpad has the same shape: a multisig admin, a separate emergency pauser, and a guard that stops mainnet operator scripts until both exist.

### Emergency pauser

- The pauser lives in its own PDA, `["pauser"]` (`PauserConfig { bump, pauser }`), so `Global`'s layout never changes.
- `set_pauser(pauser)` is admin only. The first call creates the PDA (admin pays rent). `Pubkey::default()` removes the role.
- `pause(trading, launch, protocol_withdrawals, ops_withdrawals)` is signed by the pauser. Each `true` sets that flag. `false` leaves it alone, so the pauser can never clear a flag.
- Unpausing is `set_pause`, admin only.
- Verified on a local validator: a non-admin `set_pauser` and a random signer's `pause` are rejected, the pauser cannot call `set_pause`, all-false does not unpause, and a removed pauser is rejected.

### Mainnet guard

`scripts/init-deployment.ts` calls `requireMainnetGovernance` (`scripts/mainnet-guard.ts`) when `STONKZ_CLUSTER=mainnet-beta`. It refuses unless:

- `STONKZ_SQUADS_VAULT` is set and `STONKZ_ADMIN` equals it;
- `STONKZ_PAUSER` is set and differs from both the vault and the deployer;
- the program's upgrade authority on chain is the vault.

It then appoints the pauser, or prints the `set_pauser` instruction for the vault to sign.

### Handover to Squads (mainnet, or a testnet rehearsal)

1. Create a Squads multisig and note its **vault** address.
2. Move the upgrade authority:
   `solana program set-upgrade-authority FF1f3V47FtApwWWMHX462Gm7NVqNpUJ7K4yqKrYGSMbg --new-upgrade-authority <VAULT> --skip-new-upgrade-authority-signer-check`
3. `propose_admin(<VAULT>)`, signed by the current admin.
4. `accept_admin`, executed as a Squads transaction from the vault.
5. `set_pauser(<PAUSER>)`, executed as a Squads transaction from the vault.
6. Verify: `Global.admin` equals the vault, `pending_admin` is the default, the upgrade authority is the vault (`solana program show`), and the pauser PDA holds `<PAUSER>`.

Squads can add a time lock to its vault transactions. Use one on mainnet, like the 24 h floor on EVM.
