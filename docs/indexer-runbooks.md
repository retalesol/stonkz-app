# `apps/indexer` operational runbooks

How `apps/indexer` actually behaves after Phase C. Capabilities that exist
only in code and have never been pointed at a live cluster are marked
**never run**, not missing.

**Default today:** `INDEXER_SOURCE` defaults to `chain`. Fixture replay is
opt-in (`INDEXER_SOURCE=fixtures`) and refused in production unless
`INDEXER_ALLOW_FIXTURES=1`. Chain mode refuses to boot unless the program
addresses and start positions are set (`assertChainModeConfigured` in
`src/config.ts`). Staging Railway already runs chain mode against RH 46630

- Solana devnet.

---

## 1. Architecture

- **Process**: one Node process, `apps/indexer/src/worker.ts`
  (`pnpm --filter @stonkz/indexer start`). Poll loop every
  `INDEXER_POLL_MS` (default 2s); diamond-hands sweep every
  `INDEXER_SWEEP_MS` (default 60s).
- **Modes** (`INDEXER_SOURCE`):
  - `chain` (default) — Solana polling source (`getSignaturesForAddress` +
    `getTransaction`, Anchor decode) and RH `getLogs` source (viem,
    launchpad + router ABIs). Cursors are **never** rewound. Confirmation
    buffer, reorg rollback, and dead-lettering are on.
  - `fixtures` — `FixtureEventSource` over `canonicalScenario()` for tests
    / local replay only. Cursors rewind to 0 on every boot. Production
    requires `INDEXER_ALLOW_FIXTURES=1`.
- **State** (Postgres):
  - `indexer_cursors` — one row per net. Position, raw head, confirmed
    head, `position_hash`, `position_signature`, `reorgs`,
    `failed_attempts`, last error.
  - `chain_events` — append-only, unique on `(net, tx_sig, log_index, kind)`.
  - `indexer_dead_letters` — poison events/batches that exceeded
    `INDEXER_MAX_BATCH_ATTEMPTS`.
- **Pass** (`src/runner.ts`): per chain, independently: detect reorg →
  poll `(cursor, min(confirmedHead, cursor + batchSize)]` → ingest →
  advance cursor. A throw on SOL does not skip RH's turn. A Solana pass
  may cover less than it was asked for (signature paging is bounded per
  pass); the cursor then moves only to what was fully walked and the
  rest is the next pass's work — see §5a.
- **Single-replica lock**: session-level `pg_try_advisory_lock` on a
  dedicated single-connection handle (`src/lock.ts`). A second replica
  exits 1. **This lock does not survive Neon's transaction pooler.** Point
  the indexer's `DATABASE_URL` at the direct host
  (`ep-….c-4.us-east-2.aws.neon.tech`), not `ep-…-pooler.…`.
- **Shared Redis** is required for the API's WS hub to see indexer
  publishes. `REDIS_URL=memory://` in either process isolates them.

---

## 2. Starting / restarting

```bash
pnpm --filter @stonkz/api migrate   # the indexer does NOT migrate when
                                     # NODE_ENV=production
INDEXER_SOURCE=fixtures \            # or chain, once programs are deployed
  pnpm --filter @stonkz/indexer start
```

Boot is clean when you see `"indexer started"` with `mode` and
`httpPort`, plus either `"running on FIXTURE events"` or
`"running on CHAIN events"`. Chain mode that is missing
`RH_LAUNCHPAD_ADDRESS` / `INDEXER_SOL_START_SLOT` /
`INDEXER_RH_START_BLOCK` exits immediately with a named error — that is
the intended fail-closed, not a crash.

`GET http://<host>:8788/health` (or whatever `INDEXER_HTTP_PORT` is)
returns 200 only when this replica holds the lock and both chains are
inside `MAX_CHAIN_LAG_SECONDS`. Set `INDEXER_HTTP_PORT=0` to disable the
listener.

`SIGTERM` / `SIGINT` stop the loop between passes, close HTTP, release
the advisory lock, then close DB/Redis. A kill mid-batch is safe:
ingest is idempotent and the cursor has not advanced.

### Never run two replicas

