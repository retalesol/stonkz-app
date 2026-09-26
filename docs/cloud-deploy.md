# Cloud deploy (Railway + Vercel + Neon)

The topology `apps/api/README.md` documented but had not executed.

| Piece      | Host                                           | Service / project                               |
| ---------- | ---------------------------------------------- | ----------------------------------------------- |
| Postgres   | Neon project **Stonkz** (`lucky-hat-60240483`) | database `neondb`                               |
| Redis      | Railway project **stonkz-app**                 | added as a plugin                               |
| API        | Railway                                        | `stonkz-backend` (keep the name; it is the API) |
| Indexer    | Railway                                        | `stonkz-indexer`                                |
| Static web | Vercel project **stonkz-app**                  | Vite build of `apps/web`                        |

This is a **staging** stack. `STONKZ_STAGING=1` lets the API boot in
`NODE_ENV=production` without a paid RH RPC / launchpad (router is still
required). `INDEXER_SOURCE=chain` with start block/slot set. Board/tape are
chain-backed — do not market staging as mainnet.

Live URLs (first deploy, 2026-09-08):

| Surface        | URL                                                     |
| -------------- | ------------------------------------------------------- |
| Web            | https://project-2hx9a.vercel.app                        |
| API            | https://stonkz-backend-production.up.railway.app        |
| Indexer health | https://stonkz-indexer-production.up.railway.app/health |

The indexer's `/health` reports `mode: "chain"` with per-net cursors against
RH testnet + Solana devnet tips.

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

## State audit, 2026-09-25

Checked against the Vercel API and the local checkout while planning the
Base + Arc rollout (`~/.claude/plans/starry-percolating-clover.md`).

- **Production deploy** `dpl_8nLdMepTj3kFVrAsGaKxRxaReNs8` was built from
  `main @ 284ae9a` via the CLI (`source: cli`), not from GitHub. That commit
  and the two before it (`7c8071e`, `f62a3a3`) were **never pushed** to
  `origin/main`, so neither the CI nor the E2E workflow has run on the
  three-net code. Push `main` before the next deploy.
- **Vercel env** for production carries `VITE_API_MODE`, `VITE_API_URL`,
  `VITE_WS_URL`, `VITE_CLUSTER`, the RH and Base chain/RPC/explorer/launchpad
  keys, WalletConnect and Helius. Every value is stored as _sensitive_, so
  `vercel env pull` returns blanks and the live mode cannot be confirmed
  from the API. The web app must show its env and net in the footer so the
  build mode is visible from the page itself.
- **Vercel Authentication (SSO) is on** for "all deployments except custom
  domains". The staging URL cannot be opened by anyone outside the Vercel
  team, and the Vercel MCP bypass is refused as well. Attach a custom domain
  (`dev.ston.kz`) to the `stonkz-app` project: that is the least-privilege
  way to hand testers a working link without turning protection off.
- Two Vercel links exist in the checkout: `.vercel/project.json`
  (`stonkz-app`, the one the docs describe) and `apps/web/.vercel/project.json`
  (`web`). Deploy from the repo root only.
- Scheduled E2E runs on GitHub have reported `startup_failure` every night
  since 2026-09-14 with an empty workflow path (`BuildFailed`). Both workflow
  files parse. Re-check once `main` is pushed; if it persists, delete and
  recreate the schedule trigger.
- Local `pnpm test` was red on `main`: migration `0012_net_base.sql` packed
  two statements per breakpoint (PGlite rejects that; postgres-js did not),
  and a set of tests still assumed two nets. Fixed on the Phase 0 branch.
- `pnpm lint` reported ~21K errors because `programs/evm/lib` (vendored
  OpenZeppelin) was linted. `programs/**` is now ignored.
