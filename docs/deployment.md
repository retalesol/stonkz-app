# Deployment runbook (Solana + Robinhood Chain + Base)

Deploying the programs and telling the API about them.

**Where things stand.** The EVM stack is live on the testnets — RH 46630
([`programs/evm/deployments/46630.json`](../programs/evm/deployments/46630.json))
and Base Sepolia 84532 ([`84532.json`](../programs/evm/deployments/84532.json))
— and the Solana program on devnet
([`programs/solana/deployments/devnet.json`](../programs/solana/deployments/devnet.json)).
**No mainnet has been deployed.** The EVM mainnet path is one script,
[`script/DeployMainnet.s.sol`](../programs/evm/script/DeployMainnet.s.sol)
(§2.1), which deploys on RH 4663 and Base 8453 exactly the stack the testnets
were rolled forward to — Pyth-priced launches, Uniswap V3 graduation into a
`FeeLocker`, `StockPriceSourceV2` (empty), `ReferralVault` — and ends with every
admin power on a `TimelockController`.

Three things this runbook takes seriously:

1. **The deployer key holds no lasting privilege.** On testnets the deploy
   scripts set the admin/authorities to keys you supply. On mainnet the
   deployer is admin only for the length of one broadcast: `DeployMainnet`
   hands every admin role to the timelock and renounces its own before it
   returns.
2. **No privileged value has a default.** Every authority is a required env
   var. A missing one aborts before anything is sent.
3. **Nothing chain-specific comes from the environment on mainnet.** Every
   third-party address is pinned in `src/config/RobinhoodChain.sol` /
   `src/config/Base.sol`, resolved by `block.chainid`, and checked for code
   before the first transaction.

---

## 0. Key custody, before anything else

Distinct roles. Do not collapse them, and do not put any of them in the API
process's environment (the two message-signing keys below are the exception:
they hold no funds and can move none).

| Role                             | Purpose                                                                                                                                              | Must be                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Deployer                         | Signs the deployment transactions only                                                                                                               | Hot is acceptable; holds nothing afterwards (mainnet: enforced by the script)   |
| Admin                            | Upgrades, pause/unpause, oracle config, migrator wiring, authority rotation. **Cannot move money.**                                                  | Mainnet: a `TimelockController` (>= 24 h) proposed to by the team Safe          |
| Pauser (EVM)                     | `pause(...)` on the launchpad, `pause()` on the `ReferralVault`, `pauseAttestations()`. Can only stop; never unpause                                 | Hot ops key or 1-of-N Safe, **not** behind the timelock, distinct from the Safe |
| Protocol withdraw authority      | Withdraws the 15% protocol treasury (also funds the `ReferralVault`)                                                                                 | Multisig or cold key                                                            |
| Ops withdraw authority           | Withdraws the 10% `$STONKZ` buyback vault and the 6% RWA crate fund                                                                                  | Multisig or cold key, **distinct from protocol**                                |
| Migration authority              | Runs graduation migration (Solana: pays pool rent; EVM: `migrateLiquidity`)                                                                          | Warm operational key, funded                                                    |
| Oracle authority                 | Solana: pushes base-mint USD prices. EVM mainnet: may push to the fallback-only `PushPriceSource` (default: nobody)                                  | Warm operational key (Solana); unset on EVM unless needed                       |
| Referral signer / stock attester | Sign referral vouchers (`REFERRAL_SIGNER_KEY_EVM`) and, if stock bases ever ship, price attestations. Message signing only; bounded by on-chain caps | API environment; rotated by the admin (`setSigner` / `setAttester`)             |

Both deploy scripts **refuse** a deployment where the protocol and ops
authorities are the same key, or where the admin equals either withdraw
authority. Those separations are enforced on-chain by distinct PDAs/vaults;
sharing a signer would undo that off-chain.

The two withdraw authorities are the only keys that can move settled revenue.
`programs/SPEC.md` §4 is explicit that neither may be a server hot key.

**Redeploy note (duplicate tickers):** Staging (2026-09-13) — RH testnet
`StonkzLaunchpad` UUPS-upgraded in place (proxy
`0x2588E500B1e5fCF18253F44b6f2607BF2B14161C`, impl
`0xe729089137ee7Af2495F3C55cf1538121fBea68d`); Solana launchpad
`FF1f3V47FtApwWWMHX462Gm7NVqNpUJ7K4yqKrYGSMbg` upgraded on devnet (slot
497713076). Proxy / program IDs unchanged — no Railway env refresh required.
See `programs/evm/deployments/46630.json` and `docs/real-vs-simulated.md`
(token identity).

---

## 0b. RPC endpoints (QuickNode)

The project's provider is QuickNode, one endpoint per network. Every runbook
command below and every operator script (`scripts/push-oracle-prices.sh`,
`scripts/reconcile-fees.ts`, the `programs/*/scripts` helpers, the fork
tests) uses these; both Railway services (`stonkz-backend`, `stonkz-indexer`)
carry all six.

| Network           | Chain id | URL                                                                                                       | Env var (API + indexer)  |
| ----------------- | -------- | --------------------------------------------------------------------------------------------------------- | ------------------------ |
| Robinhood Testnet | 46630    | `https://icy-cosmopolitan-brook.robinhood-testnet.quiknode.pro/9c53e25ca5bbcb46f445fb61fa7049408ee9fcfb/` | `RH_RPC_URL`             |
| Robinhood Mainnet | 4663     | `https://thrumming-wild-shape.robinhood-mainnet.quiknode.pro/e928f474b84a91ae2a3e1202b4830a4e8ff8739f/`   | `RH_MAINNET_RPC_URL`     |
| Base Sepolia      | 84532    | `https://bold-morning-cherry.base-sepolia.quiknode.pro/e3b199333fe5835cdfe212994bd562e853860ffb/`         | `BASE_RPC_URL`           |
| Base Mainnet      | 8453     | `https://muddy-long-snow.base-mainnet.quiknode.pro/2d3c9d5f0c802e809f0c140855a39a5e0bac2606/`             | `BASE_MAINNET_RPC_URL`   |
| Solana Devnet     | —        | `https://practical-quaint-meme.solana-devnet.quiknode.pro/c8aa47382db29af890d18e52774284dabdb6845a/`      | `SOLANA_RPC_URL`         |
| Solana Mainnet    | —        | `https://withered-late-shadow.solana-mainnet.quiknode.pro/c42aacddfd044848fd4ff4351f9ceb41bb18af4a/`      | `SOLANA_MAINNET_RPC_URL` |

