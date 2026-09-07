# Deployment runbook (Solana + Robinhood Chain)

Deploying the programs and telling the API about them. This is Phase D of the
post-build forward plan.

**Nothing in this repo has ever been deployed.** There is no recorded program
ID or contract address for either chain beyond the placeholder in
`Anchor.toml`. Until the steps below are executed, `docs/real-vs-simulated.md`
§3 stays MISSING and the RH atomic trade path stays inactive.

Two things this runbook takes seriously:

1. **The deployer key holds no lasting privilege.** Both deploy scripts set the
   admin/authorities to keys you supply, not to whoever signed the deployment.
   Steps that need the admin key are printed for that signer to execute rather
   than attempted by the deployer.
2. **No privileged value has a default.** Every authority is a required env
   var. A missing one aborts before anything is sent.

---

## 0. Key custody, before anything else

Five distinct roles. Do not collapse them, and do not put any of them in the
API process's environment.

| Role | Purpose | Must be |
|---|---|---|
| Deployer | Signs the deployment transactions only | Hot is acceptable; holds nothing afterwards |
| Admin | Pause switches, oracle config, migrator wiring. **Cannot move money.** | Multisig or cold key |
| Protocol withdraw authority | Withdraws the 20% protocol revenue | Multisig or cold key |
| Ops withdraw authority | Withdraws the 10% `$STONKZ` ops vault | Multisig or cold key, **distinct from protocol** |
| Migration authority | Runs graduation migration (Solana: pays pool rent; EVM: triggers migrate) | Warm operational key, funded |
| Oracle authority (Solana only) | Pushes base-mint USD prices | Warm operational key, funded |

Both deploy scripts **refuse** a deployment where the protocol and ops
authorities are the same key, or where the admin equals either withdraw
authority. Those separations are enforced on-chain by distinct PDAs/vaults;
sharing a signer would undo that off-chain.

The two withdraw authorities are the only keys that can move settled revenue.
`programs/SPEC.md` §4 is explicit that neither may be a server hot key.

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

The checked-in program ID (`FF1f3V47FtApwWWMHX462Gm7NVqNpUJ7K4yqKrYGSMbg`) is a
placeholder from local development. Generate a real one for any shared cluster
and update `Anchor.toml`, `declare_id!`, and `SOLANA_LAUNCHPAD_PROGRAM_ID`
together.

### 1.2 Initialize

`anchor deploy` does not create the `Global` config account, and every
instruction fails until it exists.

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
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

The script also derives Raydium's `AmmConfig` (index 0, the permissionless tier
with no OpenBook market requirement) from the CPMM program ID and
**cross-checks the derivation** against the known devnet address. If Raydium
ever changes its seed layout, the script aborts rather than writing a wrong
CPI target into `Global`.

### 1.3 Raydium config (admin key)

`set_raydium_config` is admin-gated. If the deployer is the admin (devnet
convenience) the script sends it; otherwise it prints the call for the admin
signer:

| Cluster | Raydium CPMM program |
|---|---|
| mainnet-beta | `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C` |
| devnet | `DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb` |

**Until this lands, `migrate_liquidity` fails closed** (Anchor's `address = …`
constraint against `Pubkey::default()`) and nothing can graduate. That is the
intended fail-closed behaviour, not a bug.

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

---

## 2. Robinhood Chain

### 2.1 Deploy

```bash
cd programs/evm
export STONKZ_ADMIN=0x...
export STONKZ_PROTOCOL_WITHDRAW_AUTHORITY=0x...
export STONKZ_OPS_WITHDRAW_AUTHORITY=0x...
export STONKZ_MIGRATION_AUTHORITY=0x...

# Dry run (no --broadcast)
forge script script/Deploy.s.sol:Deploy --rpc-url "$RH_RPC_URL" -vvv

# Execute
forge script script/Deploy.s.sol:Deploy --rpc-url "$RH_RPC_URL" --broadcast --verify -vvv
```

The script deploys, in this order (forced by immutables):
`ChainlinkPriceSource` → `StonkzLaunchpad` → `UniswapV2Migrator` →
`StonkzRouter`.

Before deploying anything it asserts:

- The chain ID is 4663 or 46630, so RH-pinned addresses aren't used on a chain
  where they hold no code.
