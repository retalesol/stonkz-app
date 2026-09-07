# Load test results — `apps/api` hot paths

**Date of run**: 2026-09-06. **Scripts**: `apps/api/loadtest/k6/*.js` (see
[`apps/api/loadtest/README.md`](../apps/api/loadtest/README.md) for how to
re-run). **Environment**: local machine, not staging/production hardware —
see "Caveats" below for what that does and doesn't invalidate.

## Methodology

1. **Stack**: Dockerized Postgres + Redis (local, default resource limits —
   not a sized/tuned production instance), `apps/api` built from this
   branch, `apps/api/loadtest/stubs/chain-stub.ts` standing in for Solana
   RPC / Robinhood (EVM) RPC / the price oracle at a fixed, realistic 60ms
   latency per call (a typical paid-provider RTT, not 0ms).
2. **Data volume**: `apps/api/loadtest/seed.ts` wrote **400 tokens per net**
   (800 total across SOL + RH) directly to Postgres, each with real
   `@stonkz/curve-sim`-derived curve state, 8–60 historical trades walking
   its market cap from ~10% to its final value, matching `candles` across
   all 6 timeframes, and `holders_snapshot` rows — i.e. a board at the scale
   a genuinely busy launchpad reaches, not the indexer's tiny fixture
   scenario (which is sized for schema-correctness testing, not load
   testing; see the indexer runbook for that distinction).
3. **Identity**: unauthenticated read/quote traffic used a distinct
   synthetic `X-Forwarded-For` value per virtual user
   (`loadtest/k6/lib/config.js::syntheticIp`), so `apps/api`'s per-IP rate
   limiter (`RATE_LIMITS` in `src/redis/ratelimit.ts`) is exercised the way
   it would be against many real board visitors, not tripped by every VU
   sharing k6's one loopback address. Write-path traffic
   (`POST /trade/prepare`, `POST /launch/prepare`) used real, distinct JWTs
   minted for 150 synthetic wallets per net (`loadtest/mint-tokens.ts`), so
   the per-wallet limiter is exercised per-identity too.
4. **Runs recorded below are `net=SOL`.** RH-net paths share the same route
   handlers, DB indexes, and query shapes (only the RPC client and address
   format differ), so a second full run was not repeated for RH; nothing
   in the routes under test branches meaningfully on net for performance.

## Traffic assumptions (no explicit SLA was given — these are mine)

For a "launch-day" memecoin site with no historical traffic data to
calibrate against, I assumed:
- **Board pollers + WS subscribers**: 100–150 concurrent users actively
  viewing the board/token pages at once during a launch spike — reasonable
  for a new, not-yet-massive launchpad's peak, generous for its steady
  state.
- **Quote bursts**: a "pump" on a handful of hot tokens driving quote
  request rates from a steady ~15 req/s up to ~120 req/s over ~20s — modeling
  a sudden pile-on as a token starts trending, not a sustained top-tier-CEX
  load.
- **Trade/launch prepare**: ~20 trade-prepares/sec sustained (a genuinely
  busy write rate for prepare-then-sign flows) and a launch rate deliberately
  kept under the per-wallet/per-IP launch limiters (5/wallet/hr, 30/IP/hr) —
  launch volume is inherently self-limiting by design, so "launch storm"
  capacity was not the thing being stress-tested (see the `trade-launch-prepare.js`
  header comment for the exact reasoning).

If actual traffic targets differ materially from these (e.g. a
Solana-native "1000s of concurrent connections" launch event), re-run with
higher `BOARD_VUS`/`WS_VUS`/`PUMP_RATE` — the scripts are parameterized for
exactly this.

## Results

### 1. Board/token reads + WS subscribers (`board-read.js`)

`BOARD_VUS=100`, `WS_VUS=100`, ramped over 30s, held ~2m, ramped down.
Iteration = `GET /tokens` → `GET /tokens/:sym` → `GET /tokens/:sym/candles`
→ `GET /tokens/:sym/trades`, ~1–3s think time. WS VUs connect, subscribe to
`board` + one `token:{sym}` channel, hold 30s.

