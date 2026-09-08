# `@stonkz/api`

The Hono API, the auth layer, the game ledger and the WebSocket gateway.
`@stonkz/indexer` imports the schema and the ledger from here, so this package
owns the database.

## Running it locally

Everything runs on your machine. Nothing in this repo provisions a cloud
resource.

```sh
docker compose up -d                        # postgres + redis
pnpm --filter @stonkz/api migrate           # apply drizzle/*.sql
pnpm --filter @stonkz/api dev               # :8787
pnpm --filter @stonkz/indexer dev           # replays the fixture scenario
```

A clean checkout works with no `.env` at all — every default in
[`src/env.ts`](src/env.ts) points at `docker compose up`. See
[`.env.example`](.env.example) for the full list.

If you already run Postgres on 5432, the container will fail to bind. Move it
and point the API at the new port:

```sh
POSTGRES_PORT=55432 docker compose up -d
DATABASE_URL=postgres://stonkz:stonkz@localhost:55432/stonkz pnpm --filter @stonkz/api migrate
```

`REDIS_URL=memory://` swaps Redis for an in-process fake, so the API runs with
Postgres alone. That fake is single-node: pub/sub reaches only subscribers in
the same process, which is correct for local dev and wrong for more than one
instance.

## Tests

```sh
pnpm typecheck
pnpm test
```

The suite needs neither Docker nor a network. Postgres is
[PGlite](https://pglite.dev) — Postgres compiled to WASM, in-process — so tests
execute the real migration history and real SQL, including partial unique
indexes, CHECK constraints and `date` arithmetic. Redis, both chain RPCs and the
price oracle are substituted by the fakes in `src/redis/memory.ts` and
`src/chain/fake.ts`.

Applying the migrations costs more than booting PGlite, and each test file pays
it in its own worker process, so `src/test/harness.ts` snapshots a migrated
database into `node_modules/.cache` and restores it. The cache key is a hash of
the migration SQL, so editing or adding a migration invalidates it.

## Migrations

Hand-written, numbered SQL in [`drizzle/`](drizzle), tracked by
`drizzle/meta/_journal.json` and applied by `src/db/migrate.ts`. That runner
exists rather than drizzle's per-driver migrators so one code path covers both
postgres-js and PGlite, and so `/health` can report the applied history.

Migrations are **forward-only**. The runner records applied migrations by tag
and never re-runs one, so editing a migration that has shipped is silent
schema drift — add a new file instead. `0004_index_advisor_prune.sql` is the
worked example: it drops two indexes `0003` created rather than editing `0003`.

`src/db/index-advisor.test.ts` runs `EXPLAIN` over every hot query with
sequential scans disabled, so dropping or shadowing an index fails a test
rather than a latency graph.

## Security headers

`src/app/security.ts` sets the API's own CSP. **`frame-ancestors` can only
travel as a real response header** — the `<meta http-equiv>` form is ignored by
browsers — which is why the web shell omits it and why it is set here.

That header protects this origin's responses only. The static host serving
`ston.kz` has to send its own copy for the app shell; a CSP on the API does
nothing for the page that calls it.

## Robinhood Chain

Chain facts are confirmed in [`docs/robinhood-chain.md`](../../docs/robinhood-chain.md).
Three of them shape this package:

- **Chain id 4663** (testnet 46630), gas token ETH. `EvmRpc.verifyChainId()`
  refuses to run against the wrong network, because 4663 and 46630 are one
  typo apart.
- **The public RPC is rate-limited and not for production.** It is the default
  so a fresh checkout works, and `NODE_ENV=production` refuses to boot on it.
  A wallet render reads a balance, so those limits arrive quickly.
- **ERC-4337 is first-class**, so smart-contract accounts are ordinary users.
  `verifySiweFull()` tries ECDSA and then falls back to ERC-1271
  `isValidSignature` against the claimed address. An `ecrecover`-only verifier
  rejects those accounts as "signature invalid", which tells the user nothing.
  ERC-6492 pre-deployment signatures are out of scope but would slot in as a
  third branch.

Robinhood Wallet is mobile-only — there is no browser extension, so there is
no desktop `window.ethereum` — which makes **WalletConnect a required
connector** rather than an optional one. That is the web track's work, but it
is why `/auth/nonce` returns the exact message to sign instead of expecting the
client to compose one: the mobile signing surface is not ours to control.

## Production deployment

A first **staging** deploy is live. See [`docs/cloud-deploy.md`](../../docs/cloud-deploy.md)
for the URLs and the `STONKZ_STAGING=1` caveats. Intended topology:

| Piece | Intended host | Notes |
| --- | --- | --- |
| Postgres | Neon | `DATABASE_URL` with `?sslmode=require`; `DATABASE_POOL_MAX` under Neon's pooler ceiling |
| Redis | Railway | `REDIS_URL`; needed for more than one API instance, since pub/sub crosses instances |
| API | Railway | `pnpm --filter @stonkz/api build && node dist/server.js` |
| Indexer | Railway (separate service) | One replica. Two would double-apply awards; the ledger's unique constraints would reject the duplicates, but the logs would be noise |
| Static web | any CDN | Must send its own CSP, including `frame-ancestors` |

Before a first deploy:

1. Set `JWT_SECRET` and `CRATE_HMAC_SECRET` to real values. The API refuses to
   boot in production on the dev defaults, and rotating `CRATE_HMAC_SECRET`
   changes every future crate roll.
2. Set `RH_RPC_URL` to a provider endpoint.
3. Set `RH_ALLOWED_CHAIN_IDS` to that environment's id alone. Accepting
   staging's id in production is a cross-environment replay path.
4. Set `CORS_ORIGINS` to the real origins, and drop the localhost entries.
5. Run `pnpm --filter @stonkz/api migrate` as a release step, before the new
   API starts.

## Runbooks

**Indexer replay (per chain).** Cursors live in `indexer_cursors`, one row per
net, and every award is keyed on `(wallet, tx_sig, reason)` so replaying is
idempotent rather than double-paying. Rewind one chain and let it catch up:

```sql
UPDATE indexer_cursors SET position = <chain_position> WHERE net = 'SOL';
```

Rewinding does not un-award anything; it re-derives the read tables and skips
ledger rows that already exist. `GET /health` reports per-chain lag and alerts
past `MAX_CHAIN_LAG_SECONDS`.

**Redis flush.** Everything in Redis is reconstructable: rate-limit counters,
the access-token deny-list, the 8-second quote cache. A flush re-admits
already-revoked *access* tokens until they expire on their own — at most
`ACCESS_TOKEN_TTL_SECONDS`. Refresh sessions are revoked in Postgres
(`sessions.revoked_at`) precisely so they survive this.

**JWT rotation.** Changing `JWT_SECRET` invalidates every access and refresh
token at once; clients re-authenticate through SIWS/SIWE. There is no dual-key
verification window yet, so this logs everyone out.

**Crate pause.** No feature flag exists yet. Today the lever is the rate limit
(`RATE_LIMITS.crate`) or removing the route. Cooldowns are enforced in the
`crate_state` upsert's `WHERE`, so a paused-and-resumed crate does not hand out
a free open.

**Treasury pause.** The API holds no withdrawal keys and exposes no claim
path — `GET /treasuries` is read-only. Halting accrual is an on-chain action,
not an API one.

**Aggregator outage.** `GET /tokens/:sym/quote` must return `NO ROUTE` rather
than falling back to charging a Stonkz fee on a hop that did not happen. Hop 1
carries `feeBps: 0` in every response for that reason.
