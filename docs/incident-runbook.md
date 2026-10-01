# Incident runbook

Short and operational. Who can stop what, and the first ten minutes of each
failure we expect. Longer background lives in `docs/indexer-runbooks.md`,
`docs/governance-handover.md`, `docs/admin-panel.md` and
`docs/cloud-deploy.md`.

Fill the placeholders (`<…>`) when the roles are assigned; until then the
answer to "who" is the owner's wallet.

| Role                                 | Holder                         | Reach                                            |
| ------------------------------------ | ------------------------------ | ------------------------------------------------ |
| On-call (first responder)            | `<name / handle>`              | `<pager / phone>`                                |
| Pauser key (EVM, per chain)          | `<hot ops key or 1-of-N Safe>` | can only set pause flags                         |
| Pauser key (Solana)                  | `<hot ops key>`                | same                                             |
| Admin (EVM)                          | `<Safe behind timelock>`       | unpause, config, upgrade; waits `MIN_DELAY`      |
| Admin (Solana)                       | `<Squads vault>`               | unpause, config                                  |
| Railway / Vercel / Neon owner        | `<account>`                    | deploys, rollbacks, restores                     |
| Admin-panel owners (`ADMIN_WALLETS`) | `<wallets>`                    | banner, notices, indexer controls, chain prepare |

Severity shorthand: **S1** funds or pricing at risk → pause first, ask later.
**S2** users cannot trade/launch but nothing is at risk → fix forward.
**S3** degraded (lag, stale board) → banner + fix.

---

## 1. Pause

Pause flags, both chains: `trading`, `launch`, `protocolWithdrawals`,
`opsWithdrawals`, and on EVM also `oracleGraduation`. The **pauser** can set
any flag instantly and can never clear one; clearing is an **admin** call
(`setPause` / `set_pause`), which after the handover means a timelocked
transaction. Referral claims have their own stop: `ReferralVault.pause()` on EVM and
`set_referral_paused(true)` on Solana, both callable by the launchpad pauser
or admin; only admin restarts them.

**Admin panel (preferred, works for every signer type).** `/admin` → Chain →
pick the net → **Prepare** → `pause` with the flags → sign in the browser
wallet, or export the Safe Transaction Builder JSON. Then **Submitted** with
the tx hash so the audit log carries it. API shape:
`POST /admin/chain/prepare/:net {action: {kind: "pause", trading: true, launch: true, protocolWithdrawals: false, opsWithdrawals: false[, oracleGraduation: false]}, signer, confirm: "PREPARE pause"}`.

**EVM from a shell** (pauser or admin key; addresses in
`programs/evm/deployments/<chainId>.json#contracts.StonkzLaunchpad`):

```bash
# halt trading + launches, leave withdrawals and graduation alone
cast send $LAUNCHPAD "pause(bool,bool,bool,bool,bool)" true true false false false \
  --rpc-url $RPC --private-key $PAUSER_KEY
# stop money leaving (S1 on the treasury side)
cast send $LAUNCHPAD "pause(bool,bool,bool,bool,bool)" false false true true false --rpc-url $RPC --private-key $PAUSER_KEY
# verify
cast call $LAUNCHPAD "tradingPaused()(bool)" --rpc-url $RPC
# unpause = admin only, all five flags are SET (not merged):
cast send $LAUNCHPAD "setPause(bool,bool,bool,bool,bool)" false false false false false --rpc-url $RPC --private-key $ADMIN_KEY
# after the handover: schedule that calldata on the timelock from the Safe, wait MIN_DELAY, execute.
```

**Solana from a shell.** There is no `solana` CLI verb for an Anchor
instruction; use the admin panel's prepared transaction (base64, pauser as
fee payer) and sign it with the pauser key, or `anchor` from
`programs/solana` with the committed IDL (`idl/launchpad.json`):
`pause(trading, launch, protocol_withdrawals, ops_withdrawals)` with accounts
`global` (PDA `["global"]`), `pauser_config` (PDA `["pauser"]`), `pauser`.
Unpause is admin's `set_pause(Option<bool> × 4)`.

**Then:** banner (§8), and record the tx in `#incidents` / the audit log.

## 2. Oracle outage

Symptoms: `/launch/prepare` returns **503 `oracle_stale`** (or
`oracle_unavailable`); launches fail; graduations do not fire; the admin
panel's Chain → Oracle legs show `age` past the staleness bound.

Launch pricing is Pyth via a Hermes update the API fetches
(`PYTH_HERMES_URL`, key `PYTH_HERMES_API_KEY` on Railway). Check in order:

1. **Hermes.** `curl -s "$PYTH_HERMES_URL/v2/updates/price/latest?ids[]=<feed>"`
   with the API key header. If Hermes is down, switch `PYTH_HERMES_URL` to
   the public endpoint (`https://hermes.pyth.network`, rate-limited) or a
   second provider and redeploy the API. No chain change needed.
