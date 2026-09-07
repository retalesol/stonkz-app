# `apps/indexer` operational runbooks

This describes how `apps/indexer` actually behaves today, based on reading
`apps/indexer/src/**` and the parts of `apps/api` it shares (`env.ts`,
`db/schema.ts`, `routes/health.ts`, `observability/metrics.ts`). Where a
capability a production runbook would normally assume (real chain ingestion,
reorg handling, a backfill CLI) **does not exist in the code**, this doc says
so explicitly instead of describing aspirational behavior.

**Read this first — the single most important fact about the current state:**
`apps/indexer` only has one working event source, `FixtureEventSource`
(`src/source.ts:27-48`), which replays a small static, in-memory scenario
(`src/fixtures/producer.ts`). Setting `INDEXER_SOURCE` to anything other than
`fixtures`/unset throws at boot (`src/worker.ts:43-47`) — **there is no real
Solana Geyser/Helius ingestion and no real EVM log subscription implemented
yet.** Everything below that describes "the chain" is written for when that
lands (Phase 2 programs + real event source, per the code comment in
`source.ts:1-10`), and is clearly marked where today's fixture-mode behavior
differs.

---

## 1. Architecture summary (for the procedures below to make sense)

- **Process**: single Node.js process, `apps/indexer/src/worker.ts`
  (`pnpm --filter @stonkz/indexer start` / `dev`). No worker threads, no
  clustering. A `while (!stopping)` loop polls every `POLL_MS = 2_000` ms
  (`worker.ts:66`); a separate `setInterval` runs an unrelated "diamond
  hands" achievement sweep every `SWEEP_MS = 60_000` ms (`worker.ts:70-73`).
  Neither interval is configurable via env — they're hardcoded constants.
- **State**: two Postgres tables carry all indexer state across restarts:
  - `indexer_cursors` — one row per net (`SOL`, `RH`; seeded by migration
    `0001_read_tables.sql:218`), columns `position` (last committed
    slot/block), `chain_head` (last observed head), `last_event_at`,
    `updated_at`.
  - `chain_events` — the append-only, deduplicated record of every accepted
    event, unique on `(net, tx_sig, log_index, kind)`.
- **Per-poll pass** (`src/runner.ts:44-67`): read chain head → read cursor →
  `poll(cursor, min(head, cursor + 5000))` → `ingest.apply(events)` → **only
  then** advance the cursor to the batch's end position, tagging whether any
  event was accepted → check lag. The cursor is designed to advance only
  after a batch is fully applied, so a crash mid-batch safely replays that
  batch on restart (ingestion is idempotent — see §4).
- **Single-replica assumption, not code-enforced**: `apps/api/README.md:117`
  states "one replica" for the indexer — two replicas wouldn't corrupt data
  (the unique constraints reject duplicate work) but would double the RPC
  load and produce confusing duplicate-count log noise. **There is no
  distributed lock or leader election in the code** — this is a deployment
  configuration you must enforce (e.g. a Railway/K8s service with
  `replicas: 1`), not something the indexer protects itself against.
- **Shared Redis is required for cross-process pub/sub**: the indexer
  publishes board/token/trade updates over the same `Publisher`/Redis
  pub-sub the API's WebSocket gateway subscribes to. If either process runs
  with `REDIS_URL=memory://` (the in-process fake), its events never reach a
  separately-deployed instance of the other process. Production must point
  both at the same real Redis.

---

## 2. Starting / restarting the indexer safely

### Normal start

```bash
pnpm --filter @stonkz/api migrate   # explicit release step — the indexer
                                     # does NOT auto-run migrations when
                                     # NODE_ENV=production (worker.ts:25)
pnpm --filter @stonkz/indexer start
```

Confirm it booted cleanly by checking for the `"indexer started"` info log
(`worker.ts:85`) and the absence of an immediate `"chain event decoders are
not implemented yet"` error, which means `INDEXER_SOURCE` was set to
something other than `fixtures`/unset (`worker.ts:43-47`) and the process
crashed at start.

### Restarting

Send `SIGTERM` (or `SIGINT`). The handler (`worker.ts:74-82`) stops the poll
loop, clears the sweep interval, logs, and closes DB/Redis before exiting —
this is a graceful shutdown, but note it only checks the `stopping` flag
**between** poll iterations, not mid-batch: a restart mid-batch is a hard
kill of that in-flight batch's `apply()` call, not a clean cutoff. That's
fine — see §1's crash-safety note; the batch will be re-processed from the
same cursor position next boot, and re-ingestion is idempotent.

