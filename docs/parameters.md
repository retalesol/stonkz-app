# Runtime parameters

What an admin can retune on each chain without redeploying, what is
deliberately fixed, how the upgrade that introduced the knobs lands with no
migration, and the operator runbooks (testnets, mainnet through the timelock,
the admin console).

Status: **EVM scripted and tested, not yet broadcast** to RH 46630 / Base
84532 (the live routers predate `setConfig`; see §4). Solana devnet already
runs the `params` PDA — see [`deployment.md`](deployment.md) §1.5.

| What              | Where                                                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| EVM word + bounds | `programs/evm/src/CurveMath.sol` (`Params`, `DEFAULT_PARAMS`, `pack`/`unpack`, `validParams`)                                           |
| EVM setters       | `StonkzLaunchpad.setParams` / `setTrustedRouter` / `paramsWord`; `StonkzRouter.setConfig`                                               |
| EVM reads         | `StonkzLens` (`params`, `quoteBuy`, `quoteSell`, `marketCap`) — stateless, one per chain                                                |
| EVM scripts       | `script/UpgradeParams.s.sol`, `script/SetParams.s.sol`, `script/SetRouterConfig.s.sol`                                                  |
| EVM tests         | `test/Params.t.sol`, `test/Upgrade.t.sol` (slots 17/18, legacy-layout upgrade), `test/Governance.t.sol`, `test/MainnetGuard.t.sol`      |
| Solana            | `programs/solana/programs/launchpad/src/state.rs` (`Params`, `load_params`), `instructions/params.rs` (`set_params`, `validate_params`) |
| Admin console     | `POST /admin/chain/prepare/<net>` with `setParams` / `setTrustedRouter` / `setRouterConfig` (EVM) and `set_params` (SOL); owner role    |

## 1. What is tunable

### 1.1 EVM — one packed word (`StonkzLaunchpad.setParams(uint256)`)

The nine numbers are packed into a single `uint256` in the `CurveMath.Params`
layout so the launchpad (at the EIP-170 ceiling) stores, reads and emits them
as one word. Low bits first:

| Bits    | Field            | Type     | Default             | Meaning                                                                  |
| ------- | ---------------- | -------- | ------------------- | ------------------------------------------------------------------------ |
| 0–15    | `feeProtocolBps` | `uint16` | `1500`              | Platform revenue leg of every fee (vault `protocolRevenue`)              |
| 16–31   | `feeOpsBps`      | `uint16` | `1000`              | `$STONKZ` buyback leg (vault `stonkzOps`, historical name)               |
| 32–47   | `feeBurnBps`     | `uint16` | `600`               | RWA crate fund leg (vault `stonkzBurn`, historical name)                 |
| 48–63   | `minFeeBps`      | `uint16` | `100`               | Floor on the creator-chosen curve fee (`createToken`)                    |
| 64–79   | `maxFeeBps`      | `uint16` | `500`               | Ceiling on the creator-chosen curve fee; also the "word is set" sentinel |
| 80–95   | `cbStartFeeBps`  | `uint16` | `5000`              | Where a cashback coin's fee starts before decaying to its own fee        |
| 96–127  | `cbWindowSecs`   | `uint32` | `300`               | Length of that decay                                                     |
| 128–191 | `gradMcapUsd1e6` | `uint64` | `69_000_000_000`    | Oracle-trigger graduation threshold ($69,000, scaled 1e6)                |
| 192–255 | `maxSupply`      | `uint64` | `1_000_000_000_000` | Largest `supply` (whole tokens) `createToken` accepts                    |

The creator bucket is the remainder (`10000 − protocol − ops − burn`, 6900 by
default); it is not a field.

**Bounds** (`CurveMath.validParams`, enforced by `setParams`; the Solana
`validate_params` applies the same ones minus `maxSupply`):