2. **On-chain source.** `GET /admin/chain/oracle/:net` (or `cast call
$PYTH_SOURCE "price(address)" $BASE`) — is the feed configured, is the
   confidence band tripping, has the per-feed max age (120 s) been exceeded
   while Hermes was fine? A stale read with a healthy Hermes means the router
   is not posting the update: check `*_ROUTER_ADDRESS` points at a router
   that answers `pyth()`.
3. **Stock bases (RH).** `StockPriceSourceV2` falls through Pyth equity →
   V3 TWAP → attested quote → last close → push. If every leg is dark, the
   push leg is the manual override: admin panel Chain → Prepare →
   `pushPrice` on `PushPriceSource` (oracle authority). DefiLlama outage =
   no attestations; launches of stock bases degrade to the other legs.
4. **Solana.** `sync_price_from_pyth` is permissionless and bundled into the
   launch; if Pyth's push feed itself is stale, `push_price` from the oracle
   authority (`scripts/push-oracle-prices.sh`) is the fallback and the
   staleness bound is `set_max_oracle_staleness` (admin).
5. If a price looks **wrong** rather than stale: pause `launch` and
   `oracleGraduation` (EVM) immediately (S1), then investigate. A wrong
   price cannot move curve reserves, but it can mis-price a launch or a
   graduation.

Do not raise `maxOracleStaleness` to "make it work"; that is the control
that stops a stale price from pricing a graduation.

## 3. Indexer lag or dead letters

Symptoms: board/tape stale; API `/health` shows a chain `degraded` with
`lagSeconds` climbing; indexer `/health` returns 503; `deadLetters > 0`.

1. `curl $INDEXER/health` — which net, how far behind, `failedAttempts`.
2. Lag only: usually RPC. Check the RPC provider's status, then swap the
   net's RPC URL (§6) and let it catch up. **Never run two replicas**
   (`docs/indexer-runbooks.md` §2); the advisory lock needs Neon's direct
   host.
3. Solana > 20,000 signatures behind: the runner throws
   `SolanaRangeTooBusyError` and will dead-letter the range after 5
   attempts. Narrow the window with the backfill CLI rather than waiting.
4. Dead letters: `GET /dead-letters` or admin panel Tokens → Indexer. For a
   transient cause, **retry** (`POST /admin/indexer/dead-letters/:id/retry`).
   For a decode bug: patch, deploy, then
   `pnpm --filter @stonkz/indexer backfill -- --net <NET> --from <x> --to <y> --resolve`.
   Never move the cursor past a gap without a dead-letter row.
5. Reorg on EVM: handled automatically up to the confirmation depth; deeper
   needs `--rollback-first` on the range.
6. Banner "board may be delayed" while catching up (§8); trades themselves
   are unaffected (chain is the truth; `/trade/confirm` shows the trader
   their own fill provisionally).

## 4. Key compromise

Rotate first, investigate second. None of the API keys can move funds
directly; each has an on-chain bound and an on-chain kill switch.

| Key                                                     | Blast radius                                                                           | Stop                                                                                                | Rotate                                                                                                                                                 |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stock price attester (`STOCK_PRICE_ATTESTER_KEY`)       | Launch prices for stock bases, inside V2's cross-check bands, for `attestMaxAge` 300 s | Pause `launch` (EVM)                                                                                | Generate a new key, `StockPriceSourceV2.setAttester(new)` (admin → timelock on mainnet), set the env on Railway, redeploy, unpause.                    |
| Referral signer (`REFERRAL_SIGNER_KEY_EVM` / `_SOL`)    | At most the vault's `maxPerDay` (1 ETH / 1 SOL on testnets) per day until rotated      | `ReferralVault.pause()` (EVM) / `set_referral_paused(true)` (Solana), pauser or admin               | `ReferralVault.setSigner(new)` / `set_referral_signer(new)`, env on Railway, redeploy. Vouchers are cumulative, so nothing already paid is re-payable. |
| Solana oracle authority                                 | Pushed prices for pushed bases                                                         | `set_max_oracle_staleness` low / pause launch                                                       | `set_oracle_authority(new)` (admin).                                                                                                                   |
| Admin EOA (testnet) / Safe signer                       | Everything admin can do; **cannot withdraw** treasury                                  | If the admin is still an EOA: `proposeAdmin(newSafe)` + `acceptAdmin` immediately; set a new pauser | Mainnet: the Safe's own signer rotation; the timelock delay is the window to `cancel(id)` anything scheduled by the attacker.                          |
| Pauser key                                              | A halt until admin unpauses                                                            | —                                                                                                   | `setPauser(new)` / `set_pauser(new)`; `address(0)` / `Pubkey::default()` removes the role.                                                             |
| Protocol / ops withdraw authority                       | That leg's accrued balance, every base                                                 | Pause `protocolWithdrawals` / `opsWithdrawals` **now**                                              | `setWithdrawAuthorities` / `set_withdraw_authorities` to new keys (two-step on Solana), then unpause.                                                  |
| `ADMIN_JWT_SECRET` / `JWT_SECRET` / `CRATE_HMAC_SECRET` | Forged sessions / admin tokens / crate seeds                                           | Rotate on Railway and redeploy: every token and pending commitment is invalidated                   | Same.                                                                                                                                                  |
| Railway / Vercel / Neon account                         | Deploys, env (all of the above), data                                                  | Revoke sessions, rotate account credentials, re-issue every env secret                              | Treat every key above as leaked.                                                                                                                       |