The lock is the guard. If you see
`"refusing to start: another replica is already indexing"`, scale back
to one. Do not share `INDEXER_LOCK_KEY` across environments that share
a database unless you intend them to exclude each other.

---

## 3. Detecting lag

Lag is confirmed-head minus cursor, converted to seconds with
`SOLANA_SLOT_MS` / `RH_BLOCK_MS`. The API's `LagMonitor` and the
indexer's `/health` both read `indexer_cursors`.

| Signal                                      | Meaning                                        |
| ------------------------------------------- | ---------------------------------------------- |
| `/health` 503, `status: "degraded"`         | one or both chains over the lag budget         |
| `alert: "chain-lag:SOL"` / `RH` in API logs | same, edge-triggered                           |
| `failedAttempts` climbing on `/health`      | current batch is retrying toward a dead-letter |
| `deadLetters` > 0                           | something was skipped; see `/dead-letters`     |
| `reorgs` incrementing                       | a hash mismatch triggered rollback             |
| `catchupBacklog` > 0 on `/health` (SOL)     | walking a signature gap; normal after downtime |
| `alert: "solana-catchup-backlog:SOL"`       | that gap has persisted > 10 min (§5a)          |

A fixture-mode deploy pointed at a live RPC will look "lagging" forever
if the stub/RPC head keeps advancing past the fixture heads. That is
not a chain problem.

---

## 4. Idempotency (why replay is the first response)

- `chain_events` unique on `(net, tx_sig, log_index, kind)`.
- Treasury credits insert-then-mutate; a replay that loses the insert
  does not credit twice.
- Holders, candles, vaults, KOTH upsert.
- XP/SP awards unique on `(wallet, tx_sig, reason)`.

Rewinding a cursor and letting the live loop walk forward is always
safe to _attempt_. Prefer the backfill CLI (§6) when you want a closed
range without moving the live cursor.

---

## 5. Poison batches and dead letters

**Integrity failure on one event** (`assertEventIntegrity`): logged,
counted, skipped. The rest of the batch proceeds. The event is also
written to `indexer_dead_letters` so it is not log-only.

**Uncaught exception in `apply()`**: `failed_attempts` increments on
that net's cursor. After `INDEXER_MAX_BATCH_ATTEMPTS` (default 5) the
range is dead-lettered as `scope=batch` and the cursor skips past it.
The other chain keeps draining.

**Response:**

1. `GET /dead-letters` (or `SELECT * FROM indexer_dead_letters WHERE resolved_at IS NULL`).
2. Transient RPC/DB: it should self-heal before the attempt cap.
3. Code bug: patch, then
   `pnpm --filter @stonkz/indexer backfill -- --net SOL --from <from> --to <to> --resolve`.
4. Do not "just" `UPDATE indexer_cursors SET position = …` past a
   poison range without a dead-letter row — you will lose the record
   of the gap.

**What is _not_ a poison batch:** a Solana range that simply holds more
signatures than one pass can walk. That used to surface as
`SolanaRangeTooBusyError`, go through this failure path, and dead-letter
the range after `INDEXER_MAX_BATCH_ATTEMPTS` — silently losing every fill
in it after an outage on a busy program. It no longer can: the source
reports partial progress instead of throwing (§5a), and the runner never
counts a `partialProgress` error towards a dead letter even if one
arrives from an old build (`PassResult.deferred`).

### 5a. Solana catch-up after an outage

`getSignaturesForAddress` only pages _down_ from the tip; ingest only runs
_up_ from the cursor (a fill cannot be mapped before its launch, and the
cursor must never skip a slot). `SolanaChainSource` reconciles the two
with a walk that is bounded per pass and resumes across passes:

1. **Locate** — page down from the tip with `until = <bookmark>`, keeping
   one `before` cursor per page on an in-memory stack (a 1M-signature gap
   is ~1,000 strings, not 1M rows). Stops at the bookmark, or when the
   pass's page cap / time budget runs out — in which case the _next pass
   continues from the same page_. These passes log nothing per pass and
   move the cursor nowhere; that is expected.
2. **Collect** — pop pages from the bookmark side (oldest first), fetch
   up to `INDEXER_SOL_MAX_TX_PER_PASS` transactions, cut at a slot
   boundary, advance the cursor + bookmark. A partly-ingested page is
   re-fetched next pass with the new `until`, so it shrinks to its
   remainder. A slot that straddles a page boundary is never committed
   until the next page has been seen.

