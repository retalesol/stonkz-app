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

## Health checks

Both images carry a Docker `HEALTHCHECK` (`deploy/Dockerfile.*`). Railway
ignores it; configure the service's own health check, which gates every
deploy (the new container only takes traffic once the path answers 200):

| Service          | Settings → Deploy → Health check path | Timeout (`RAILWAY_HEALTHCHECK_TIMEOUT_SEC`) | Why this path                                                                                                              |
| ---------------- | ------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `stonkz-backend` | `/health/live`                        | 120                                         | Liveness only; never touches DB/Redis/RPC, so a dependency blip cannot fail a deploy. `/health` stays the deep probe.      |
| `stonkz-indexer` | `/health`                             | 600                                         | 200 inside the lag budget, **503 while catching up** — after downtime a deploy waits for catch-up, hence the long timeout. |

If the indexer is far behind and a deploy must go out, clear the health-check
path for that deploy and put it back afterwards. The Docker probe treats
200 **and** 503 as alive for the indexer for the same reason: lag is an
alert, not a restart trigger.

**Restart policy:** `On failure`, max 10 retries, on both services. The
indexer takes a non-blocking advisory lock at start (`lock.ts`); a duplicate
instance reports that it is standing by and never writes, so a restart loop
cannot double-apply events.

## Compute

- **API: 2 replicas** (Settings → Deploy → Replicas). The WebSocket hub is
  Redis-backed (`ws/hub.ts`), sessions and rate limits live in Redis, and
  the API never migrates in production, so instances are interchangeable.
  Keep the Redis plugin on the same Railway project/region.
- **Indexer: exactly 1 replica.** `lock.ts` holds a session-level advisory
  lock on Neon's **direct** host; a second replica cannot start, and must
  not be forced (`docs/indexer-runbooks.md` §2).
- Region: keep both services and Redis in one region; Neon in the nearest.

## Neon backups and restore

- Enable **point-in-time restore** on the project (Settings → Storage → history
  retention; set it to 7 days, the maximum the plan allows if lower) and
  record the figure in `docs/incident-runbook.md` §5.
- Before every release that carries a migration, create a branch
  `pre-<version>` from `main`. Delete it a week after the release.
- Restore = branch from a timestamp, verify, then promote or repoint
  `DATABASE_URL`. Steps in `docs/incident-runbook.md` §5. Rehearse it once
  a month: create a PITR branch, query it, delete it.

## Migrations as a release step

The API refuses to migrate on boot in `NODE_ENV=production`. Order per
release:

1. `pnpm --filter @stonkz/api migrate` against the **direct** Neon URL, from a
   laptop or a one-off Railway job (`railway run --service stonkz-backend
pnpm migrate`), after the `pre-<version>` branch exists.
2. Deploy the indexer, then the API (the API's `/health` reports the applied
   migration count under `api.migrations`).
3. Deploy the web (`vercel --prod` from the repo root).

Migrations are forward-only; a bad release rolls the code back, not the
schema (`docs/incident-runbook.md` §7).

## Web security headers

Root `vercel.json` sends HSTS (2 years, preload), `X-Content-Type-Options`,
`X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`,
`Permissions-Policy` (camera, microphone, geolocation off) on every path, and
a `Content-Security-Policy` header: the terminal's (`/((?!admin).*)`) mirrors
the `<meta>` in `apps/web/index.html` plus `frame-ancestors 'none'`, which a
`<meta>` cannot carry; `/admin(.*)` mirrors the stricter `admin.html` meta
(no inline styles) minus its localhost dev allowances. A header CSP and a
meta CSP both apply, so a directive must be loosened in **both** files.
`apps/web/vercel.json` is an unused mirror; keep it identical. `vercel build`
locally shows the compiled routes in `.vercel/output/config.json`.

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