- `feeProtocolBps + feeOpsBps + feeBurnBps <= 10000`
- `minFeeBps <= maxFeeBps`, `maxFeeBps > 0`
- `maxFeeBps <= cbStartFeeBps <= 10000` (keeps `effFeeBps` inside `uint16`)
- `cbWindowSecs > 0`, `gradMcapUsd1e6 > 0`
- `0 < maxSupply <= 1e12` (`CurveMath.MAX_SUPPLY`, the ceiling every overflow
  bound in the library is sized against — raising it needs an upgrade, not a
  parameter)

**What each change affects, and when:**

| Field(s)                         | Existing coins                                                                                                                                                                                       | New coins                                  |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| fee split (`fee*Bps`)            | the very next `buy` / `sell` / `accrueExternalFees` — splitting is a fill-time decision, the event legs follow                                                                                       | same                                       |
| `minFeeBps` / `maxFeeBps`        | none: a coin's `feeBps` is stamped at creation and keeps trading                                                                                                                                     | `createToken` gate                         |
| `cbStartFeeBps` / `cbWindowSecs` | the next fill of a coin still inside its window (`cbStart` is stamped; the window length and start fee are read live). A coin whose own fee is above the new start fee pays its own fee — never less | same                                       |
| `gradMcapUsd1e6`                 | the **oracle trigger** of every coin (`graduate` reads the live word); the curve shape (`gradMcapBase`, `virtualBase`, `k`) is stamped at creation and does not move                                 | curve shape derived from the new threshold |
| `maxSupply`                      | none                                                                                                                                                                                                 | `createToken` gate                         |

### 1.2 EVM — the trusted router (`StonkzLaunchpad.setTrustedRouter(address)`)

`trustedRouter()` is the one address allowed to call `createTokenFor` (the
atomic create + dev-buy path). It answers the storage override (slot 18) when
set, else the implementation's constructor argument. `setTrustedRouter(0)`
restores the constructor default. The previous router keeps every trade path
(`buyWithEth`, `sellForEth`, `*ViaV3`, `*ViaAggregator`,
`graduateWithPriceUpdate`); only launches move.

### 1.3 EVM — the router's own knobs (`StonkzRouter.setConfig`)

`setConfig(uint256 maxBuyNative, IPyth pyth, IStockAttestationSink sink)`,
gated by `launchpad.admin()` (the timelock after the handover), so the router
needs no admin key of its own:

| Knob              | Default on deploy    | Meaning                                                                                      |
| ----------------- | -------------------- | -------------------------------------------------------------------------------------------- |
| `maxBuyNative`    | `MAX_BUY_NATIVE` env | Hard ceiling on `msg.value` per native-in buy; `0` = no cap. Applies to the next buy.        |
| `pyth`            | chain pin            | Pyth Core for in-transaction price updates; `0` = none (a non-empty update reverts `NoPyth`) |
| `attestationSink` | `StockPriceSourceV2` | Where `"STKA"` entries of `priceUpdate` go; `0` = dropped                                    |

The approval targets (`universalRouter`, `swapRouter02`, `launchpad`) stay
immutable on purpose.

### 1.4 Solana — the `["params"]` PDA (`set_params`)

Same fields minus `maxSupply` (the Solana supply menu is a constant table):
`fee_protocol_bps`, `fee_ops_bps`, `fee_burn_bps`, `min_fee_bps`,
`max_fee_bps`, `cb_start_fee_bps`, `cb_window_secs`, `grad_mcap_usd_1e6`, same
defaults, same bounds. Admin-only (`Global.admin`, the Squads vault on
mainnet). Every reader (`create_token`, `buy`, `sell`, `graduate`,
`claim_dex_fees`) takes the PDA as its last account and treats an empty
account as the defaults. Runbook, script and admin-console path:
[`deployment.md`](deployment.md) §1.5.

## 2. What is deliberately fixed

These are parity invariants shared by the EVM and Solana programs
(`programs/SPEC.md` §1–§2, held by `programs/parity-vectors.json` and
`test/Parity.t.sol`), not tunables:

- **Curve shape ratios**: 4/5 of supply for sale, 1/5 LP reserve,
  `virtualToken = 16/15 × supply`, `virtualBase = ceil(gradMcapBase / 15)`.
  They are what make the pool open at the curve's closing price.