Everything durable is still just `indexer_cursors.position` +
`position_signature`. A restart discards the in-memory walk and
re-locates from the tip with `until = bookmark`: one light RPC call per
1,000 signatures, nothing re-ingested below the bookmark. The ordering
guarantees are unchanged — oldest-first across pages and passes,
decode-all-then-map inside a pass for launch-before-fill within a slot,
`chain_events` unique for idempotency, `finalized` commitment throughout.

| Knob                              | Default | Meaning                                                        |
| --------------------------------- | ------- | -------------------------------------------------------------- |
| `INDEXER_SOL_MAX_SIGNATURE_PAGES` | 100     | signature pages per pass (locate + collect); was a fixed 20    |
| `INDEXER_SOL_PASS_BUDGET_MS`      | 15000   | wall-clock budget for one pass's paging; always ≥ 1 page       |
| `INDEXER_SOL_MAX_TX_PER_PASS`     | 200     | transactions fetched per pass                                  |
| `INDEXER_CATCHUP_ALERT_AFTER_MS`  | 600000  | backlog age before `solana-catchup-backlog:SOL` fires (10 min) |

**What you will see during a catch-up:**

- `/health` → `chains[SOL].catchupBacklog` (estimated signatures left; a
  lower bound while still locating) and `catchupForSeconds`.
- `/metrics` → `stonkz_indexer_solana_catchup_backlog{net="SOL"}` and
  `stonkz_indexer_catchup_for_seconds{net="SOL"}`.
- Log `"catch-up in progress; the cursor advances as pages are walked"`
  (warn) **once a minute**, not once a pass, with `remaining`, `located`,
  `passes`, `pages`, `forSeconds`; then `"catch-up complete"` (info).
- `alert: "solana-catchup-backlog:SOL"` (critical, edge-triggered like
  `chain-lag`, with a `RESOLVED:` line) once the backlog has persisted
  past `INDEXER_CATCHUP_ALERT_AFTER_MS`. Lag (`chain-lag:SOL`) will be
  alerting too — that is the same incident, not a second one.
- `failedAttempts` stays 0 and `deadLetters` stays flat. If either moves
  during a catch-up, that is a real failure (RPC, decode, DB), not the
  backlog.

**Sizing.** Throughput is bounded by `INDEXER_SOL_MAX_TX_PER_PASS` per
pass (one `getTransaction` each) plus ~2 signature pages per pass. A
backlog that _grows_ while the walk is located means the program is
producing fills faster than one pass per `INDEXER_POLL_MS` can clear:
raise `INDEXER_SOL_MAX_TX_PER_PASS` (and the RPC plan) before anything
else. Raising `INDEXER_SOL_MAX_SIGNATURE_PAGES` only shortens the locate
phase. Do not "help" by rewinding or editing the cursor: the walk is
already oldest-first and idempotent, and a rewind discards it.

**Backfill CLI** (§6) uses the same walk. A historical window far below
the tip first has to locate down from the tip, so expect
`still locating: … pages this pass` lines before the first ingest line.

---

## 6. Backfill CLI

```bash
pnpm --filter @stonkz/indexer backfill -- \
  --net SOL --from <exclusive> --to <inclusive> \
  [--dry-run] [--rollback-first] [--rewind] [--resolve] [--window N] \
  [--allow-unconfirmed]
```

- Does **not** move the live cursor unless `--rewind`.
- Refuses to read past the confirmation depth unless
  `--allow-unconfirmed`.
- `--rollback-first` deletes the range's materialized rows, then
  re-ingests — use this after a known-bad decode, not as a habit.
- `--resolve` closes matching dead letters when the replay succeeds.

There is no signature-targeted replay. A single missed tx is recovered
by backfilling the slot/block that contained it.

Archive RPC is required for ranges older than the provider's retention
window. The code does not detect that case; the RPC just returns empty.

---

## 7. Reorgs

Chain mode records `position_hash` at the cursor. Each pass asks the
source whether that hash is still the block/slot at that position.

On mismatch:

