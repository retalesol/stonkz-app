# Cloud deploy (Railway + Vercel + Neon)

The topology `apps/api/README.md` documented but had not executed.

| Piece | Host | Service / project |
|---|---|---|
| Postgres | Neon project **Stonkz** (`lucky-hat-60240483`) | database `neondb` |
| Redis | Railway project **stonkz-app** | added as a plugin |
| API | Railway | `stonkz-backend` (keep the name; it is the API) |
| Indexer | Railway | `stonkz-indexer` |
| Static web | Vercel project **stonkz-app** | Vite build of `apps/web` |

This is a **staging** stack. `STONKZ_STAGING=1` lets the API boot in
`NODE_ENV=production` without a deployed launchpad or a paid RH RPC.
`INDEXER_SOURCE=fixtures`. Do not market it as live chain data.

## Neon

- API `DATABASE_URL`: the **pooled** host (`ep-…-pooler.…`) with
  `sslmode=require`.
- Indexer `DATABASE_URL`: the **direct** host (`ep-…` without `-pooler`).
  The single-writer lock is a session-level `pg_try_advisory_lock` and
  does not survive transaction pooling. See `docs/indexer-runbooks.md` §1.
- Migrations run once, from a laptop, against the direct URL:
  `pnpm --filter @stonkz/api migrate`. The API does not migrate on boot
  when `NODE_ENV=production`.

## Railway images

Build context is the repo root.

- `deploy/Dockerfile.api` → `stonkz-backend`. Set
  `RAILWAY_DOCKERFILE_PATH=deploy/Dockerfile.api`.
- `deploy/Dockerfile.indexer` → `stonkz-indexer`. Set
  `RAILWAY_DOCKERFILE_PATH=deploy/Dockerfile.indexer`.

Both run `tsx` because workspace packages export TypeScript.

## Vercel

`vercel.json` at the repo root installs the workspace and builds
`@stonkz/web`. Required build env:

- `VITE_API_MODE=live`
- `VITE_API_URL=https://<railway-api-domain>`
- `VITE_WS_URL=wss://<railway-api-domain>`

Practice wallet stays off. WalletConnect stays off until a project id is
set.

## After a program deploy

Unset `STONKZ_STAGING`, set `RH_LAUNCHPAD_ADDRESS`, `RH_ROUTER_ADDRESS`,
`RH_RPC_URL` (provider), `INDEXER_SOURCE=chain`, and the start
slot/block. Then this stack is still not a mainnet claim — see
`docs/launch-checklist.md`.