- **Lock tables**: `lockWeightBps` (0 / 1 / 7 / 30 / 90 / 180 / 365 days →
  0 / 1.1× / 1.25× / 1.5× / 2.5× / 5× / 8×).
- **`MAX_SUPPLY` ceiling (1e12)**: `maxSupply` may be lowered, never raised
  past it.
- **`ACC_PRECISION` (1e36 on EVM, 1e12 on Solana)**: the staking accumulator
  scale; changing it would re-price every open position.
- **Rounding directions** in every fill, split and accrual.
- The 50 % cap on the stakers' share of the creator bucket.

Changing any of these is a contract upgrade with a parity-vector regeneration,
not a parameter.

## 3. "Zero means defaults" — the no-migration rule

- **EVM**: `_params` (slot 17) is appended after `pauser` (slot 16). The
  implementation reads it through `_w()`: `0` → `CurveMath.DEFAULT_PARAMS`.
  `_router` (slot 18) `0` → constructor default. So `upgradeToAndCall(impl, "")`
  with no init data changes nothing a user can see, and `paramsWord()` answers
  the defaults until the first `setParams`. Pinned by
  `test/Upgrade.t.sol::test_StorageLayoutIsAppendOnly` (slots 15–18) and
  `test_UpgradeFromTheLegacyLayoutNeedsNoMigration` (a proxy initialised and
  traded under the previous implementation, upgraded, re-read slot by slot).
- **Solana**: `load_params` returns `Params::defaults()` for an empty
  `["params"]` account, so the program upgrade lands before any `set_params`.

Implication for rollouts: upgrade first, observe (`paramsWord()` /
`params.initialised`), set numbers later — never the other way round.

## 4. Operator runbooks (EVM)

Conventions, every time:

- Enter the admin key in **your own terminal**, never pasted into a chat or a
  shell history: `read -s PRIVATE_KEY && export PRIVATE_KEY`.
- Dry-run first (no `--broadcast`); every script prints what it will do.
- `EXPECT_CHAIN_ID` makes a wrong `--rpc-url` fail closed.
- RPCs (QuickNode, project endpoints):
  - RH 46630: `https://icy-cosmopolitan-brook.robinhood-testnet.quiknode.pro/9c53e25ca5bbcb46f445fb61fa7049408ee9fcfb/`
  - Base 84532: `https://bold-morning-cherry.base-sepolia.quiknode.pro/e3b199333fe5835cdfe212994bd562e853860ffb/`
- Addresses today (`programs/evm/deployments/<chainId>.json`):
  - RH 46630: proxy `0xe308287C9A85E2B53F1027a1c589B5e3969928e8`, router `0xA039af821d950C03EE870F05bF1A32F06F9053c5`
  - Base 84532: proxy `0x2f197741C3ca71e3FE885a4F74C0D44e3A774D35`, router `0xe9085Fa0dc45F490048EAfBe8C86B6ABEaC07478`

### 4.1 The upgrade itself (`UpgradeParams`) — once per chain

The live routers were deployed from the pre-`setConfig` bytecode: their cap,
Pyth and sink are immutables and they have no `setConfig`. The upgrade
therefore ships a **new router** alongside the implementation
(`DEPLOY_ROUTER=1`): same Pyth and attestation sink as the current router
(read from it), `MAX_BUY_NATIVE` carried over unless given, then
`setTrustedRouter(newRouter)` on the proxy. The old router stops launching at
that moment and keeps trading.