- **The `*_MAINNET_RPC_URL` vars are reserved for the mainnet cut-over.**
  No code reads them today (`apps/api/src/env.ts` / `apps/indexer/src/config.ts`
  read only `RH_RPC_URL`, `BASE_RPC_URL`, `SOLANA_RPC_URL`, `ARC_RPC_URL`,
  `SOLANA_PRIVATE_RPC_URL`). They sit on Railway so the cut-over (§3) is a
  copy of three values next to the chain-id flip, not a provider sign-up.
  Point `SOLANA_PRIVATE_RPC_URL` at the Solana mainnet endpoint too (or a
  staked relay) when RELAY mode should mean something; unset, broadcast falls
  back to `SOLANA_RPC_URL`.
- **These URLs carry keys.** They belong in server env, this runbook, and
  operator scripts — never in `apps/web` source, a Vercel `VITE_*` variable,
  `scripts/emit-chains.mjs` or `apps/web/public/chains.json`. The wallets keep
  the keyless public RPCs there (`programs/evm/deployments/*.json#rpc`).
- **Production refuses the public hosts** outside `STONKZ_STAGING`
  (`env.ts`: `rpc.mainnet.chain.robinhood.com`, `sepolia.base.org` /
  `mainnet.base.org`, `api.*.solana.com`); `*.quiknode.pro` passes. The
  built-in defaults stay public so a bare checkout runs.
- **Fallback only:** `https://rpc.mainnet.chain.robinhood.com` works for RH
  4663 reads (`rpc.chain.robinhood.com` refuses TLS) and Robinhood documents
  it as rate-limited and not for production. Use it for a one-off `cast call`
  or a failover while QuickNode is down (`incident-runbook.md` §6), not as a
  configured value.
- **Fork tests** (`programs/evm/test/fork/*`, `Router.t.sol::test_Fork*`)
  read `RH_RPC_URL` and their own `*_FORK_RPC` vars: export the QuickNode URL
  from this table for the chain under test, e.g.
  `export RH_RPC_URL=https://icy-cosmopolitan-brook.robinhood-testnet.quiknode.pro/9c53e25ca5bbcb46f445fb61fa7049408ee9fcfb/`.

---

## 1. Solana

### 1.1 Build and deploy

```bash
cd programs/solana
anchor build
# Record the program ID anchor prints and make sure Anchor.toml + declare_id!
# agree with it before deploying to a cluster you care about.
anchor deploy --provider.cluster devnet
```

**Keep the program upgradeable through public beta.** Solana deploys through the
BPF Upgradeable Loader by default. Do **not** pass `--final` to
`anchor deploy` / `solana program deploy` until beta exit — that revokes the
upgrade authority permanently. After deploy:

```bash
solana program show <PROGRAM_ID> -u devnet
# Confirm "Authority" is the intended key (deployer or admin), not "none".
```

To rotate the authority to a multisig without freezing upgrades:

```bash
solana program set-upgrade-authority <PROGRAM_ID> \
  --new-upgrade-authority <MULTISIG_OR_ADMIN> \
  -u devnet
```

At beta exit, revoke with `--final` (or `set-upgrade-authority ... --new-upgrade-authority none`)
only after an external audit and a deliberate immutability decision.

The checked-in program ID (`FF1f3V47FtApwWWMHX462Gm7NVqNpUJ7K4yqKrYGSMbg`) is a
placeholder from local development. Generate a real one for any shared cluster
and update `Anchor.toml`, `declare_id!`, and `SOLANA_LAUNCHPAD_PROGRAM_ID`
together.

### 1.2 Initialize

`anchor deploy` does not create the `Global` config account, and every
instruction fails until it exists.

```bash
ANCHOR_PROVIDER_URL=https://practical-quaint-meme.solana-devnet.quiknode.pro/c8aa47382db29af890d18e52774284dabdb6845a/ \
ANCHOR_WALLET=~/.config/solana/id.json \
STONKZ_CLUSTER=devnet \
STONKZ_ADMIN=<pubkey> \
STONKZ_PROTOCOL_WITHDRAW_AUTHORITY=<pubkey> \
STONKZ_OPS_WITHDRAW_AUTHORITY=<pubkey> \
STONKZ_ORACLE_AUTHORITY=<pubkey> \
STONKZ_MIGRATION_AUTHORITY=<pubkey> \
pnpm exec ts-node scripts/init-deployment.ts --dry-run
```

Run with `--dry-run` first; it prints every derived address and sends nothing.
Drop the flag to execute.

The script also derives Meteora's `PresetParameter2` (default index 1) under
`lb_clmm` (`LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`, same on mainnet and
devnet). Override with `STONKZ_METEORA_PRESET` / `STONKZ_METEORA_PRESET_INDEX`.

### 1.3 Meteora DLMM config (admin key)

`set_meteora_config` is admin-gated. If the deployer is the admin (devnet
convenience) the script sends it; otherwise it prints the call for the admin
signer. One-shot helper: `pnpm exec ts-node scripts/set-meteora-config.ts`.