**⚠️ Fixture-mode-only gotcha, remove before enabling `INDEXER_SOURCE=chain`:**
`worker.ts:64-65` unconditionally rewinds both cursors to `0` on *every*
boot:

```ts
for (const net of ['SOL', 'RH'] as const) await cursors.rewind(net, 0);
```

with the comment "Rewind so a restart replays the fixtures rather than
sitting idle; this is safe precisely because ingest is idempotent." This is
correct and intentional for fixture mode (a fixed-size scenario, replayed
from empty), but **if left in place once a real chain source exists, every
restart would re-walk the entire chain history from `startPosition()`
instead of resuming from the last real cursor** — a full backfill on every
deploy. This line must be removed or gated behind `INDEXER_SOURCE ===
'fixtures'` as part of the Phase 2 cutover, or a routine restart will look
like (and cost like) a disaster-recovery backfill every time.

### Never run two replicas concurrently

Per §1, there is no code-level guard against it. If you must run a second
instance temporarily (e.g. blue/green during a deploy), expect duplicate-work
log noise (rejected duplicate inserts, `"event rejected"` false positives if
you misread them) — verify only one is left running once the deploy settles.

---

## 3. Detecting a stalled or lagging cursor

There is exactly one lag concept in the code — there is **no separate
"stalled" state**; "lagging" and "alerting" are the same thing
(`observeChainLag`, `apps/api/src/observability/metrics.ts:126-146`):

```
behind  = max(0, chain_head - cursor.position)          // slots (SOL) or blocks (RH)
seconds = behind * tickMs / 1000                          // SOLANA_SLOT_MS=400, RH_BLOCK_MS=2000
alerting = seconds > MAX_CHAIN_LAG_SECONDS (default 30s)
```

### Where to look

1. **`GET /health`** (served by `apps/api`, not the indexer — the indexer has
   no HTTP endpoint of its own) — reads `indexer_cursors.position` directly
   from Postgres and independently probes each chain's live head, then
   reports `chains.SOL` / `chains.RH` with `status: 'degraded'` when
   `alerting` is true, plus `behind`, `lagSeconds`, `head`, `cursor`. Overall
   `status` is `'down'` (HTTP 503) if DB/Redis/either RPC probe itself fails,
   `'degraded'` (HTTP 200) if either chain is lagging past threshold, else
   `'ok'`.
2. **Indexer logs** — every pass logs lag at `debug`
   (`src/lag.ts:33-39`, fields `net, head, cursor, behind, seconds`), and the
   *first* time a chain crosses the threshold it logs a `critical`
   (→ `logger.error`) alert line with `alert: "chain-lag:SOL"` or
   `"chain-lag:RH"` (edge-triggered — see below); when it recovers, a
   one-time `warn`-level "RESOLVED: ..." line with the same `alert` key.
3. Because `/health` computes lag independently in the API process (its own
   `Metrics` instance, `routes/health.ts:59-100`) and the indexer computes it
   in its own process (`LagMonitor.check`, `src/lag.ts:27-45`), **the same
   `chain-lag:*` alert can legitimately fire/resolve from either `svc: 'api'`
   or `svc: 'indexer'` logs** — don't assume only the indexer emits it.

### Edge-triggered alerting — what this means operationally

`Metrics.edge()` (`metrics.ts:148-164`) only emits a log line on a
`false → true` transition (start alerting) and once more on `true → false`
(resolved). It does **not** re-log every 2-second poll while still lagging.
If you're building a log-based alert (e.g. a CloudWatch/Datadog log-metric
filter), alert on the appearance of `alert: "chain-lag:SOL"` /
`"chain-lag:RH"` at `error` level, and treat its *absence* for
`N × POLL_MS` as "still lagging, no new alert expected" rather than
"resolved" — silence is not resolution, only the explicit `warn`-level
"RESOLVED" line is.

### Recovery: rewinding a lagging cursor

There is no dedicated CLI — the documented procedure
(`apps/api/README.md:132-139`) is a direct SQL update:

```sql
UPDATE indexer_cursors SET position = <chain_position> WHERE net = 'SOL';
```