| Metric | Result |
|---|---|
| Total HTTP requests | 22,852 (161 req/s sustained) |
| `http_req_duration` avg / p90 / p95 / p99 | 5.1ms / 8.5ms / **10.5ms** / **16.3ms** |
| `http_req_failed` | **0.00%** (0 of 22,852) |
| Checks passed | 100% (23,252 of 23,252) |
| WS sessions | 400 connect/hold/close cycles, 0 failed connects |
| WS connect time p95 | 2ms |
| WS messages received | 1,200 total (3 per session — see note) |

**Note on WS message count**: 1,200 messages ÷ 400 sessions = exactly 3 per
session — a `hello` frame plus two `subscribed` acks (one for `board`, one
for the token channel). No board/token broadcast payloads were observed
during this run because `apps/indexer` was not running against fresh chain
activity for the duration of this particular run (fixtures had already
drained) — this validates connect/subscribe/idle-hold at scale, not
broadcast fan-out throughput. Re-run with the indexer emitting continuous
fixture events (or point `apps/indexer` at ongoing synthetic writes) to
measure broadcast fan-out latency/throughput specifically; this was not
separately measured here.

**Assessment: PASS, with wide headroom.** p95/p99 latency for every read
endpoint is an order of magnitude under a reasonable 400ms/800ms target for
these queries, at 0% errors. The existing Drizzle migrations already carry
purpose-built covering indexes for every query pattern hit here (e.g.
`tokens_lane_mc_idx`, `trades_token_recent_idx`, `candles_range_idx` — see
"Bottlenecks" below) — this is very likely *why* latency is this low even
at 800 tokens seeded, not an artifact of small data volume relative to a
production board.

### 2. Quote burst / simulated pump (`quote-burst.js`)

`STEADY_RATE=15`, `PUMP_RATE=120`, ramping-arrival-rate executor targeting
8 "hot" tokens, ~40% of requests reusing the same (sym, side, amount) key to
land in the 8s quote cache, ~60% varying amount/side to force a fresh
curve-math computation.

| Metric | Result |
|---|---|
| Total HTTP requests | 6,562 (62 req/s avg across both scenarios) |
| `http_req_duration` avg / p90 / p95 / p99 | 8.7ms / 11.0ms / **13.4ms** / **71.4ms** |
| Cache-hit-likely subset p95 | 13.5ms |
| `http_req_failed` | **7.45%** (489 of 6,562) — see analysis below |

