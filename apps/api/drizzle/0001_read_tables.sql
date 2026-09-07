-- Phase 1.C — the indexer read path, both chains.
CREATE TABLE "tokens" (
  "net" text NOT NULL,
  "sym" text NOT NULL,
  "name" text NOT NULL,
  "descr" text NOT NULL DEFAULT '',
  "creator" text NOT NULL,
  "base_symbol" text NOT NULL,
  "base_mint" text NOT NULL,
  "supply" double precision NOT NULL,
  "fee_bps" integer NOT NULL,
  "cashback" boolean NOT NULL DEFAULT false,
  "cb_start_ms" bigint,
  "mc" double precision NOT NULL DEFAULT 0,
  "last_mc" double precision NOT NULL DEFAULT 0,
  "chg" double precision NOT NULL DEFAULT 0,
  "holders" integer NOT NULL DEFAULT 0,
  "replies" integer NOT NULL DEFAULT 0,
  "lane" text NOT NULL DEFAULT 'new',
  "graduated_at" timestamptz,
  "seed" bigint NOT NULL,
  "x_handle" text,
  "website" text,
  "telegram" text,
  "launched_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "tokens_pkey" PRIMARY KEY ("net", "sym"),
  CONSTRAINT "tokens_net_ck" CHECK ("net" IN ('SOL', 'RH')),
  CONSTRAINT "tokens_lane_ck" CHECK ("lane" IN ('new', 'soon', 'grad')),
  -- The launch slider is 1.0%-5.0%; the program stores basis points.
  CONSTRAINT "tokens_fee_bps_ck" CHECK ("fee_bps" BETWEEN 100 AND 500)
);
--> statement-breakpoint
CREATE INDEX "tokens_lane_idx" ON "tokens" ("net", "lane");
--> statement-breakpoint
CREATE INDEX "tokens_mc_idx" ON "tokens" ("net", "mc");
--> statement-breakpoint
CREATE INDEX "tokens_creator_idx" ON "tokens" ("net", "creator");
--> statement-breakpoint
CREATE TABLE "trades" (
  "id" bigserial PRIMARY KEY,
  "net" text NOT NULL,
  "sym" text NOT NULL,
  "tx_sig" text NOT NULL,
  "log_index" integer NOT NULL DEFAULT 0,
  "side" text NOT NULL,
  "trader" text NOT NULL,
  "native_amount" double precision NOT NULL,
  "base_amount" double precision NOT NULL,
  "token_amount" double precision NOT NULL,
  "usd_value" double precision NOT NULL,
  "mc" double precision NOT NULL,
  "price" double precision NOT NULL,
  "cashback" boolean NOT NULL DEFAULT false,
  "block_time" timestamptz NOT NULL,
  "chain_position" bigint NOT NULL,
  CONSTRAINT "trades_side_ck" CHECK ("side" IN ('buy', 'sell')),
  CONSTRAINT "trades_net_ck" CHECK ("net" IN ('SOL', 'RH'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "trades_sig_uq" ON "trades" ("net", "tx_sig", "log_index");
--> statement-breakpoint
CREATE INDEX "trades_token_time_idx" ON "trades" ("net", "sym", "block_time");
--> statement-breakpoint
CREATE INDEX "trades_time_idx" ON "trades" ("block_time");
--> statement-breakpoint
CREATE INDEX "trades_trader_idx" ON "trades" ("net", "trader", "block_time");
--> statement-breakpoint
CREATE TABLE "candles" (
  "net" text NOT NULL,
  "sym" text NOT NULL,
  "tf" text NOT NULL,
  "bucket_start" timestamptz NOT NULL,
  "o" double precision NOT NULL,
  "h" double precision NOT NULL,
  "l" double precision NOT NULL,
  "c" double precision NOT NULL,
  "v" double precision NOT NULL DEFAULT 0,
  "native_volume" double precision NOT NULL DEFAULT 0,
  "trades" integer NOT NULL DEFAULT 0,
  CONSTRAINT "candles_pkey" PRIMARY KEY ("net", "sym", "tf", "bucket_start"),
  CONSTRAINT "candles_tf_ck" CHECK ("tf" IN ('1m', '5m', '15m', '1h', '4h', '1d'))
);
--> statement-breakpoint
CREATE TABLE "holders_snapshot" (
  "net" text NOT NULL,
  "sym" text NOT NULL,
  "wallet" text NOT NULL,
  "token_amount" double precision NOT NULL DEFAULT 0,
  "cost_native" double precision NOT NULL DEFAULT 0,
  "realized_native" double precision NOT NULL DEFAULT 0,
  "first_seen" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "holders_snapshot_pkey" PRIMARY KEY ("net", "sym", "wallet")
);
--> statement-breakpoint
CREATE INDEX "holders_by_token_idx" ON "holders_snapshot" ("net", "sym", "token_amount");
--> statement-breakpoint
CREATE INDEX "holders_by_wallet_idx" ON "holders_snapshot" ("net", "wallet");
--> statement-breakpoint
CREATE TABLE "koth" (
  "net" text PRIMARY KEY,
  "sym" text NOT NULL,
  "mc" double precision NOT NULL,
  "crowned_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "koth_net_ck" CHECK ("net" IN ('SOL', 'RH'))
);
--> statement-breakpoint
CREATE TABLE "tape" (
  "id" bigserial PRIMARY KEY,
  "net" text NOT NULL,
  "sym" text NOT NULL,
  "side" text NOT NULL,
  "trader" text NOT NULL,
  "native_amount" double precision NOT NULL,
  "token_amount" double precision NOT NULL,
  "usd_value" double precision NOT NULL,
  "mc" double precision NOT NULL,
  "cashback" boolean NOT NULL DEFAULT false,
  "tx_sig" text NOT NULL,
  "log_index" integer NOT NULL DEFAULT 0,
  "block_time" timestamptz NOT NULL,
  CONSTRAINT "tape_side_ck" CHECK ("side" IN ('buy', 'sell'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tape_sig_uq" ON "tape" ("net", "tx_sig", "log_index");
--> statement-breakpoint
CREATE INDEX "tape_time_idx" ON "tape" ("block_time");
--> statement-breakpoint
-- Protocol 20% and STONKZ-ops 10%, per net. Ops-visible, never user-claimable.
CREATE TABLE "treasuries" (
  "net" text NOT NULL,
  "kind" text NOT NULL,
  "native_balance" double precision NOT NULL DEFAULT 0,
  "lifetime_credited" double precision NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "treasuries_pkey" PRIMARY KEY ("net", "kind"),
  CONSTRAINT "treasuries_kind_ck" CHECK ("kind" IN ('protocol', 'stonkz_ops'))
);
--> statement-breakpoint
CREATE TABLE "treasury_credits" (
  "id" bigserial PRIMARY KEY,
  "net" text NOT NULL,
  "kind" text NOT NULL,
  "sym" text,
  "amount" double precision NOT NULL,
  "tx_sig" text NOT NULL,
  "log_index" integer NOT NULL DEFAULT 0,
  "block_time" timestamptz NOT NULL,
  CONSTRAINT "treasury_credits_kind_ck" CHECK ("kind" IN ('protocol', 'stonkz_ops'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_credits_sig_uq" ON "treasury_credits" ("net", "kind", "tx_sig", "log_index");
--> statement-breakpoint
-- The 70% bucket, one per token. Two launches never share a bucket.
CREATE TABLE "creator_vaults" (
  "net" text NOT NULL,
  "sym" text NOT NULL,
  "creator" text NOT NULL,
  "unclaimed_native" double precision NOT NULL DEFAULT 0,
  "unclaimed_tokens" double precision NOT NULL DEFAULT 0,
  "staker_pool_native" double precision NOT NULL DEFAULT 0,
  "lifetime_native" double precision NOT NULL DEFAULT 0,
  "claimed_native" double precision NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "creator_vaults_pkey" PRIMARY KEY ("net", "sym")
);
--> statement-breakpoint
CREATE INDEX "creator_vaults_creator_idx" ON "creator_vaults" ("net", "creator");
--> statement-breakpoint
CREATE TABLE "stake_positions" (
  "net" text NOT NULL,
  "sym" text NOT NULL,
  "wallet" text NOT NULL,
  "amount" double precision NOT NULL DEFAULT 0,
  "lock_days" integer NOT NULL DEFAULT 0,
  "mult" double precision NOT NULL DEFAULT 1,
  "until_ms" bigint NOT NULL DEFAULT 0,
  "reward_native" double precision NOT NULL DEFAULT 0,
  "reward_tokens" double precision NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "stake_positions_pkey" PRIMARY KEY ("net", "sym", "wallet")
);
--> statement-breakpoint
CREATE INDEX "stake_by_wallet_idx" ON "stake_positions" ("net", "wallet");
--> statement-breakpoint
-- Append-only record of every chain event the indexer accepted. The ledger
-- will not award XP for a chain reason without a matching row here.
CREATE TABLE "chain_events" (
  "id" bigserial PRIMARY KEY,
  "net" text NOT NULL,
  "kind" text NOT NULL,
  "sym" text,
  "wallet" text,
  "tx_sig" text NOT NULL,
  "log_index" integer NOT NULL DEFAULT 0,
  "chain_position" bigint NOT NULL,
  "block_time" timestamptz NOT NULL,
  "payload" jsonb NOT NULL,
  "ingested_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chain_events_net_ck" CHECK ("net" IN ('SOL', 'RH'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "chain_events_sig_uq" ON "chain_events" ("net", "tx_sig", "log_index", "kind");
--> statement-breakpoint
CREATE INDEX "chain_events_cursor_idx" ON "chain_events" ("net", "chain_position");
--> statement-breakpoint
-- Exactly two rows in production: the Solana slot cursor and the EVM block cursor.
CREATE TABLE "indexer_cursors" (
  "net" text PRIMARY KEY,
  "position" bigint NOT NULL DEFAULT 0,
  "chain_head" bigint NOT NULL DEFAULT 0,
  "last_event_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "indexer_cursors_net_ck" CHECK ("net" IN ('SOL', 'RH'))
);
--> statement-breakpoint
INSERT INTO "indexer_cursors" ("net") VALUES ('SOL'), ('RH');
--> statement-breakpoint
INSERT INTO "treasuries" ("net", "kind") VALUES
  ('SOL', 'protocol'), ('SOL', 'stonkz_ops'),
  ('RH', 'protocol'), ('RH', 'stonkz_ops');
