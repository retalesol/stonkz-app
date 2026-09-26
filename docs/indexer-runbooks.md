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
  advance cursor. A throw on SOL does not skip RH's turn.
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

Dashboard: `/health` `chains.*.behind`, `lagSeconds`, `reorgs`,
`deadLetters`, `failedAttempts`, plus overall `mode` so a fixtures
deploy cannot be mistaken for chain.

---

## 10. Env that chain mode actually requires

| Var                           | Why                                     |
| ----------------------------- | --------------------------------------- |
| `INDEXER_SOURCE=chain`        | otherwise you are in fixtures           |
| `SOLANA_RPC_URL`              | polling                                 |
| `SOLANA_LAUNCHPAD_PROGRAM_ID` | address filter                          |
| `INDEXER_SOL_START_SLOT`      | fresh cursor must not walk from genesis |
| `RH_RPC_URL`                  | `getLogs`                               |
| `RH_LAUNCHPAD_ADDRESS`        | must not be the zero address            |
| `INDEXER_RH_START_BLOCK`      | same genesis guard                      |
| `RH_ROUTER_ADDRESS`           | optional; decoded if set                |
| `DATABASE_URL`                | **direct Neon host, not the pooler**    |
| `REDIS_URL`                   | same Redis as the API                   |

Fixtures mode needs none of the program addresses.