| Cluster               | Meteora DLMM (`lb_clmm`)                      |
| --------------------- | --------------------------------------------- |
| mainnet-beta / devnet | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` |

**Until this lands, `migrate_create_pool` fails closed** (Anchor's `address = …`
constraint against `Pubkey::default()`) and nothing can migrate. That is the
intended fail-closed behaviour, not a bug. (`graduate` itself does not read
these slots, so a coin can still graduate; its reserves then wait on the curve
PDA's vaults until the config lands.)

#### 1.3.1 Graduation, migration and post-bond fees (Solana)

- **`graduate`** — permissionless; the app offers it as GRADUATE NOW
  (`POST /tokens/:sym/graduate/prepare`, which prepends `sync_price_from_pyth`
  when a feed is pinned so the oracle trigger reads a price seconds old). An
  exhausted curve graduates with no oracle account at all.
- **`migrate_create_pool`** then **`migrate_seed_liquidity`** — both signed by
  `migration_authority`, each idempotent: the first records `curve.dex_pool`
  and refuses to run twice (`PoolAlreadyExists`); the second refuses before a
  pool exists (`PoolNotCreated`) and after it has run (`AlreadyMigrated`). A
  failed seed reverts atomically (reserves stay in the curve vaults), so a
  retry with the same accounts completes. The seed fronts 0.15 SOL of rent
  from the authority through the escrow PDA (bin array ≈ 0.0715 SOL +
  position ≈ 0.0574 SOL) and refunds the unspent remainder in the same
  transaction; step 1's `LbPair` rent is paid by the authority directly.
  The position is opened with `initialize_position_pda`, owned by the
  per-mint escrow PDA (default fee owner = the escrow), so only this program
  can sign for it and no instruction of it withdraws, closes or reassigns
  the position. **DLMM's own timelock is not available:**
  `initialize_position_by_operator` / `lock_release_point` is gated on
  Meteora's operator whitelist and returns `UnauthorizedAccess` for every
  other caller (probed against the real program on a local validator, both
  pair types). Permanence is therefore the launchpad program's — the same
  trust as the EVM UUPS admin — which is one more reason the program upgrade
  authority moves to the timelock at the governance handover.
- **`claim_dex_fees`** — permissionless crank. Claims the locked position's
  swap fees (`claim_fee2`) into the escrow ATAs and routes them through the
  curve's own split: base side 15% protocol / 10% buyback / 6% crate fund /
  69% creator bucket (creator + stakers, as on a fill); launched-token side
  69% to the bucket in tokens, the other 31% burned (there is no per-mint
  treasury to hold it). Emits `DexFeesClaimed`. Run it on a cadence (or let
  anyone): fees only accrue inside the DLMM position until it is called.
  Positions opened by the previous program build had the incinerator as fee
  owner; their fees are unrecoverable and `claim_dex_fees` refuses them
  (`PositionMismatch`).
- **Testing against the real DLMM:** `anchor test` still clones Raydium (its
  migration suite is `describe.skip`). The Meteora path is exercised by
  `tests/meteora-graduation.ts` against a local validator with `lb_clmm`,
  `PresetParameter2 #1` and Metaplex cloned from devnet — the exact commands
  are in that file's header. Note the devnet preset has `collect_fee_mode = 1`
  (fees in the quote token only), so post-bond fees arrive entirely in
  whichever mint sorted as Y; pick the mainnet preset with that in mind.
- **Known gap (needs an upgrade):** the `LbPair` PDA is deterministic
  (`[preset, min(mint), max(mint)]`), so a third party can create it before
  `migrate_create_pool`, which then fails closed with `PoolAlreadyExists` for
  good. The fix is to adopt an existing pair and seed at the curve's bin
  (or use a creator-keyed permissionless pair); until then an operator must
  pick a different `PresetParameter2` for that coin, which needs a
  per-coin config the program does not have yet.

### 1.4 Base prices (oracle authority key)

`create_token` refuses a base mint with no usable price. Push a price per base
mint before any launch against it:

```
push_base_price(base_mint, price1e6, conf1e6)   # signed by oracle authority
```

Solana's `BaseOracle` is a program-owned account written by a dedicated pusher,
so its staleness bound is short (90s) — deliberately unlike the EVM side's,
which must accommodate a 24h Chainlink heartbeat. Run the pusher on a cadence
comfortably inside that window or graduations stall.

### 1.5 Runtime parameters (Solana)

The fee split (platform / `$STONKZ` buyback / RWA fund, creator bucket as the
remainder), the creator fee bounds, the cashback start fee and window, and the
graduation market cap live in the `["params"]` PDA, settable by the admin with
`set_params` — no redeploy. **The account is optional:** every instruction that
reads it (`create_token`, `buy`, `sell`, `graduate`, `claim_dex_fees`) passes
the PDA as its last account and treats an empty account as the built-in
defaults (`constants.rs`: 1500/1000/600 bps, 100–500 bps, 5000 bps over 300 s,
$69,000). So the program upgrade that introduced it needs no migration step,
and the order that avoids downtime is: deploy the API/web (they append the
params account, which the old program ignores as a trailing account), upgrade
the program, then `set_params` whenever you actually want different numbers.

```bash
# Devnet: show the current values, send nothing.
ANCHOR_PROVIDER_URL=https://practical-quaint-meme.solana-devnet.quiknode.pro/c8aa47382db29af890d18e52774284dabdb6845a/ \
ANCHOR_WALLET=/path/to/admin.json \
STONKZ_CLUSTER=devnet \
pnpm exec tsx programs/solana/scripts/set-params.ts --dry-run

# Devnet: set them. Every STONKZ_* is optional and defaults to the built-in value.
ANCHOR_PROVIDER_URL=https://practical-quaint-meme.solana-devnet.quiknode.pro/c8aa47382db29af890d18e52774284dabdb6845a/ \
ANCHOR_WALLET=/path/to/admin.json \
STONKZ_CLUSTER=devnet \
STONKZ_FEE_PROTOCOL_BPS=1500 STONKZ_FEE_OPS_BPS=1000 STONKZ_FEE_BURN_BPS=600 \
STONKZ_MIN_FEE_BPS=100 STONKZ_MAX_FEE_BPS=500 \
STONKZ_CB_START_FEE_BPS=5000 STONKZ_CB_WINDOW_SECS=300 \
STONKZ_GRAD_MCAP_USD=69000 \
pnpm exec tsx programs/solana/scripts/set-params.ts
```