1. Walk back up to `INDEXER_SOL_REORG_DEPTH` / `INDEXER_RH_REORG_DEPTH`
   until a hash matches.
2. `ReorgRollback` deletes materialized rows (`chain_events`, `trades`,
   `tape`, `treasury_credits`, and derived candles / holders / KOTH /
   tokens launched in the orphaned range) above the fork.
3. Ledger awards whose `tx_sig` no longer has a `chain_events` row are
   reversed. The unique key prevents a later re-ingest from double
   paying; the reverse is what stops a reorged trade from leaving XP.
4. The mint→ticker registry cache for that net is dropped.
5. `reorgs` increments; ingest resumes from the fork.

Solana confirmations default to 0 because the source already reads at
`finalized`. RH defaults to 12. Do not set RH to 0 on a sequencer that
can reorg.

This path has unit coverage against synthetic forks. It has **never**
been observed against a live chain.

---

## 8. Missed deliveries

There is no webhook receiver. Polling _is_ the source, so a missed
webhook is not a failure mode. A stalled poller looks like lag (§3).
A provider that silently stops returning signatures looks like
`behindRaw` growing with `failedAttempts` staying at 0 — check the
RPC, not the dead-letter table.

---

## 9. HTTP surface and logs

Indexer listens on `INDEXER_HTTP_HOST`:`INDEXER_HTTP_PORT` (default
`0.0.0.0:8788`):

| Route               | Use                             |
| ------------------- | ------------------------------- |
| `GET /health`       | 200 / 503 JSON; readiness probe |
| `GET /metrics`      | Prometheus text                 |
| `GET /dead-letters` | open dead letters as JSON       |

| Log                                       | Level       | Meaning                               |
| ----------------------------------------- | ----------- | ------------------------------------- |
| `"indexer started"`                       | info        | boot, includes `mode`                 |
| `"running on CHAIN events"` / `"FIXTURE"` | info / warn | which source                          |
| `"acquired the single-writer lock"`       | info        | this replica is the writer            |
| `"batch complete"`                        | info        | `net, from, to, accepted, duplicates` |
| `"event rejected"`                        | error       | integrity skip + dead-lettered        |
| `"indexer pass failed"`                   | error       | exception outside a chain drain       |
| `alert: "chain-lag:*"`                    | error       | over budget (emitted by the API)      |
| `"catch-up in progress; …"`               | warn        | SOL signature walk; once a minute     |
| `"catch-up complete"`                     | info        | the walk reached the tip              |
| `alert: "solana-catchup-backlog:SOL"`     | error       | backlog persisted > 10 min (§5a)      |

Dashboard: `/health` `chains.*.behind`, `lagSeconds`, `reorgs`,
`deadLetters`, `failedAttempts`, `catchupBacklog`, plus overall `mode`
so a fixtures deploy cannot be mistaken for chain.

---

## 10. Env that chain mode actually requires

| Var                               | Why                                                 |
| --------------------------------- | --------------------------------------------------- |
| `INDEXER_SOURCE=chain`            | otherwise you are in fixtures                       |
| `SOLANA_RPC_URL`                  | polling                                             |
| `SOLANA_LAUNCHPAD_PROGRAM_ID`     | address filter                                      |
| `INDEXER_SOL_START_SLOT`          | fresh cursor must not walk from genesis             |
| `INDEXER_SOL_MAX_SIGNATURE_PAGES` | optional, default 100; catch-up page cap (§5a)      |
| `INDEXER_SOL_PASS_BUDGET_MS`      | optional, default 15000; catch-up time budget (§5a) |
| `INDEXER_CATCHUP_ALERT_AFTER_MS`  | optional, default 600000; backlog alert age (§5a)   |
| `RH_RPC_URL`                      | `getLogs`                                           |
| `RH_LAUNCHPAD_ADDRESS`            | must not be the zero address                        |
| `INDEXER_RH_START_BLOCK`          | same genesis guard                                  |
| `RH_ROUTER_ADDRESS`               | optional; decoded if set                            |
| `DATABASE_URL`                    | **direct Neon host, not the pooler**                |
| `REDIS_URL`                       | same Redis as the API                               |

Fixtures mode needs none of the program addresses.