Every downstream write in the ingest path is either uniquely-constrained
(`onConflictDoNothing`) or an idempotent upsert
(`onConflictDoUpdate`) keyed so that re-deriving from an earlier position
never double-applies — including ledger/XP awards, which are keyed on
`(wallet, tx_sig, reason)`. **Rewinding forward-replays; it does not
"un-award" anything already paid.** The normal poll loop picks up from the
new position within one `POLL_MS` tick.

### Recommended alert thresholds

| Signal | Threshold | Rationale |
|---|---|---|
| `chain-lag:SOL` / `chain-lag:RH` at `critical` | fire on first occurrence (already edge-triggered in code) | `MAX_CHAIN_LAG_SECONDS=30s` is the code default; page immediately, don't batch — 30s of lag on a fast-moving memecoin board is already stale prices/board state |
| Sustained lag | page if lag has not resolved within 5 minutes of the first alert | gives the auto-catch-up loop (poll every 2s, batches up to 5,000 slots/blocks) time to work before escalating to a human |
| `rpc-errors:SOL` / `rpc-errors:RH` (`metrics.ts:120-125`) | already fires at >25% error rate over ≥20 calls | a distinct alert from chain-lag — an RPC provider degrading generally shows up here first, often minutes before lag crosses 30s |
| "indexer pass failed" log lines | page after 3 consecutive occurrences (~6s) | see §5 — this indicates an uncaught exception is wedging a chain's cursor with no backoff; it will repeat every `POLL_MS` forever until fixed |
| No new `chain_events` row inserted, per net | investigate if none for >2× expected block/slot time under real launch-day volume | `last_event_at` is stored on `indexer_cursors` but nothing in the code currently alerts on its staleness — this would need to be wired up as a separate check (e.g. a periodic query) since it doesn't exist today |

---

## 4. Idempotency (why replay/rewind/restart is always safe to try first)

Before reaching for anything destructive, know that **every ingest write
path is idempotent by construction**:

- `chain_events` has a unique index on `(net, tx_sig, log_index, kind)`
  (`0001_read_tables.sql:204`); inserts use `.onConflictDoNothing()`
  (`src/ingest.ts:127-157`). A duplicate event is silently counted as a
  duplicate and its downstream side effects are **not** re-applied.
- `trades` and `tape` are similarly unique on `(net, tx_sig, log_index)`.
- `treasury_credits` is unique on `(net, kind, tx_sig, log_index)`, and the
  vault balance is only mutated if the credit row insert actually returned a
  new row — a replay cannot double-credit a treasury.
- `holders_snapshot`, `stake_positions`, `tokens`, `koth`, `creator_vaults`,
  `candles` all use `.onConflictDoUpdate()` (composite-key upserts) — a
  replay reconverges to the same state instead of accumulating duplicates.
- Ledger/XP awards are keyed on `(wallet, tx_sig, reason)`.

**Practical implication**: rewinding a cursor backward and letting it
re-process a range you've already ingested is always safe to attempt as a
first response to a suspected gap or a lag alert. It is not safe to run two
indexer replicas *concurrently* against the same DB long-term (see §1)
because the read-then-write cursor `advance()` (`src/cursors.ts:52-64`) is
not wrapped in a transaction — a race there is not corrupting, but it can
produce confusing duplicate/skip artifacts in the logs.

---

## 5. Handling an uncaught error during ingestion (a "poison" batch)

Two error paths exist, and they behave very differently — this distinction
matters for on-call:

**A. A single bad event (integrity check failure)** — e.g. a missing
`txSig`, a negative amount, a bad fee split
(`assertEventIntegrity`, `src/events.ts:240-250`). This is caught per-event
inside `Ingestor.apply()`'s loop (`src/ingest.ts:98-110`): the event is
logged at `error` (`"event rejected"`, fields `kind, net, txSig, reason`),
counted in `report.rejected`, and **skipped** — the rest of the batch
continues processing normally, and the cursor still advances past it.
**There is no dead-letter table or queue** — a rejected event's only trace
is that log line and an in-memory counter surfaced in the next
`"batch had rejected events"` summary log (`src/runner.ts:71-77`, count
only, not which events or why). If you need to recover a rejected event,
you currently have to grep logs for `"event rejected"` around the affected
time range — there's no persisted list to query.