```bash
cd programs/evm
read -s PRIVATE_KEY && export PRIVATE_KEY     # the launchpad admin EOA

# RH testnet 46630 — dry run, then broadcast
RPC=https://icy-cosmopolitan-brook.robinhood-testnet.quiknode.pro/9c53e25ca5bbcb46f445fb61fa7049408ee9fcfb/
LAUNCHPAD_ADDRESS=0xe308287C9A85E2B53F1027a1c589B5e3969928e8 EXPECT_CHAIN_ID=46630 DEPLOY_ROUTER=1 \
  forge script script/UpgradeParams.s.sol:UpgradeParams --rpc-url $RPC -vvv
LAUNCHPAD_ADDRESS=0xe308287C9A85E2B53F1027a1c589B5e3969928e8 EXPECT_CHAIN_ID=46630 DEPLOY_ROUTER=1 \
  forge script script/UpgradeParams.s.sol:UpgradeParams --rpc-url $RPC -vvv --broadcast

# Base Sepolia 84532
RPC=https://bold-morning-cherry.base-sepolia.quiknode.pro/e3b199333fe5835cdfe212994bd562e853860ffb/
LAUNCHPAD_ADDRESS=0x2f197741C3ca71e3FE885a4F74C0D44e3A774D35 EXPECT_CHAIN_ID=84532 DEPLOY_ROUTER=1 \
  forge script script/UpgradeParams.s.sol:UpgradeParams --rpc-url $RPC -vvv
LAUNCHPAD_ADDRESS=0x2f197741C3ca71e3FE885a4F74C0D44e3A774D35 EXPECT_CHAIN_ID=84532 DEPLOY_ROUTER=1 \
  forge script script/UpgradeParams.s.sol:UpgradeParams --rpc-url $RPC -vvv --broadcast
```

Optional: `SMOKE_TOKEN=<an existing coin>` reads its `coinInfo` back through
the new implementation and quotes it through the new lens;
`PARAMS_WORD=<word from SetParams>` sets the word in the same run (leave it
out: defaults). The script refuses to finish unless slots 0–16 are unchanged,
`_lock == 1`, the proxy's implementation slot is the new one, `paramsWord()`
is what it should be and `trustedRouter()` is the new router; it then prints
the `cast` commands to repeat those checks from a clean shell.

**After the broadcast, in the same window:**

1. Record `impl`, `StonkzLens`, the new `StonkzRouter` (and the old one as
   retired) in `deployments/<chainId>.json`; `node scripts/emit-chains.mjs`.
2. API + web: `RH_ROUTER_ADDRESS` / `BASE_ROUTER_ADDRESS` → the new router
   (Railway + Vercel). The old router answers trades until then; launches
   through it fail `not router`.
3. Indexer: add the old router to `LEGACY_ROUTERS` for the chain
   (`apps/indexer/src/config.ts`) so its `AtomicBuy` / `AtomicSell` history
   keeps indexing; the new router joins through `<NET>_ROUTER_ADDRESS`.
4. Admin console / API: nothing to change — `apps/api/src/chain/params.ts`
   already reads `paramsWord()` and falls back to the defaults while the
   implementation predates it; `GET /admin/chain/state` flips from
   `source: 'default'` to `'chain'` after the upgrade.

### 4.2 Changing the launchpad parameters (`SetParams`)

Every field defaults to the live value, so name only what changes. Dry run
prints the current and new fields, the packed word and the calldata; the
script refuses a word `validParams` would reject.

```bash
# e.g. a 20/5/5/70 split on RH testnet
LAUNCHPAD_ADDRESS=0xe308287C9A85E2B53F1027a1c589B5e3969928e8 EXPECT_CHAIN_ID=46630 \
FEE_PROTOCOL_BPS=2000 FEE_OPS_BPS=500 FEE_BURN_BPS=500 \
  forge script script/SetParams.s.sol:SetParams --rpc-url $RPC -vvv            # dry run
LAUNCHPAD_ADDRESS=0xe308287C9A85E2B53F1027a1c589B5e3969928e8 EXPECT_CHAIN_ID=46630 \
FEE_PROTOCOL_BPS=2000 FEE_OPS_BPS=500 FEE_BURN_BPS=500 BROADCAST=1 \
  forge script script/SetParams.s.sol:SetParams --rpc-url $RPC -vvv --broadcast
```

Env: `FEE_PROTOCOL_BPS`, `FEE_OPS_BPS`, `FEE_BURN_BPS`, `MIN_FEE_BPS`,
`MAX_FEE_BPS`, `CB_START_FEE_BPS`, `CB_WINDOW_SECS`, `GRAD_MCAP_USD_1E6` (or
`GRAD_MCAP_USD` in whole dollars), `MAX_SUPPLY`. Verify:
`cast call <proxy> "paramsWord()(uint256)" --rpc-url $RPC`, and the decoded
fields with `cast call <lens> "params(address)((uint16,uint16,uint16,uint16,uint16,uint16,uint32,uint64,uint64))" <proxy>`.