After rotating, pull the admin audit log (`GET /admin/audit.csv`) and the
Railway deploy history for the window.

## 5. Database restore (Neon)

Neon keeps point-in-time history for the project's retention window
(`<retention: set in Neon → Project → Settings; recommend 7 days on the paid
plan>`). Restore is a **branch**, never an in-place rewrite:

1. Pause the indexer (scale `stonkz-indexer` to 0 on Railway) and, if writes
   matter, pause trading (§1). The API can stay up read-only.
2. Neon console → Branches → **Restore** from `main` at the timestamp just
   before the damage (or **Create branch** from a point in time). Name it
   `restore-<date>`.
3. Point a laptop at the branch's direct URL and sanity-check: row counts in
   `indexer_cursors`, `trades`, `game_ledger`; the last migration in the
   migrations table.
4. Either promote the branch (Neon "Restore" does this: `main` becomes the
   restored state and the old `main` is kept as a backup branch), or switch
   `DATABASE_URL` on both Railway services to the branch (pooled host for the
   API, direct host for the indexer).
5. Start the indexer. It replays from its committed cursor; anything the
   restore dropped between the restore point and now is re-ingested from the
   chain (archive RPC if the gap is older than the provider's retention).
   Game-ledger rows written by the API in that window are **not**
   recoverable from the chain; reconcile with `scripts/reconcile-fees.ts`
   and the audit log.
6. Unpause; banner update.

Weekly: confirm a branch-from-PITR actually works (create, query, delete).

## 6. RPC failover

Each net's RPC is one env var per service (`RH_RPC_URL`, `BASE_RPC_URL`,
`ARC_RPC_URL`, `SOLANA_RPC_URL`; the API also honours `SOLANA_PRIVATE_RPC_URL`
for broadcast). The API's `/health` probes each head and marks a net `down`
on failure; the indexer's `/health` shows `failedAttempts`.

1. Confirm it is the provider: `cast block-number --rpc-url $RPC` /
   `solana epoch-info -u $RPC` against a second provider.
2. Change the var on Railway for **both** services and redeploy. Keep the
   second provider's URL in the Railway variable description so this is a
   paste, not a search.
3. Pyth Hermes is separate (§2). Helius / WalletConnect on the web are build
   env on Vercel and need a redeploy there.

## 7. Roll back a bad API or indexer deploy (Railway)

1. Railway → service → **Deployments** → the last good deployment → **⋯ →
   Redeploy**. Health check (`/health/live` API, `/health` indexer) gates the
   swap; the old container keeps serving until the new one passes.
2. CLI: `railway redeploy --service stonkz-backend` redeploys the current
   image; for a specific earlier image use the dashboard.
3. Migrations are **forward-only**. If the bad deploy ran a migration, do not
   roll the code back past it; fix forward or restore the DB (§5) to just
   before the release and redeploy the previous image.
4. Web (Vercel): Deployments → previous → **Promote to Production**, or
   `vercel rollback`.

## 8. Communication

Banner is the first thing users see and needs no deploy: `/admin` → Comms →
**Banner** (moderator role or above), or
`PUT /admin/comms/banner {text, severity: "info" | "warn" | "critical"}`.
It reaches the terminal within a refresh via `GET /platform/status`.
Notices and maintenance windows go through `POST /admin/notices`.

Templates (keep to one line; the banner is narrow):

- **Pause:** `Trading on <NET> is paused while we investigate <what>. Funds on the curve are safe. Updates here.`
- **Oracle:** `Launches are delayed: the price feed is catching up. Trading is unaffected.`
- **Indexer:** `Board and tape may lag by a few minutes. Your trades are confirmed on chain as usual.`
- **Maintenance:** `Maintenance <HH:MM–HH:MM UTC>: trading stays open, the site may be read-only.`
- **All clear:** `Resolved: <one line>. Thanks for your patience.`

Post the same line in `<status page / X / Discord>` and clear the banner
when done (empty text).

## 9. After any S1/S2

Within 48 h: a short post-mortem in `docs/` (timeline, blast radius, what
paused, what we change), and if a key or address changed, update
`programs/*/deployments/*.json` and run `node scripts/emit-chains.mjs`.
