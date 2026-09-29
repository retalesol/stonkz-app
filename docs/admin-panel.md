# Admin panel

Operator console for Stonkz: `apps/web/admin.html` (`/admin` in production, `/admin.html` on the Vite dev server) against `apps/api`'s `/admin/*` routes. The server **never holds a chain key**: every on-chain admin action is prepared as unsigned calldata / an unsigned Solana transaction and signed in the operator's browser wallet (or exported for a Safe).

## Architecture

```
apps/api/src/admin/            apps/api/src/routes/            apps/web/src/admin/
  roles.ts        roles, ranks    admin.ts          step-up, me,    main.ts      nav, hash router, login
  token.ts        admin JWT                         TOTP, access,   api.ts       bearer client (sessionStorage)
  service.ts      step-up, TOTP,                    audit, mount    auth.ts      connect → SIWS/SIWE → step-up
                  roles           admin-dashboard.ts               ui.ts        html``, dialogs, typed confirm
  totp.ts         RFC 6238        admin-settings.ts                banner.ts    public banner for the terminal
  audit.ts        append-only log admin-users.ts                   views/       dashboard, settings, users,
  settings.ts     DB > env knobs  admin-tokens.ts   + /admin/indexer            tokens, chain, comms, audit,
  moderation-gate.ts bans/flags   admin-chain.ts                                access
  chain-ops.ts    encoders/reads  admin-comms.ts                 apps/web/public/admin/admin.css (static)
  stats.ts, indexer-control.ts   admin-public.ts   GET /platform/status
  middleware.ts   requireAdmin()
```

`deps.admin` (`AdminServices`) is built once in `app/deps.ts` and holds `auth`, `tokens`, `audit`, `settings`, `gate`. Migration **`0024_admin_panel`** adds `admin_roles`, `admin_totp`, `admin_challenges`, `admin_audit_log` (+ append-only trigger), `platform_settings`, `user_moderation`, `token_moderation`, `admin_notices`, `admin_jobs`.

## Security model

- **Identity** = wallet address, net-agnostic (EVM lower-cased, Solana verbatim). `ADMIN_WALLETS` bootstraps `owner`; `admin_roles` adds/overrides `owner | admin | moderator | viewer`. Env owners always win and cannot be revoked through the API.
- **Auth** = the normal SIWS/SIWE session **plus** a step-up: `GET /admin/auth/challenge` (needs the access token, wallet must hold a role) → the wallet signs a fresh message with a nonce (5-min TTL, single use, message rebuilt and compared server-side) → `POST /admin/auth/verify` mints a **15-minute admin JWT** (own secret, `typ: admin`, `aud: stonkz-admin`, Redis deny-list on logout). Access tokens are never accepted on `/admin/*`; admin tokens are never accepted elsewhere.
- **TOTP** (RFC 6238, `node:crypto`, secret AES-GCM-sealed at rest): `POST /admin/totp/enrol` → `confirm {code}` (revokes the current pre-MFA token) → every later step-up needs a code; a code is accepted once per 30-s step. `disable {code}` needs a live code.
- **`requireAdmin(role)`** on every route: IP allowlist → admin token → role re-read from DB (revokes land before expiry) → TOTP enforced if enrolled → rank check. Non-admins get **404** everywhere (same body as an unknown route); a real admin with too low a role gets 403.
- **Rate limit** on the two auth endpoints: 10/min per wallet (`admin_auth` bucket). `ADMIN_IP_ALLOWLIST` (IPv4 CIDR / exact IPv6) gates the auth endpoints and every admin route, under the same trusted-proxy rules as the rate limiter.
- **Audit**: every mutating route calls `audited()` → `admin_audit_log` (actor, role, action, target, before/after JSON, IP, request id, ok). UPDATE/DELETE are refused by a trigger. Step-up successes and failures are logged too.
- **Destructive actions** need a typed phrase in `confirm` (`HIDE PEPE`, `REINDEX RH`, `SET CURSOR RH`, `DISCARD 12`, `REVOKE 0x1234`, `ANNOUNCE`, `PREPARE setPause`, …); the UI shows the exact phrase.
- Web: separate Vite entry, static stylesheet, CSP `script-src 'self'`, all markup through `lib/html.ts` (escaping template + `no-raw-innerhtml`), bearer tokens only (no cookies → no CSRF), admin token in `sessionStorage` for the tab.

## Env

| Var                           | Default                                | Meaning                                                            |
| ----------------------------- | -------------------------------------- | ------------------------------------------------------------------ |
| `ADMIN_WALLETS`               | empty (panel dark)                     | Comma list of owner wallet addresses.                              |
| `ADMIN_JWT_SECRET`            | `sha256("stonkz-admin:" + JWT_SECRET)` | Signs admin tokens and seals TOTP secrets. Set explicitly in prod. |
| `ADMIN_TOKEN_TTL_SECONDS`     | `900`                                  | Admin token life.                                                  |
| `ADMIN_CHALLENGE_TTL_SECONDS` | `300`                                  | Step-up nonce life.                                                |
| `ADMIN_IP_ALLOWLIST`          | empty (no gate)                        | `1.2.3.4,10.0.0.0/8,2001:db8::/32`.                                |