### 4.3 Changing the router's cap / Pyth / sink (`SetRouterConfig`)

Only a router deployed by `UpgradeParams` (or any later deploy) has
`setConfig`; the script detects the old bytecode and stops.

```bash
ROUTER_ADDRESS=<new router> EXPECT_CHAIN_ID=46630 MAX_BUY_NATIVE=500000000000000000 \
  forge script script/SetRouterConfig.s.sol:SetRouterConfig --rpc-url $RPC -vvv            # dry run
ROUTER_ADDRESS=<new router> EXPECT_CHAIN_ID=46630 MAX_BUY_NATIVE=500000000000000000 BROADCAST=1 \
  forge script script/SetRouterConfig.s.sol:SetRouterConfig --rpc-url $RPC -vvv --broadcast
```

Env: `MAX_BUY_NATIVE` (wei; `0` = uncapped), `PYTH` (or `PYTH_ADDRESS`),
`ATTESTATION_SINK`; each defaults to the router's current value. The API and
UI enforce the same cap number (`MAX_BUY_NATIVE` there too); the router is the
layer that cannot be bypassed.

### 4.4 Moving launches to another router (`setTrustedRouter`)

`UpgradeParams DEPLOY_ROUTER=1` does this for the first new router. For any
later one: deploy it (`DeployRouter.s.sol`, or `UpgradeParams` again with
`DEPLOY_ROUTER=1`, which also redeploys an identical implementation), then
`setTrustedRouter(newRouter)` from the admin — `cast send <proxy>
"setTrustedRouter(address)" <router>` on a testnet, the timelock on mainnet —
and roll the env / `LEGACY_ROUTERS` as in §4.1.

## 5. Mainnet: through the timelock

After the governance handover ([`governance-handover.md`](governance-handover.md))
the launchpad admin is the `TimelockController` and every setter above is a
timelocked operation (`setParams`, `setTrustedRouter`, and — because it is
gated by `launchpad.admin()` — `StonkzRouter.setConfig`). On a mainnet chain
id (4663 / 8453) all three scripts require the `MainnetGuard` env
(`PROPOSERS`, `MIN_DELAY` ≥ 86400, `PAUSER`, `NEW_OPS_WITHDRAW_AUTHORITY`,
`NEW_MIGRATION_AUTHORITY`), check that the admin is already the timelock, and
**never call the proxy or the router**: `UpgradeParams` deploys the
implementation / lens / router and prints the batch
(`upgradeToAndCall`, `setTrustedRouter`, `setParams`); `SetParams` and
`SetRouterConfig` print the single call. The Safe schedules it
(`timelock.schedule(target, 0, data, 0x0, salt, MIN_DELAY)` — target is the
proxy for the first two, the **router** for `setConfig`), waits `MIN_DELAY`,
and an executor runs `execute`. The pauser can stop trading instantly at any
point; it cannot touch parameters.

`DeployMainnet` leaves `paramsWord() == CurveMath.DEFAULT_PARAMS` (slot 17
zero) and verifies it; `MAX_BUY_NATIVE` is a starting value there, no longer a
one-shot decision.

## 6. Admin console path

The operator console (`/admin`, [`admin-panel.md`](admin-panel.md)) prepares
the same calls as unsigned calldata for the connected admin wallet, or as a
Safe Transaction Builder export for the timelock: `POST
/admin/chain/prepare/<net>` with `{ kind: "setParams", word }`,
`{ kind: "setTrustedRouter", router }`, `{ kind: "setRouterConfig", ... }`
(EVM) and `{ kind: "set_params", params: {...} }` (SOL); owner role for
`setParams` / `set_params`. `GET /admin/chain/state` shows the live word /
PDA and whether anything has been set. The server never holds a chain key.