The program rejects `protocol + ops + burn > 10000`, `min > max`,
`max > cb_start`, `cb_start > 10000`, a zero window and a zero cap
(`Params*` errors), and the script applies the same checks before sending.
`scripts/init-deployment.ts` sends `set_params` with the defaults on a fresh
deployment and leaves an existing PDA alone. On mainnet-beta the admin is the
Squads vault: the script refuses without `STONKZ_SQUADS_VAULT`, and when the
wallet is not admin it prints the instruction (accounts + base64 data) for the
multisig instead of sending. The admin console prepares the same instruction
(`POST /admin/chain/prepare/SOL` with `{ kind: "set_params", params: {...} }`,
owner role) and `GET /admin/chain/state` shows the live values with
`params.initialised` telling you whether the PDA exists yet.

Existing coins are affected immediately by a new split / cashback shape (fees
are split at fill time); a new graduation cap applies to coins launched after
the change (each curve stores its own `grad_mcap_base`) and to the oracle
trigger of every coin.

---

## 2. Robinhood Chain

### 2.0 Testnet (46630) — preferred first deploy

Mainnet pins in `RobinhoodChain.sol` do **not** hold code on testnet for WETH,
Uniswap V2, or Chainlink. Use `script/DeployTestnet.s.sol` instead:

```bash
cd programs/evm
export PRIVATE_KEY=0x...   # funded testnet key; never commit
export STONKZ_ADMIN=$(cast wallet address --private-key "$PRIVATE_KEY")
export STONKZ_PROTOCOL_WITHDRAW_AUTHORITY=0x...   # distinct throwaway
export STONKZ_OPS_WITHDRAW_AUTHORITY=0x...        # distinct from protocol
forge script script/DeployTestnet.s.sol:DeployTestnet \
  --rpc-url https://icy-cosmopolitan-brook.robinhood-testnet.quiknode.pro/9c53e25ca5bbcb46f445fb61fa7049408ee9fcfb/ --broadcast -vvv
```

That script deploys UUPS proxies for `PushPriceSource` + `StonkzLaunchpad`, a
`StonkzV2Factory` (V2 is missing on 46630), migrator, and `StonkzRouter`, then
seeds WETH/USDG prices. Addresses are printed for Railway env. Recorded deploy:
[`programs/evm/deployments/46630.json`](../programs/evm/deployments/46630.json).

Operational smoke after deploy (funded admin key):

```bash
# Oracle-graduate + migrate an existing token (LP → 0x…dEaD)
forge script script/SmokeGraduate.s.sol:SmokeGraduate \
  --rpc-url https://icy-cosmopolitan-brook.robinhood-testnet.quiknode.pro/9c53e25ca5bbcb46f445fb61fa7049408ee9fcfb/ --broadcast -vv
```

Set Railway `RH_CHAIN_ID=46630`, `RH_RPC_URL` (the QuickNode testnet endpoint, §0b), `RH_LAUNCHPAD_ADDRESS`,
`RH_ROUTER_ADDRESS`, `BASE_MINT_OVERRIDES_RH`, and
`INDEXER_RH_START_BLOCK` (deployment block). Set `INDEXER_SOURCE=chain` with
`INDEXER_SOL_START_SLOT` once Solana is deployed — production refuses fixture
mode without `INDEXER_ALLOW_FIXTURES=1`.

EVM launchpad / push-oracle stay **UUPS-upgradeable through public beta**
(`upgradeToAndCall`, admin-gated). `StonkzRouter` stays immutable by design —
redeploy and update `RH_ROUTER_ADDRESS` if its logic must change.

#### 2.0.1 Graduation runbook (EVM)

Graduation is two transactions, on purpose:

1. **`graduate(token)` — permissionless.** Either trigger: the 80% allocation
   sold out (no oracle read; cannot be stale), or a _fresh_ base price puts
   the cap at/over $69K while tokens remain. The launchpad prices through
   `PythPriceSource`, whose per-feed bound is ~120 s, so the oracle trigger is
   only reachable from a transaction that carries a Hermes update:
   `StonkzRouter.graduateWithPriceUpdate(token, priceUpdate, deadline)` with
   `msg.value ≥ pyth.getUpdateFee(priceUpdate)` (the excess is refunded). A
   bare `graduate()` on the oracle trigger reverts `"stale oracle"` — that is a
   deferral, not a wedge; the exhaustion trigger never consults the oracle.
   The app offers this as **GRADUATE NOW** on the token page
   (`POST /tokens/:sym/graduate/prepare`), so no keeper is required; the
   route answers `router_upgrade_required` until a router that has
   `graduateWithPriceUpdate` is deployed and set as `<NET>_ROUTER_ADDRESS`
   (the routers recorded in `deployments/*.json` on 2026-09-29 predate it).
   `oracleGraduationPaused` (admin / pauser) removes the oracle trigger only.
2. **`migrateLiquidity(token)` — `migrationAuthority` only.** (The v2 flow
   below is what coins graduated before 2026-09-30 got; every chain now has
   the v3 `FeeLocker` migrator of §2.0.2 installed, and mainnet deploys with
   it from the first block.) Sends the raise
   (`realBase`) and the 20% escrow (`lpReserve`) to `UniswapV2Migrator`, which
   creates or adopts the V2 pair, swaps a pre-seeded pair back to the curve's
   closing price (`PoolCorrected`), deposits, and mints every LP token to
   `0x…dEaD` (`LiquidityMigrated(token, pool, liquidityBurned)`). Surplus
   tokens are burned, surplus base is escrowed back on the launchpad
   (`Surplus`). It fails closed with `"not migration authority"` / `"no
migrator"` and leaves the reserves in place; a retry after fixing the
   wiring completes normally, and a second call reverts `"nothing"`.