- The Universal Router, Uniswap v2 factory, WETH9, and Chainlink ETH/USD
  addresses from `src/config/RobinhoodChain.sol` **actually have code** on the
  chain you pointed at. A typo or wrong-fork RPC fails here instead of on a
  user's first trade.

### 2.2 Admin steps (admin key)

The script prints these with concrete arguments. They are not executed by the
deployer because the deployer is not the admin.

1. `ChainlinkPriceSource.setFeed(WETH9, ETH/USD, maxAge, minPrice1e6, maxPrice1e6)`
2. `ChainlinkPriceSource.setFeed(USDG, USDG/USD, …)` — for any USD-denominated base
3. `StonkzLaunchpad.setMigrator(migrator, migrationAuthority)`
4. `StonkzLaunchpad.setMaxOracleStaleness(90000)`

**On step 4, read this before typing a number.** Robinhood Chain's Chainlink
feeds have an **86400-second (24h) heartbeat**, not a minute-scale one. A
mainnet-Ethereum instinct (say 90 seconds) makes oracle graduation permanently
unreachable. `RobinhoodChain.ORACLE_MAX_AGE_SECS` is heartbeat + 1h grace and
is the value to use. This exact bug was already caught once during the build.

Until step 3 lands, graduation cannot migrate. Until steps 1-2 land,
`createToken` refuses that base asset.

---

## 3. Configure the API and indexer

Both deploy scripts print these lines. Set them in the API's environment:

```
SOLANA_LAUNCHPAD_PROGRAM_ID=<solana program id>
RH_LAUNCHPAD_ADDRESS=0x<StonkzLaunchpad>
RH_ROUTER_ADDRESS=0x<StonkzRouter>
RH_V3_FEE_TIER_OVERRIDES=<see below>
```

`apps/api/src/env.ts` refuses to boot in production with
`RH_LAUNCHPAD_ADDRESS` unset. `RH_ROUTER_ADDRESS` is *allowed* to stay at the
zero address — RH trading then degrades to the documented non-atomic
`EvmStep[]` sequence rather than failing. **That degradation is not acceptable
for real funds**: a trader who stops signing partway is left holding an
intermediate asset. Set it.

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

An unpinned base asset falls back to the non-atomic path by design. Leaving it
unpinned is safer than guessing.

---

## 4. Verification, before any real user

Do all of these against the deployment, not against a local test.

**Solana**

- [ ] `Global` exists with the intended admin/authorities (read the account, don't trust the script's log).
- [ ] `raydium_program` and `raydium_amm_config` are set and match §1.3.
- [ ] Protocol and ops vault PDAs are distinct addresses.
- [ ] Launch a throwaway token, buy, sell. Confirm the 20/70/10 split lands in the three expected places.
- [ ] Force a graduation. On the explorer, confirm the Raydium pool exists and the **LP mint supply is 0**. This is the claim that liquidity is gone; verify it, don't assume it.
- [ ] Confirm the migration authority never held the LP (check the escrow ATA's history).

**Robinhood Chain**

- [ ] Fork test passes against the live chain: `RH_RPC_URL=<rpc> forge test --match-test Fork` (asserts the pinned Universal Router and Permit2 hold code on 4663).
- [ ] `StonkzLaunchpad.migrator` and `migrationAuthority` are set.
- [ ] `maxOracleStaleness` is heartbeat-scale (90000), not minute-scale.
- [ ] Buy and sell through `StonkzRouter` and confirm the API returned `atomic: true` and it settled in **one** transaction.
- [ ] Graduate a throwaway token; confirm LP landed at `0x…dEaD` on the explorer.
- [ ] Confirm a trade against an unpinned base asset falls back rather than routing through an arbitrary pool.

**Both**

- [ ] The API is not holding any withdraw-authority key.
- [ ] Pause switches work (pause trading, confirm a buy is refused, unpause).
- [ ] `docs/real-vs-simulated.md` §3 and §4 updated to reflect what is now deployed.

---

## 5. What is still blocked after this runbook

Deploying does not make the product live. Still outstanding:

- **Real wallets** (Phase B) — nothing can be signed by a real user until then.
- **Real indexer ingestion** (Phase C) — the board still shows fixture data even against deployed programs.
- **External audit** (Phase H) — internal review only; see `docs/security-review-findings.md`.