**Root-cause of the 7.45% failure rate: this is the quote endpoint's
per-identity rate limiter (120 req/min, `RATE_LIMITS.quote` in
`src/redis/ratelimit.ts`) working as designed, not an API bottleneck.**
Verified directly: firing 130 rapid same-identity requests at
`GET /tokens/:sym/quote` in isolation returns **HTTP 429 for all 130** once
the limit is exceeded, with normal <10ms latency on every one of them (the
API is answering instantly — it's just correctly refusing). The k6
`ramping-arrival-rate` executor recycles a shared, capped VU pool (up to 400
max VUs) to hit 120 iterations/sec; because each VU carries one fixed
synthetic identity for its lifetime, a VU that happens to get several
iterations assigned in quick succession by k6's scheduler can exceed 120
requests/minute *for that one synthetic identity* well before the run's
*aggregate* rate does — this is a load-test-harness identity-distribution
artifact, not evidence that a real launch-day crowd (where 120 req/s means
~120 distinct real IPs, not a few dozen reused ones) would see this error
rate.

**Assessment: PASS on latency (excellent — p95 13ms even during the pump
ramp); the "failures" are the rate limiter functioning correctly, not a
capacity problem.** No fix applied. Recommendation if this rate limiter
value ever needs revisiting for real pump-day traffic: 120/min/identity is
~2/sec sustained per user, which comfortably covers a human refreshing a
quote by hand but would throttle a single automated/bot identity hammering
one hot token — that is very likely the intended behavior, not a bug to
relax.

### 3. Trade + launch prepare (`trade-launch-prepare.js`)

`TRADE_RATE=20`/sec (ramping-arrival-rate, ramped over 20s, held 90s),
`LAUNCH_RATE=2` per 10s (well under the 5/wallet/hr and 30/IP/hr launch
limiters across the run's wallet/IP pool), authenticated with real JWTs for
150 distinct synthetic wallets.

| Metric | Result |
|---|---|
| Total requests | 2,167 (18/s combined) |
| `POST /trade/prepare` avg / p90 / p95 / p99 | 120ms / 145ms / **150ms** / **201ms** |
| `POST /trade/prepare` error rate | 0.37% (8 of 2,149) |
| `POST /launch/prepare` avg / p90 / p95 | 100ms / 139ms / **210ms** |
| Overall checks | 100% passed (`answered` = any non-5xx; the 0.37% "errors" above are k6's stricter `http_req_failed`, which flags 4xx too) |

The 8 failed `trade/prepare` calls are expected, not bugs: the script
deliberately mixes buy/sell across a shared pool of tokens that other VUs
are simultaneously trading, so a sell sized larger than a token's currently
sold supply, or a request that lands just past the 60/min per-wallet trade
limiter, correctly returns a 4xx (422/429) rather than a 5xx — the script's
own check (`'trade/prepare answered': (r) => r.status < 500`) is written to
treat exactly this as a pass, and 0.37% is well under this test's 5%
threshold either way.

**Assessment: PASS with comfortable margin.** Both endpoints — which do
real curve-math computation, JWT verification, and (via the stub) a
blockhash + balance RPC round-trip per request — stayed under 250ms at p95
against 60ms-latency stubbed RPCs. In production, real Solana/EVM RPC calls
from a paid provider will typically add tens to a couple hundred ms of
additional real-network latency per call beyond what the 60ms stub models;
budget accordingly if a stricter SLA is set later, but there is no
indication here that `apps/api`'s own processing is a meaningful fraction of
end-to-end latency — it is consistently the smallest contributor.

## Bottlenecks found

**None required a fix.** Read-path p95 latency (10.5ms) and write-path p95
latency (150–210ms, dominated by the stubbed RPC round-trips, not DB/CPU
work) were both well within target at the tested scale, and the existing
schema already has purpose-built indexes for every query pattern exercised
(`apps/api/drizzle/0001_read_tables.sql` and `0003_index_advisor.sql` — e.g.
`tokens_lane_mc_idx`, `trades_token_recent_idx`, `tape_net_recent_idx`,
`candles_range_idx`, `holders_top_idx`). No N+1 query pattern, missing
index, or missing cache was observed in any route under test. The one
non-zero error rate found (`quote-burst`'s 7.45%) was root-caused to
correct rate-limiter behavior under a load-test-harness artifact, not an
application bottleneck — see §2 above; no code change was made for it.

## Caveats — what this run does and doesn't tell you

- **Single machine, not isolated infra.** The API, Postgres, Redis, and k6
  itself all ran on one laptop competing for the same CPU/memory/disk — a
  production deployment with the API and DB on separate, dedicated
  infrastructure would very likely show *better* p95/p99 than recorded here,
  not worse, so these numbers are a conservative (if anything) estimate of
  API-side latency.
- **RPCs and the price oracle are stubbed**, not real Solana/EVM RPCs — by
  design (see `loadtest/README.md` for why hitting real public RPCs at load
  is unsafe and unrepresentative). The 60ms fixed stub latency is a
  reasonable paid-provider estimate but real-world RPC latency has its own
  variance and occasional spikes this stub does not model.
- **WS broadcast fan-out throughput under sustained live indexer traffic
  was not measured** in this run (see the note under §1) — only
  connect/subscribe/idle-hold at 100 concurrent sessions was.
- **RH (EVM) net was not run as a separate load test** — same route code,
  same DB indexes, only the address/RPC client differs; there is no reason
  to expect materially different numbers, but it wasn't independently
  verified here.
- **Docker Postgres/Redis ran with default resource limits**, not a sized
  production instance (e.g. Neon's actual provisioned tier) — connection
  pool exhaustion or Neon-specific behavior (serverless cold starts, compute
  autoscaling latency) under sustained load was not exercised by this setup.