Between the two the curve is closed (`"graduated"` on buy/sell) and the token
page shows GRADUATED without a pool link; the indexer attaches the pool when
`LiquidityMigrated` lands (`tokens.pool_address`). Creator fees and stake
rewards accrued on the curve stay claimable after both steps — the 69% bucket
is a separate ledger from the raise — and stakers can unstake once their lock
expires. Nothing accrues after graduation: V2 fees compound into the burned
position and are claimable by nobody (see `UniswapV2Migrator.sol`'s header for
why v2, and what a fee-claiming v3/v4 locker would need).

Until a keeper exists, an operator can run both steps for a token from the
migration-authority key:

```bash
# Step 1 (anyone). Exhausted curve — no update needed:
cast send $LAUNCHPAD "graduate(address)" $TOKEN --rpc-url $RPC --private-key $ANY_KEY
# Step 1 (anyone). Oracle trigger — fetch the Hermes update for the base's feed
# and post it in the same transaction through the router:
cast send $ROUTER "graduateWithPriceUpdate(address,bytes[],uint256)" \
  $TOKEN "[$HERMES_UPDATE_HEX]" $(( $(date +%s) + 300 )) --value $UPDATE_FEE_WEI ...
# Step 2 (migration authority):
cast send $LAUNCHPAD "migrateLiquidity(address)" $TOKEN --rpc-url $RPC --private-key $MIGRATION_AUTHORITY_KEY
```

#### 2.0.2 Post-graduation fees (Uniswap v3 + `FeeLocker`)

`UniswapV3Migrator` replaces the v2 migrator: the raise + escrow become one
**full-range** Uniswap v3 position (1% tier by default; a constructor param)
owned by the immutable `FeeLocker`, which has no owner and no function that
removes liquidity — the principal is as locked as burned LP — but whose
permissionless `claimFees(token)` collects the position's fees and routes
them into the launchpad's ledgers by the curve's own 15/10/6/69 split (base
side; token side: 69% to the creator bucket incl. the staker peel, the 31%
treasury legs burned to `0x…dEaD`). The locker owns positions directly in the
pool by `(locker, tickLower, tickUpper)`; RH testnet has no
NonfungiblePositionManager and none is needed anywhere.

Rollout, per chain (testnet: admin key; mainnet: the script prints the
timelock batch):

```bash
cd programs/evm
# 1. Implementation-only upgrade: adds `accrueExternalFees`, keeps the router.
LAUNCHPAD_ADDRESS=$PROXY KEEP_ROUTER=1 EXPECT_CHAIN_ID=$CHAIN \
  forge script script/UpgradeStockLaunch.s.sol:UpgradeStockLaunch --rpc-url $RPC -vvv   # then --broadcast
# 2. FeeLocker + UniswapV3Migrator, then setMigrator (refuses until step 1 is live).
LAUNCHPAD_ADDRESS=$PROXY EXPECT_CHAIN_ID=$CHAIN \
  forge script script/DeployV3Migrator.s.sol:DeployV3Migrator --rpc-url $RPC -vvv       # then --broadcast
# Optional: V3_FACTORY (defaults to the chain pin), V3_FEE (10000), FEE_LOCKER (reuse), MIGRATION_AUTHORITY.
```

Afterwards `migrateLiquidity` emits `LiquidityMigrated(token, pool, liquidity)`
(same signature; the third field is the locked v3 liquidity, not burned LP)
and anyone can call `FeeLocker.claimFees(token)` — the token page shows the
uncollected amount and offers **CLAIM POOL FEES**. Each claim emits the usual
`FeeAccrued` + `TreasuryCredit` plus `PoolFeesAccrued` (token side and staker
peel), which the indexer books like a curve fill. The API discovers the
locker from the chain (`launchpad.migrator().locker()`); no env var. Coins
graduated by the v2 migrator keep their burned LP and show no claim button.
Record `FeeLocker` and `UniswapV3Migrator` in `deployments/<chainId>.json`.
Fork rehearsal: `test/fork/V3GraduationFork.t.sol` (env-gated, either chain).

### 2.1 Mainnet deploy — RH 4663 and Base 8453 (`DeployMainnet`)

One script, one dry-runnable broadcast, both chains; every pin resolved from
the chain id. It refuses Arc (deferred) and the testnets, refuses to start
without the governance env, checks that every pinned dependency holds code and
that the V3 factory has the 1% tier, and ends governed:

| Step | Contract                                 | Notes                                                                                                                                        |
| ---- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `PushPriceSource` (UUPS proxy)           | Fallback only, never the live source; `STONKZ_ORACLE_AUTHORITY` may push (default nobody)                                                    |
| 2    | `ChainlinkPriceSource`                   | ETH/USD for WETH (+ USDG/USD on RH), bound 90 000 s; `PythPriceSource`'s fallback                                                            |
| 3    | `PythPriceSource`                        | ETH/USD → WETH at `PYTH_MAX_AGE` (120 s), stables fixed at $1.00, fallback = Chainlink. **The launchpad's live source**                      |
| 4    | `StonkzLaunchpad` impl + ERC1967 proxy   | Initialised with protocol/ops authorities, the Pyth source, the migration authority; `maxOracleStaleness` 90 000                             |
| 5    | `StockPriceSourceV2`                     | quote = Pyth source, fallback = push, launchpad = proxy; **no base configured** (v1); `STOCK_PRICE_ATTESTER` optional                        |
| 6    | `StonkzRouter` + trusting implementation | UR, WETH, SwapRouter02 pins; `MAX_BUY_NATIVE` (0 = uncapped, warned); Pyth; attestation sink = StockV2; `upgradeToAndCall`                   |
| 7    | `FeeLocker` + `UniswapV3Migrator`        | Chain's V3 factory, `GRADUATION_POOL_FEE` 10000 (tick spacing 200)                                                                           |
| 8    | `TimelockController` + atomic handover   | `GovernanceLib.handover`: authorities, `setMigrator`, `setPauser`; timelock accepts admin of launchpad + 4 price sources; deployer renounces |
| 9    | `ReferralVault`                          | `admin = timelock`, `REFERRAL_SIGNER`, WETH, `REFERRAL_MAX_PER_DAY`                                                                          |

