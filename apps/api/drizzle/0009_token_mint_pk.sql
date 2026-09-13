-- Token identity moves from (net, sym) → (net, mint) so tickers/names can
-- duplicate after an app-layer cooldown. Child tables that keyed by ticker
-- retarget onto mint.

-- Synthetic mint for any pre-launch fixture rows that never got a chain address.
UPDATE "tokens"
SET "mint" = 'legacy:' || "net" || ':' || "sym"
WHERE "mint" IS NULL OR "mint" = '';
--> statement-breakpoint

ALTER TABLE "tokens" DROP CONSTRAINT "tokens_pkey";
--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_pkey" PRIMARY KEY ("net", "mint");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tokens_sym_idx" ON "tokens" ("net", "sym");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tokens_name_lower_idx" ON "tokens" ("net", lower("name"));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tokens_launched_at_idx" ON "tokens" ("net", "launched_at");
--> statement-breakpoint

-- candles
ALTER TABLE "candles" ADD COLUMN IF NOT EXISTS "mint" text;
--> statement-breakpoint
UPDATE "candles" c
SET "mint" = t."mint"
FROM "tokens" t
WHERE c."net" = t."net" AND c."sym" = t."sym" AND (c."mint" IS NULL OR c."mint" = '');
--> statement-breakpoint
DELETE FROM "candles" WHERE "mint" IS NULL OR "mint" = '';
--> statement-breakpoint
ALTER TABLE "candles" ALTER COLUMN "mint" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "candles" DROP CONSTRAINT "candles_pkey";
--> statement-breakpoint
ALTER TABLE "candles" ADD CONSTRAINT "candles_pkey" PRIMARY KEY ("net", "mint", "tf", "bucket_start");
--> statement-breakpoint

-- holders_snapshot
ALTER TABLE "holders_snapshot" ADD COLUMN IF NOT EXISTS "mint" text;
--> statement-breakpoint
UPDATE "holders_snapshot" h
SET "mint" = t."mint"
FROM "tokens" t
WHERE h."net" = t."net" AND h."sym" = t."sym" AND (h."mint" IS NULL OR h."mint" = '');
--> statement-breakpoint
DELETE FROM "holders_snapshot" WHERE "mint" IS NULL OR "mint" = '';
--> statement-breakpoint
ALTER TABLE "holders_snapshot" ALTER COLUMN "mint" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "holders_snapshot" DROP CONSTRAINT "holders_snapshot_pkey";
--> statement-breakpoint
ALTER TABLE "holders_snapshot" ADD CONSTRAINT "holders_snapshot_pkey" PRIMARY KEY ("net", "mint", "wallet");
--> statement-breakpoint
DROP INDEX IF EXISTS "holders_by_token_idx";
--> statement-breakpoint
CREATE INDEX "holders_by_token_idx" ON "holders_snapshot" ("net", "mint", "token_amount");
--> statement-breakpoint

-- creator_vaults
ALTER TABLE "creator_vaults" ADD COLUMN IF NOT EXISTS "mint" text;
--> statement-breakpoint
UPDATE "creator_vaults" v
SET "mint" = t."mint"
FROM "tokens" t
WHERE v."net" = t."net" AND v."sym" = t."sym" AND (v."mint" IS NULL OR v."mint" = '');
--> statement-breakpoint
DELETE FROM "creator_vaults" WHERE "mint" IS NULL OR "mint" = '';
--> statement-breakpoint
ALTER TABLE "creator_vaults" ALTER COLUMN "mint" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "creator_vaults" DROP CONSTRAINT "creator_vaults_pkey";
--> statement-breakpoint
ALTER TABLE "creator_vaults" ADD CONSTRAINT "creator_vaults_pkey" PRIMARY KEY ("net", "mint");
--> statement-breakpoint

-- stake_positions
ALTER TABLE "stake_positions" ADD COLUMN IF NOT EXISTS "mint" text;
--> statement-breakpoint
UPDATE "stake_positions" s
SET "mint" = t."mint"
FROM "tokens" t
WHERE s."net" = t."net" AND s."sym" = t."sym" AND (s."mint" IS NULL OR s."mint" = '');
--> statement-breakpoint
DELETE FROM "stake_positions" WHERE "mint" IS NULL OR "mint" = '';
--> statement-breakpoint
ALTER TABLE "stake_positions" ALTER COLUMN "mint" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "stake_positions" DROP CONSTRAINT "stake_positions_pkey";
--> statement-breakpoint
ALTER TABLE "stake_positions" ADD CONSTRAINT "stake_positions_pkey" PRIMARY KEY ("net", "mint", "wallet");
--> statement-breakpoint

-- trades / tape: keep sym for display, add mint for disambiguation
ALTER TABLE "trades" ADD COLUMN IF NOT EXISTS "mint" text;
--> statement-breakpoint
UPDATE "trades" tr
SET "mint" = t."mint"
FROM "tokens" t
WHERE tr."net" = t."net" AND tr."sym" = t."sym" AND (tr."mint" IS NULL OR tr."mint" = '');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trades_mint_time_idx" ON "trades" ("net", "mint", "block_time");
--> statement-breakpoint

ALTER TABLE "launch_intents" ADD COLUMN IF NOT EXISTS "mint_salt" bigint;
--> statement-breakpoint
COMMENT ON COLUMN "launch_intents"."mint_salt" IS 'Solana create_token salt for mint PDA [mint, creator, salt]; null on RH';