Web: `VITE_API_URL` (already used by the terminal). Vercel rewrites `/admin` → `/admin.html` (`apps/web/vercel.json`).

## Bootstrapping the first owner

1. Apply migrations (`pnpm --filter @stonkz/api migrate`).
2. Set `ADMIN_WALLETS=<your wallet address>` (and `ADMIN_JWT_SECRET`) on the API and restart.
3. Open `/admin`, pick the net your wallet is on, connect, sign the SIWS/SIWE sign-in, sign the step-up message.
4. **Access → Enrol TOTP** (recommended), then **Grant a role** for the rest of the team. DB-granted owners can be managed in the panel; env owners only via env.

## Routes

Auth (normal access token): `GET /admin/auth/challenge`, `POST /admin/auth/verify {message, signature, totp?}`.
Admin token: `GET /admin/me`, `POST /admin/auth/logout`, `POST /admin/totp/{enrol|confirm|disable}`, `GET|PUT|DELETE /admin/access/roles[/:wallet]` (owner), `GET /admin/audit`, `GET /admin/audit.csv`.

| Area      | Routes                                                                                                                                                                                                                                       | Role                                                                                                                         |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Dashboard | `GET /admin/dashboard` (health, per-net lag, RPC error rates, WS gauge, launches/trades/volume/fees today & 7d, top tokens, alerts)                                                                                                          | viewer                                                                                                                       |
| Settings  | `GET /admin/settings`, `PUT /admin/settings/:key {value}`, `DELETE /admin/settings/:key`                                                                                                                                                     | viewer / admin                                                                                                               |
| Users     | `GET /admin/users?q&net`, `GET /admin/users/:net/:wallet`, `PUT …/moderation`, `POST …/reset-profile`, `POST …/sessions/revoke`, `POST …/grant {asset: SP\|CRATE, delta, tier?, reason}`                                                     | viewer / moderator / admin (grant)                                                                                           |
| Tokens    | `GET /admin/tokens?q&net`, `GET /admin/tokens/:net/:mint`, `PUT …/moderation` (featured, kothOverride, hidden, scamWarning), `PATCH …/metadata`, `POST …/reindex`                                                                            | viewer / moderator / admin                                                                                                   |
| Indexer   | `POST /admin/indexer/reindex {net,from,to}`, `GET /admin/indexer/commands`, `GET /admin/indexer/cursors`, `POST /admin/indexer/cursors/:net {position}` (owner), `GET /admin/indexer/dead-letters`, `POST …/:id/retry`, `POST …/:id/discard` | admin / owner                                                                                                                |
| Chain ops | `GET /admin/chain/state`, `GET /admin/chain/vaults/:net`, `GET /admin/chain/oracle/:net`, `POST /admin/chain/prepare/:net {action, signer, confirm}`, `POST /admin/chain/submitted {net, kind, txHash}`                                      | viewer / admin (owner for withdraw, proposeAdmin, setMigrator, setWithdrawAuthorities, setPriceSource, set_oracle_authority) |
| Comms     | `GET /admin/notices`, `PUT /admin/comms/banner`, `POST /admin/notices`, `PATCH                                                                                                                                                               | DELETE /admin/notices/:id`, `POST /admin/comms/announce`                                                                     | moderator |
| Public    | `GET /platform/status?net` — banner, live notices, maintenance windows, feature flags                                                                                                                                                        | anyone                                                                                                                       |

### Chain actions prepared

EVM (`StonkzLaunchpad` unless noted): `setPause`, `pause` (pauser, set-only), `setPauser`, `setPriceSource`, `setMaxOracleStaleness`, `setMigrator`, `setWithdrawAuthorities`, `proposeAdmin`, `acceptAdmin`, `withdrawTreasury(which 0|1|2, baseToken, amount, to)`, `pushPrice` (on a `PushPriceSource`). Each returns `{to, data, value}` plus a **Safe Transaction Builder** JSON export.
Solana (`launchpad` program): `set_pause`, `pause`, `set_pauser`, `set_oracle_authority`, `set_max_oracle_staleness`, `set_withdraw_authorities`, `propose_admin`, `accept_admin`, `withdraw_treasury`, `push_price`. Each returns an unsigned legacy transaction (base64) with the signer as fee payer.
Live state shown before/after: admin, pendingAdmin, pauser, price source / oracle authority, withdraw + migration authorities, staleness, pause flags, token count, indexed treasuries, per-base vault balances, oracle legs (price, age, fresh vs staleness bound).