```bash
cd programs/evm
# RPCs: the QuickNode mainnet endpoints from §0b (on Railway as *_MAINNET_RPC_URL)
export RH_RPC_URL=https://thrumming-wild-shape.robinhood-mainnet.quiknode.pro/e928f474b84a91ae2a3e1202b4830a4e8ff8739f/
export BASE_RPC_URL=https://muddy-long-snow.base-mainnet.quiknode.pro/2d3c9d5f0c802e809f0c140855a39a5e0bac2606/
# Governance (MainnetGuard) — required on every mainnet chain id:
export PROPOSERS=0x<team Safe>          # comma-separated; also cancellers
export EXECUTORS=$PROPOSERS             # optional; 0x0 = anyone
export MIN_DELAY=86400                  # >= 24 h
export PAUSER=0x<hot pauser key or 1-of-N Safe>
export NEW_OPS_WITHDRAW_AUTHORITY=0x<cold>      # buyback + RWA vaults
export NEW_MIGRATION_AUTHORITY=0x<warm, funded>
# Launchpad / vault:
export STONKZ_PROTOCOL_WITHDRAW_AUTHORITY=0x<cold, distinct from ops>
export REFERRAL_SIGNER=0x<address of REFERRAL_SIGNER_KEY_EVM>
export REFERRAL_MAX_PER_DAY=1000000000000000000   # wei of WETH / rolling day (blast radius of a leaked signer)
# Optional: STONKZ_ORACLE_AUTHORITY, STOCK_PRICE_ATTESTER, MAX_BUY_NATIVE (wei; 0 = uncapped),
#           PYTH_MAX_AGE (120), ETH_MIN_PRICE_1E6 (100e6), ETH_MAX_PRICE_1E6 (100000e6)

# Robinhood Chain 4663 — dry run, then broadcast. Sign with a hardware wallet
# (or `--account <keystore> --sender`, or export PRIVATE_KEY): that signer is
# the temporary admin and must be a FRESH key, not the testnet deployer.
EXPECT_CHAIN_ID=4663 forge script script/DeployMainnet.s.sol:DeployMainnet \
  --rpc-url "$RH_RPC_URL" --ledger --sender 0x<deployer> -vvv
EXPECT_CHAIN_ID=4663 forge script script/DeployMainnet.s.sol:DeployMainnet \
  --rpc-url "$RH_RPC_URL" --ledger --sender 0x<deployer> --broadcast --verify -vvv

# Base 8453 — the same command against a Base RPC (the Safe, pauser and
# authorities are per chain; export the Base set first).
EXPECT_CHAIN_ID=8453 forge script script/DeployMainnet.s.sol:DeployMainnet \
  --rpc-url "$BASE_RPC_URL" --ledger --sender 0x<deployer> -vvv          # then --broadcast --verify
```

The dry run prints the full `deployments/<chainId>.json` snippet, the
`apps/api` / indexer env lines, and the Safe/verify checklist (§2.2). A run
with `MAX_BUY_NATIVE=0` prints a loud warning: the router is immutable, so a
per-buy cap for a soft launch must be chosen **before** the broadcast.

Rehearsal: the same code path runs against a fork of each chain in
[`test/fork/MainnetDeployFork.t.sol`](../programs/evm/test/fork/MainnetDeployFork.t.sol)
(`MAINNET_FORK_RPC_RH` / `MAINNET_FORK_RPC_BASE`), followed by the whole user
journey on what it deployed — launch through the router with a Pyth update,
buy, sell, stake, graduate, V3-migrate into the real factory, `claimFees`,
a referral claim, pause by the pauser and timelock-only unpause.

### 2.2 After the broadcast (Safe + ops, nothing for an admin key)

There are no admin steps: the broadcast ended with the timelock as admin of
everything. What remains is verification and configuration:

1. `forge verify-contract` every printed address (or `--verify` above);
   confirm the proxy's ERC1967 implementation slot equals the printed
   implementation.
2. On the chain, not the log: `launchpad.admin() == timelock`,
   `pendingAdmin() == 0`, `pauser() == PAUSER`, `migrator() ==
UniswapV3Migrator`, `migrationAuthority()`, `protocolWithdrawAuthority()`,
   `opsWithdrawAuthority()`, `priceSource() == PythPriceSource`,
   `maxOracleStaleness() == 90000`, `trustedRouter() == router`. Every price
   source and the `ReferralVault`: `admin() == timelock`. On the timelock:
   `getMinDelay() == MIN_DELAY`, the Safe has `PROPOSER_ROLE` /
   `CANCELLER_ROLE` / `EXECUTOR_ROLE`, the deployer has none.
3. Write `programs/evm/deployments/<chainId>.json` from the printed snippet
   (add `rpc`, `explorer`, `deployedAt`, the deployment block) and run
   `node scripts/emit-chains.mjs` — that is what puts the chain in the `main`
   block of `apps/web/public/chains.json`.
4. Fund the referral vault from the protocol authority:
   `withdrawTreasury(0, WETH, amount, vault)`.
5. API env (§3): the printed `<NET>_LAUNCHPAD_ADDRESS`, `<NET>_ROUTER_ADDRESS`,
   `REFERRAL_VAULT_ADDRESS_<NET>`, plus `PYTH_HERMES_URL` / `PYTH_HERMES_API_KEY`
   — **a launch without a Hermes update is refused** (`stale oracle`).
