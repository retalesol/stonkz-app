-- Review gate 3.A — index advisor pass.
--
-- Every index below was added because a real query plan in this repo would
-- otherwise sequential-scan. The query that motivated each one is named.
-- `db/index-advisor.test.ts` re-runs those plans and fails on a Seq Scan.

-- GET /tokens?lane=&sort=mc — board lanes, hottest first.
CREATE INDEX "tokens_lane_mc_idx" ON "tokens" ("net", "lane", "mc" DESC);
--> statement-breakpoint
-- GET /tokens?sort=new — the NEW lane is age-ordered, not cap-ordered.
CREATE INDEX "tokens_launched_idx" ON "tokens" ("net", "launched_at" DESC);
--> statement-breakpoint
-- GET /tokens?q= — prefix search on ticker and name. C locale keeps
-- `LIKE 'ABC%'` index-eligible without a varchar_pattern_ops opclass.
CREATE INDEX "tokens_sym_prefix_idx" ON "tokens" ("net", "sym" text_pattern_ops);
--> statement-breakpoint
CREATE INDEX "tokens_name_prefix_idx" ON "tokens" ("net", lower("name") text_pattern_ops);
--> statement-breakpoint
-- GET /tokens/:sym/trades — newest fills first.
CREATE INDEX "trades_token_recent_idx" ON "trades" ("net", "sym", "id" DESC);
--> statement-breakpoint
-- GET /tape — global feed, newest first, optionally net-filtered.
CREATE INDEX "tape_net_recent_idx" ON "tape" ("net", "id" DESC);
--> statement-breakpoint
CREATE INDEX "tape_recent_idx" ON "tape" ("id" DESC);
--> statement-breakpoint
-- GET /tokens/:sym/candles?tf= — a bounded time range within one series.
CREATE INDEX "candles_range_idx" ON "candles" ("net", "sym", "tf", "bucket_start" DESC);
--> statement-breakpoint
-- GET /tokens/:sym/holders — top holders. Zero-balance rows are kept for cost
-- basis but never appear in the list, so the index is partial.
CREATE INDEX "holders_top_idx" ON "holders_snapshot" ("net", "sym", "token_amount" DESC)
  WHERE "token_amount" > 0;
--> statement-breakpoint
-- The diamond-hands sweep walks live positions across every token.
CREATE INDEX "holders_live_idx" ON "holders_snapshot" ("net", "wallet")
  WHERE "token_amount" > 0;
--> statement-breakpoint
-- Daily XP/SP cap check: SUM(amount) for one wallet on one UTC day.
CREATE INDEX "xp_events_cap_idx" ON "xp_events" ("wallet", "net", "day_utc", "amount");
--> statement-breakpoint
-- GET /rewards drop log — the last 14 opens for one wallet.
CREATE INDEX "crate_opens_log_idx" ON "crate_opens" ("wallet", "net", "opened_at" DESC);
--> statement-breakpoint
-- Indexer replay: "everything at or after cursor position", in chain order.
CREATE INDEX "chain_events_replay_idx" ON "chain_events" ("net", "chain_position", "id");
--> statement-breakpoint
-- Session refresh sweeps only ever want live sessions.
CREATE INDEX "sessions_live_idx" ON "sessions" ("net", "wallet", "expires_at")
  WHERE "revoked_at" IS NULL;
--> statement-breakpoint
ANALYZE;