`chain-ops.test.ts` pins every EVM selector to its Solidity signature and every Solana discriminator to Anchor's `sha256("global:<name>")`, plus Borsh `Option<bool>`/enum encodings and account layouts.

## Settings: wired vs stored-only

Read through `deps.admin.settings` (**DB row > env/default**, cached in-process, invalidated over Redis `admin:settings`, 15-s staleness bound):

| Key                                                      | Wired at                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `features.launch.<NET>`                                  | `POST /launch/prepare` (`gate()` → 503 `feature_disabled`)                           |
| `features.trading.<NET>`                                 | `POST /trade/prepare`                                                                |
| `features.chat`                                          | `ChatService.send` (WS + REST → `chat_disabled`)                                     |
| `banner.text`, `banner.severity`                         | `GET /platform/status` → terminal banner (`apps/web/src/admin/banner.ts`, live mode) |
| `limits.launch.perWallet`, `limits.launch.windowSeconds` | `routes/launch.ts` `walletLaunchRule()` (prepare peek + confirm spend)               |
| `limits.chat.limit`, `limits.chat.windowSeconds`         | `ChatService.send`                                                                   |
| `moderation.words`                                       | `moderateLaunch()` (launch name/ticker/descr) and `isFlagged()` (chat)               |

Stored + audited, **no read site yet**: `features.crates`, `features.referrals`, `limits.launch.perIp`, `limits.uploads.perHour` (static `RATE_LIMITS` middleware), `baseMints.overrides.<NET>` (registry is built once from env at boot), `crates.rwaCatalog`, `crates.dropTables`, `sp.levels`, `referrals.tiers` (shared constant tables), `thresholds.dust.<NET>`, `thresholds.whale.<NET>` (`GameAwards` takes env at construction), `oracle.priceDivergenceBps`, `oracle.hermesEnabled`, `oracle.defillamaEnabled`. The Settings view labels each key WIRED / STORED.

## Moderation enforcement points

- `user_moderation` via `gate()` middleware: launch ban + launch flag on `/launch/prepare`; trade ban + trading flag on `/trade/prepare`; comments ban on `POST /wall/:net/:addr`. Chat ban, shadow mute and the chat flag inside `ChatService.send` (covers WS `send_chat` and `POST /chat/:net/:room`). Bans honour `until`.
- Shadow mute: the message persists `flagged = true` (never broadcast, never replayed); the sender sees `ok`.
- `token_moderation.hidden`: filtered out of `GET /tokens` (list + lane counts). `kothOverride`: replaces that net's crown in `GET /koth` (one per net). `featured` / `scamWarning`: stored and returned by the admin API; the board does not render them yet.
- Session revoke sets `sessions.revoked_at` (refresh dies); an already-issued access token lives out its ≤15-min TTL.

## Indexer commands

Reindex / retry / set-cursor publish `{id, command, issuedBy, issuedAt}` on Redis channel **`indexer:control`** and mirror it under `indexer:cmd:<id>` (24 h TTL); rows also land in `admin_jobs`. `receivers` in the response says whether any indexer was subscribed. **The indexer does not consume these yet** (`apps/indexer` is outside this change): until it does, use `pnpm --filter @stonkz/indexer backfill -- --net <NET> --from <a> --to <b>` with the range shown in the panel. `POST /admin/indexer/cursors/:net` does move the live `indexer_cursors.position` directly (hash/signature cleared, failures reset).

## Tests

`apps/api/src/admin/totp.test.ts` (RFC 6238 vectors, window, replay, sealing), `settings.test.ts` (DB > env, hot reload, validation, missing table), `chain-ops.test.ts` (selectors/discriminators/layouts), `apps/api/src/routes/admin.test.ts` (404 for strangers, step-up EVM + Solana, tamper/replay/expiry, token TTL/logout, rate limit, IP allowlist, roles 403/404, TOTP lifecycle, audit rows on every mutating route + CSV + append-only, bans/flags at the integration points, shadow mute, hidden tokens, KOTH pin, metadata edit, grants, session revoke, chain prepare + role gate, dashboard).

## Deferred

- Indexer-side consumer for `indexer:control` (reindex is durable-queued, not executed).
- Board rendering of `featured` / `scamWarning`; comments/likes ban on wall likes; uploads rate limit and per-IP launch limit from settings (middleware is static).
- Read sites for the stored-only settings above.
- Solana on-chain vault balances (panel shows PDAs + indexed totals; EVM shows live `protocolRevenue/stonkzOps/stonkzBurn`).
- Pushing a fallback price on EVM assumes the launchpad's `priceSource` is a `PushPriceSource`; Pyth/Stock sources expose no push and show `oracleAuthority: null`.
- Revoking a session cannot kill an already-minted access token (no jti on the session row).