6. Rehearse the emergency path once: from the pauser key `pause(true,…)`,
   then the Safe schedules `setPause(false,…)` on the timelock and executes it
   after `MIN_DELAY`.

Every later change — a new router/implementation, a price-source switch, a
stock base, a signer rotation — is deployed by the existing scripts
(`UpgradeStockLaunch`, `SwitchPriceSource`, `DeployV3Migrator`,
`DeployReferralVault`, …), which on a mainnet chain id require the governance
env, check that the launchpad is already under the timelock, and **print the
batch for the Safe instead of calling the proxy**
([`governance-handover.md`](governance-handover.md)).

The fee split, fee bounds, cashback shape, graduation cap, supply cap and the router's cap / Pyth / sink are runtime parameters, not upgrades: [`parameters.md`](parameters.md).

### 2.3 Stock-token bases are not in v1 — opting one in later

`StockBases.sol` has deliberately empty branches for 4663 and 8453, so
`StockPriceSourceV2` ships with no base and a stock token has no price
(`createToken` refuses it in preflight). Listing one later is a legal decision
first ([`launch-checklist.md`](launch-checklist.md)) and then a timelock
batch, not a redeploy:

1. Pin the token and its stock/WETH V3 pool in `StockBases.sol` for the chain;
   create and seed the pool (`SeedStockPool`) and let `twapSecs` pass.
2. Schedule through the Safe, all value 0:
   `StockPriceSourceV2.setConfig(token, params)` (and `setAttester` /
   `setStableQuote` as needed); on the first base also
   `PythPriceSource.setFallbackSource(StockPriceSourceV2)` so the launchpad
   reaches it (that replaces the Chainlink fallback in the chain — set
   `StockPriceSourceV2.setFallbackSource(ChainlinkPriceSource)` in the same
   batch if the Chainlink leg should stay reachable).
3. API: `STOCK_PRICE_ATTESTER_KEY` behind the configured attester, and the
   `BASE_MINT_OVERRIDES_<NET>` entries for the tokens.

---

## 2b. Coinbase Base and Circle Arc

Both reuse the Robinhood EVM stack.

**Base mainnet (8453)** — `script/DeployMainnet.s.sol` (§2.1), pins in
`src/config/Base.sol` (WETH predeploy, native USDC, Uniswap V3 factory /
SwapRouter02 / QuoterV2 / Universal Router / Permit2, Pyth, Chainlink ETH/USD —
all read on chain 2026-10-01). Same env shape as RH.

**Base Sepolia (84532)** — `script/DeployBaseSepolia.s.sol`, pins in
`src/config/BaseSepolia.sol`, record in `deployments/84532.json`. Same env
shape as RH with the `BASE_` prefix.

**Arc (5042) — mainnet, capped.** Arc's public testnet (5042002) closed on
17 Sep 2026, so there is no test chain; the Arc deployment is real funds under
a hard cap.

- `src/config/Arc.sol` ships with **zero placeholders** for the wrapped
  native USDC, the ERC-20 USDC and the Uniswap pins. `DeployArc` refuses to
  broadcast until every one is filled in from docs.arc.io and checked on the
  explorer. Note the two faces of USDC: native (18 decimals at the EVM layer,
  what `msg.value` carries) and ERC-20 (6 decimals). The router wraps native
  into `WRAPPED_NATIVE`; a coin's base must be exactly that address for the
  one-signature `buyWithEth` path.
- The router is deployed with `Arc.MAX_BUY_NATIVE = 25e18` (25 USDC). Every
  native-in entry point reverts `BuyAboveCap` above it. The API
  (`NET_INFO.ARC.maxTradeUsd`) and the UI mirror the number; change all three
  together.
- Use a **fresh deployer key** (the RH/Base testnet key is burned).
- Afterwards: write `deployments/5042.json`, run `node scripts/emit-chains.mjs`
  (CI checks that `apps/web/public/chains.json` matches), and set
  `ARC_LAUNCHPAD_ADDRESS` / `ARC_ROUTER_ADDRESS` (or point
  `STONKZ_CHAINS_FILE` at the record). Setting the launchpad address is what
  adds chain 5042 to the SIWE allow-list.

```
export PRIVATE_KEY=0x...   # fresh, funded with USDC on Arc
export STONKZ_PROTOCOL_WITHDRAW_AUTHORITY=0x...
export STONKZ_OPS_WITHDRAW_AUTHORITY=0x...
forge script script/DeployArc.s.sol:DeployArc --rpc-url $ARC_RPC_URL --broadcast -vvv
```

## 3. Configure the API and indexer

The deploy scripts print these lines. Set them in the API's environment:

```
SOLANA_LAUNCHPAD_PROGRAM_ID=<solana program id>
SOLANA_RPC_URL=<QuickNode, §0b>       # mainnet: the SOLANA_MAINNET_RPC_URL value
RH_RPC_URL=<QuickNode, §0b>           # mainnet: the RH_MAINNET_RPC_URL value
BASE_RPC_URL=<QuickNode, §0b>         # mainnet: the BASE_MAINNET_RPC_URL value
RH_CHAIN_ID=4663                      # mainnet; 46630 on the testnet
RH_LAUNCHPAD_ADDRESS=0x<StonkzLaunchpad>
RH_ROUTER_ADDRESS=0x<StonkzRouter>
RH_V3_FEE_TIER_OVERRIDES=<see below>
REFERRAL_VAULT_ADDRESS_RH=0x<ReferralVault>
BASE_CHAIN_ID=8453                    # and the BASE_* equivalents of the above
EVM_ALLOWED_CHAIN_IDS=4663,8453
PYTH_HERMES_URL=... PYTH_HERMES_API_KEY=...   # launches carry a Hermes update
```

