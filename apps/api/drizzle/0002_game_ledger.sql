-- Phase 3.A — the server-authoritative game ledger.
--
-- Identity is (wallet, net) everywhere. Balances are a fold of xp_events and
-- balance_ledger; neither of those is ever updated or deleted.
CREATE TABLE "xp_events" (
  "id" bigserial PRIMARY KEY,
  "wallet" text NOT NULL,
  "net" text NOT NULL,
  "amount" integer NOT NULL,
  "base_amount" integer NOT NULL,
  "reason" text NOT NULL,
  "tx_sig" text,
  "sym" text,
  "day_utc" date NOT NULL,
  "meta" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "xp_events_net_ck" CHECK ("net" IN ('SOL', 'RH')),
  CONSTRAINT "xp_events_amount_ck" CHECK ("amount" >= 0)
);
--> statement-breakpoint
-- Step 101: one award per (wallet, signature, reason). A chain replay that
-- re-delivers the same fill cannot pay twice.
CREATE UNIQUE INDEX "xp_events_sig_reason_uq"
  ON "xp_events" ("wallet", "tx_sig", "reason")
  WHERE "tx_sig" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "xp_events_day_idx" ON "xp_events" ("wallet", "net", "day_utc");
--> statement-breakpoint
CREATE INDEX "xp_events_recent_idx" ON "xp_events" ("wallet", "net", "id");
--> statement-breakpoint
CREATE TABLE "balances" (
  "wallet" text NOT NULL,
  "net" text NOT NULL,
  "xp" bigint NOT NULL DEFAULT 0,
  "sp" bigint NOT NULL DEFAULT 0,
  "optionz" bigint NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "balances_pkey" PRIMARY KEY ("wallet", "net"),
  CONSTRAINT "balances_net_ck" CHECK ("net" IN ('SOL', 'RH')),
  CONSTRAINT "balances_nonneg_ck" CHECK ("xp" >= 0 AND "sp" >= 0 AND "optionz" >= 0)
);
--> statement-breakpoint
CREATE TABLE "balance_ledger" (
  "id" bigserial PRIMARY KEY,
  "wallet" text NOT NULL,
  "net" text NOT NULL,
  "asset" text NOT NULL,
  "delta" bigint NOT NULL,
  "balance_after" bigint NOT NULL,
  "reason" text NOT NULL,
  "ref_type" text,
  "ref_id" text,
  "day_utc" date NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "balance_ledger_asset_ck" CHECK ("asset" IN ('XP', 'SP', 'OPTIONZ'))
);
--> statement-breakpoint
CREATE INDEX "balance_ledger_wallet_idx" ON "balance_ledger" ("wallet", "net", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "balance_ledger_ref_uq"
  ON "balance_ledger" ("wallet", "net", "asset", "ref_type", "ref_id")
  WHERE "ref_id" IS NOT NULL;
--> statement-breakpoint
-- Server UTC only. The client's calendar never reaches this table.
CREATE TABLE "streaks" (
  "wallet" text NOT NULL,
  "net" text NOT NULL,
  "count" integer NOT NULL DEFAULT 0,
  "last_day_utc" date,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "streaks_pkey" PRIMARY KEY ("wallet", "net"),
  CONSTRAINT "streaks_count_ck" CHECK ("count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "achievements" (
  "wallet" text NOT NULL,
  "net" text NOT NULL,
  "key" text NOT NULL,
  "unlocked_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "achievements_pkey" PRIMARY KEY ("wallet", "net", "key"),
  CONSTRAINT "achievements_key_ck" CHECK ("key" IN (
    'first', 'whale', 'deploy', 'cashback', 'stake',
    'crate', 'diamond', 'grad', 'social', 'streak7'
  ))
);
--> statement-breakpoint
CREATE TABLE "crate_state" (
  "wallet" text NOT NULL,
  "net" text NOT NULL,
  "tier" text NOT NULL,
  "ready_at" timestamptz NOT NULL DEFAULT now(),
  "opens" integer NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "crate_state_pkey" PRIMARY KEY ("wallet", "net", "tier"),
  CONSTRAINT "crate_state_tier_ck" CHECK ("tier" IN (
    'BRONZE', 'IRON', 'SILVER', 'GOLD', 'PLATINUM', 'IRIDIUM', 'PALLADIUM', 'RHODIUM'
  ))
);
--> statement-breakpoint
-- roll_commit is the HMAC commitment for the roll. Server-only RNG; the client
-- supplies nothing that can steer it.
CREATE TABLE "crate_opens" (
  "id" bigserial PRIMARY KEY,
  "wallet" text NOT NULL,
  "net" text NOT NULL,
  "tier" text NOT NULL,
  "roll_commit" text NOT NULL,
  "server_seed_hash" text NOT NULL,
  "client_nonce" text NOT NULL,
  "roll_value" double precision NOT NULL,
  "amount_roll" double precision NOT NULL,
  "drop_index" integer NOT NULL,
  "rarity" text NOT NULL,
  "payload_json" jsonb NOT NULL,
  "optionz_awarded" bigint NOT NULL DEFAULT 0,
  "item_key" text,
  "xp_awarded" integer NOT NULL DEFAULT 0,
  "opened_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "crate_opens_roll_ck" CHECK ("roll_value" >= 0 AND "roll_value" < 100),
  CONSTRAINT "crate_opens_drop_ck" CHECK ("drop_index" BETWEEN 0 AND 4)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "crate_opens_commit_uq" ON "crate_opens" ("wallet", "net", "roll_commit");
--> statement-breakpoint
CREATE INDEX "crate_opens_recent_idx" ON "crate_opens" ("wallet", "net", "id");
--> statement-breakpoint
-- Crate `I` drops become flags, not a balance.
CREATE TABLE "item_flags" (
  "wallet" text NOT NULL,
  "net" text NOT NULL,
  "item" text NOT NULL,
  "count" integer NOT NULL DEFAULT 1,
  "granted_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz,
  CONSTRAINT "item_flags_pkey" PRIMARY KEY ("wallet", "net", "item")
);