**B. Any other uncaught exception during `apply()`/dispatch** (e.g. a DB
error that isn't a unique violation, a bug in a handler) — this propagates
all the way up to `worker.ts`'s outer loop
(`worker.ts:86-93`), which logs `"indexer pass failed"` at `error` and
retries after `POLL_MS` (2s) — **forever, with no backoff, no batch-skip,
and no circuit breaker.** Because the cursor only advances after `apply()`
returns normally, a batch that always throws for the same reason (a "poison
batch") will wedge that net's cursor indefinitely while spamming
`"indexer pass failed"` every 2 seconds.

**Cross-chain coupling to be aware of**: `IndexerRunner.drain()`
(`src/runner.ts:92-100`) processes `SOL` then `RH` in a plain `for` loop with
no internal try/catch. If `SOL`'s `pass()` throws, the exception propagates
out of `drain()` before `RH` is ever attempted in that iteration — **a
poison batch on one chain can stall ingestion of the other chain too**,
until the exception source is fixed. (This is despite `LagMonitor`/cursor
*storage* being genuinely per-chain-independent — the coupling is
specifically in `drain()`'s control flow, not the data model.)

**Response procedure**:
1. On repeated `"indexer pass failed"` logs, capture the full error message
   (it's included in the log field `err`) and identify which net's `pass()`
   is throwing (cross-reference with the last successful
   `"batch complete"`-style info log per net, `src/runner.ts:78-85`, to see
   which net stopped advancing).
2. If it's a transient dependency issue (DB/Redis blip, RPC timeout), it
   should self-heal on the next 2s retry — watch for cursor `position` to
   start advancing again.
3. If it's a code bug (bad batch will always throw), you cannot skip past it
   with a config toggle — either patch the bug and redeploy, or rewind the
   cursor **past** the poison position as a temporary mitigation (accepting
   the gap — see §6 for the tradeoff) and file the range for a later
   backfill once fixed.
4. Because a `SOL` failure blocks `RH` from draining in the same pass, check
   `RH`'s lag too, not just the chain whose error you found first.

---

## 6. Backfilling a data gap

**There is no dedicated backfill CLI or `--from-slot`/`--from-block` flag.**
The only mechanism is the same manual cursor rewind used for lag recovery
(§3):

```sql
UPDATE indexer_cursors SET position = <earlier_position> WHERE net = 'SOL';
```

then let the normal poll loop (`POLL_MS = 2_000`, batch size 5,000
slots/blocks per pass, `IndexerRunner`'s default `batchSize`,
`src/runner.ts:38-40`) walk forward from there. For a large gap (e.g. hours
of missed Solana slots at ~2.5 slots/sec), expect multiple polling passes to
catch up — `(gap_in_slots / 5000)` passes minimum, each ~2s apart, so a
100,000-slot gap is on the order of 20 passes / ~40s of wall-clock replay
time (plus actual event-processing time per batch, which was not separately
load-tested here).

Two things to know before doing this:
- **It is a forward-only re-derivation.** It does not undo anything already
  ingested at a later position; it only fills in earlier, previously-skipped
  positions, relying on idempotency (§4) to make this safe even if the range
  overlaps already-processed data.
- **It cannot recover from data no longer available at the source.** The
  current fixture source is a static array, so this concern doesn't yet
  apply, but for a real Solana RPC, replaying from far enough in the past
  may fail if the RPC's history retention window has already expired for
  that slot range — you would need an archive/full-history RPC endpoint for
  a very old backfill, which is a provisioning decision to make when the
  real event source is built, not something the current code handles.

If you determine specific transactions were missed (e.g. discovered via a
user report or a block-explorer diff) rather than a contiguous slot/block
range, there is currently no way to target just those transactions — the
`poll(from, to)` interface only accepts a position range
(`src/source.ts:12-24`), not a transaction-signature list. Recommendation:
if this becomes a recurring need, add a signature-targeted replay path to
`EventSource`/`Ingestor` rather than working around it with wide,
un-targeted rewinds.

---

## 7. Handling a chain reorg

**There is no reorg-detection or rollback logic anywhere in the codebase.**
Confirmed by inspection: `ReplayCursors.advance()` only ever moves the
cursor forward (`Math.max`, `src/cursors.ts:57`); the event shape
(`EventBase`, `src/events.ts:17-25`) carries only a position number
(`chainPosition`) and a transaction signature — no parent-hash/block-hash
field exists anywhere to even detect that a fork occurred, let alone which
side of it is canonical.

**Concrete implication**: if a transaction is ingested (a token launch, a
trade, an XP award, a treasury credit) and the block it was in is later
reorged out on the real chain, **the ingested rows remain permanently in
`chain_events`/`trades`/`tokens`/`holders_snapshot`/the XP ledger, and any
XP or treasury credit already applied stays applied.** The manual cursor
rewind (§3, §6) is a forward re-derivation tool, not a rollback tool — it
cannot un-ingest something already recorded at an earlier, now-orphaned
position, because nothing in the schema or ingest logic distinguishes
"orphaned" from "canonical."

**Recommendation (not implemented — flagging for before real-chain
ingestion ships):**
- Robinhood Chain (an EVM chain) and Solana both need finality-lag protection
  before this matters in practice: only ingest events after they've cleared
  a confirmation depth deep enough that reorgs at that depth are
  vanishingly rare (e.g. don't `poll()` all the way to the raw RPC head;
  poll up to `head - N` confirmations). Nothing in `source.ts`'s interface
  currently reserves any confirmation buffer — `head()` returns the raw tip.
- If reorg protection via confirmation lag is judged insufficient (e.g. deep
  reorgs are a real risk on one of these chains), the event model would need
  a block-hash/parent-hash field and an explicit reconciliation pass that
  can detect "the block at this position no longer has the hash we recorded"
  and mark/reverse the affected rows — this is a schema and ingest-logic
  change, out of scope for this operational pass, but should be designed
  before `INDEXER_SOURCE=chain` goes live against mainnet.
- Until either exists, the practical mitigation is entirely deployment-side:
  point the real event source at an RPC/webhook provider (e.g. Helius) that
  already applies a confirmation-depth or "finalized" commitment level
  before delivering events, rather than "processed"/unconfirmed data.

---

## 8. Handling a missed or dropped webhook

Not directly applicable to the current code — there is no webhook receiver
implemented (`INDEXER_SOURCE=fixtures` is the only working mode; a
Helius-webhook-based source does not exist yet, confirmed by an
exhaustive search of `apps/indexer` and `apps/api` for any webhook route or
Geyser client). Once a webhook-based source is built, the general recovery
path is the same as §6 (backfill by cursor rewind): a webhook-based source
by design has no independent "poll for what I missed" capability unless it
is paired with a periodic reconciliation poll against the RPC's own head —
recommend building any future webhook source with exactly that pairing (a
webhook path for low latency, plus a periodic `poll(cursor, head)` sweep as
a correctness backstop) rather than trusting webhook delivery alone, since
missed-webhook detection has no other signal to rely on besides comparing
the cursor to the actual chain head, which is already what `LagMonitor`
does.

---

## 9. Metrics and logs to monitor (reference)

No Prometheus/metrics HTTP endpoint exists — `Metrics`
(`apps/api/src/observability/metrics.ts:47-50`) is explicitly in-process
only ("a scrape endpoint can be layered on this snapshot later"). The
indexer process itself has **no HTTP listener at all**. Monitor via
structured logs (`svc: 'indexer'`) and `GET /health` (served by the API
process, reading the shared `indexer_cursors` table):

| Log line | Level | Fields | Meaning |
|---|---|---|---|
| `"indexer started"` | info | `pollMs` | boot |
| `"batch complete"`-equivalent per-pass summary | info | `net, from, to, accepted, duplicates, xpAwarded` | normal progress — watch `to` advancing over time |
| `"batch had rejected events"` | error | `net, from, to, rejected` | one or more events failed integrity checks this pass (see §5A) |
| `"event rejected"` | error | `kind, net, txSig, reason` | the specific rejected event and why |
| `"chain lag"` | debug | `net, head, cursor, behind, seconds` | every pass, per chain |
| `alert: "chain-lag:SOL"/"chain-lag:RH"` | error (critical) / warn (resolved) | `net, behind, seconds, threshold` | edge-triggered lag alert/resolution — see §3 |
| `alert: "rpc-errors:SOL"/"rpc-errors:RH"` | warn | `net, calls, errors, errorRate` | RPC provider degrading (>25% errors over ≥20 calls) |
| `"lag probe failed"` | error | `net, err` | the RPC head check itself failed this pass |
| `"indexer pass failed"` | error | `err` | uncaught exception in `drain()` — see §5B, treat as high-priority |
| `"diamond sweep skipped"` | warn | `net, err` | the unrelated 60s achievement sweep failed for one net; does not affect core ingestion |

`GET /health` fields worth dashboarding: `chains.SOL.behind`,
`chains.SOL.lagSeconds`, `chains.SOL.status`, and the `RH` equivalents, plus
overall `status` (`ok`/`degraded`/`down`) and HTTP status code (200 vs 503).