Defaults follow the chain id: with `RH_CHAIN_ID=4663` / `BASE_CHAIN_ID=8453`
the base-mint tables (`router/base-mints.ts`: WETH + USDG on RH, WETH + USDC
on Base — the same pins as `src/config/*.sol`), the public RPC and explorer,
the V3 factory and the referral asset all resolve to the mainnet values, and
no stock tokens are listed. A chain id with no pinned table refuses to boot
unless `BASE_MINT_OVERRIDES_<NET>` supplies at least `WETH:<address>`.
`*_V3_QUOTER_ADDRESS` defaults to Uniswap's canonical QuoterV2 on RH 4663,
Base 8453 and Base Sepolia (the pool-hop client speaks both QuoterV2's struct
ABI and the flat testnet `V3ExactInputQuoter`); only RH testnet 46630, which
has no QuoterV2, needs the deployed flat quoter pinned by env.

`apps/api/src/env.ts` refuses to boot in production with
`RH_LAUNCHPAD_ADDRESS` unset (unless `STONKZ_STAGING=1`) and always refuses a
zero `RH_ROUTER_ADDRESS`. RH trading is atomic-only: missing router or an
unpinned aggregator fee tier returns `rh_router_required` instead of a
multi-signature `EvmStep[]` plan.

### 3.1 `RH_V3_FEE_TIER_OVERRIDES` — pin these by hand, never guess

Format: a per-base-asset map of Uniswap v3 fee tier. Needed only for
aggregator-hop bases; a WETH-based curve needs no pool at all (the router just
wraps/unwraps).

**Why this is a human allow-list and not a probe:** `docs/robinhood-chain.md`
row 43 records roughly 1,900 hookless v4 pools on this chain carrying 88-100%
LP fees. Auto-selecting "a pool that exists" for a base asset can route a
user's trade through one that eats nearly the whole trade. For each base asset
you intend to support:

1. Identify the canonical v3 pool for `base/WETH`.
2. Verify its fee tier and that its liquidity is real, on the explorer.
3. Add exactly that tier to the override map.

An unpinned base asset fails closed (`rh_router_required`). Leaving it
unpinned is safer than guessing.

---

## 4. Verification, before any real user

Do all of these against the deployment, not against a local test.

**Solana**

- [ ] `Global` exists with the intended admin/authorities (read the account, don't trust the script's log).
- [ ] `dex_program` and `dex_config` (Meteora DLMM + PresetParameter2) are set and match §1.3.
- [ ] Protocol and ops vault PDAs are distinct addresses.
- [ ] Launch a throwaway token, buy, sell. Confirm the 15/69/10/6 split lands in the four expected places (protocol, creator bucket incl. stakers, buyback, RWA crate fund).
- [ ] Force a graduation. On the explorer, confirm the Meteora DLMM pool exists and the position (`["position", lb_pair, escrow, lower_bin_id, 1]`) is owned by the coin's `meteora_escrow` PDA with no operator; the escrow ATAs and the escrow itself hold nothing afterwards. This is the claim that liquidity is out of every wallet's reach; verify it, don't assume it.
- [ ] Confirm the migration authority never held withdrawable liquidity (check the escrow ATA's history).

### Mobile / in-wallet browser smoke (Phantom, Jupiter)

Load the web app at ~390px width (or open inside Phantom / Jupiter browser):

- [ ] Connect wallet sheet opens and net picker rows are tappable (≥44px hit).
- [ ] Board scrolls; King of the Hill stacks; footer does not cover content behind the URL bar (`dvh` / safe-area).
- [ ] Trade modal and launch wizard scroll inside the viewport with bottom safe inset.
- [ ] Rewards / crates controls remain reachable above the home indicator.

**Robinhood Chain**

- [ ] Fork rehearsal passed against the live chain before the broadcast: `MAINNET_FORK_RPC_RH=$RH_RPC_URL forge test --match-path test/fork/MainnetDeployFork.t.sol` (and `MAINNET_FORK_RPC_BASE=$BASE_RPC_URL` for Base) — the QuickNode mainnet endpoints from §0b.
- [ ] `launchpad.admin()` is the `TimelockController`, `pauser()` is the pauser key, the deployer holds no timelock role; every price source and the `ReferralVault` have `admin() == timelock`.
- [ ] `StonkzLaunchpad.migrator` is the `UniswapV3Migrator` (1% tier) and `migrationAuthority` is set.
- [ ] `priceSource()` is the `PythPriceSource`, `maxOracleStaleness` is the 90000 clamp, `StonkzRouter.pyth()` is `0x8250f4aF…1487a`.
- [ ] Launch a throwaway token through the router **with a Hermes update** and confirm it settled in one transaction; confirm a launch without one is refused `stale oracle`.
- [ ] Buy and sell through `StonkzRouter` and confirm the API returned `atomic: true` and it settled in **one** transaction.
- [ ] Graduate the throwaway token; confirm the pool on the explorer, `FeeLocker.lockOf(token)` names it, and `claimFees(token)` credits the ledgers.
- [ ] Claim a referral voucher against the funded vault; confirm the pauser can stop claims and cannot restart them.
- [ ] Confirm a trade against an unpinned base asset falls back rather than routing through an arbitrary pool.

**Both**

- [ ] The API is not holding any withdraw-authority key.
- [ ] Pause switches work (pause trading, confirm a buy is refused, unpause).
- [ ] `docs/real-vs-simulated.md` §3 and §4 updated to reflect what is now deployed.

---

## 5. What is still blocked after this runbook

Deploying does not make the product live. Still outstanding — see
[`mainnet-readiness.md`](mainnet-readiness.md) and
[`launch-checklist.md`](launch-checklist.md):

- **External audit** — internal review only; see `docs/security-review-findings.md`
  and `docs/audit-package.md`.
- **Keys and infra**: the Safe(s), pauser keys, cold withdraw authorities,
  a Hermes key — none of which this runbook can provision. (RPCs are done:
  QuickNode on every network, §0b.)
- **Solana mainnet governance** (Squads + time lock, pauser) is a separate
  track from the EVM handover described here.
