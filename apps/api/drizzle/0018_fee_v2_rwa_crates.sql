-- Fee split v2: 69% creator bucket / 15% protocol / 10% `$STONKZ` buyback /
-- 6% RWA crate fund. The on-chain vaults keep their seeds and event field
-- names (`stonkz_ops`/ops, `burn`); only what they fund changed, so the
-- treasury kinds are renamed in place: `stonkz_ops` -> `buyback`,
-- `burn` -> `rwa`. Order per table: drop CHECK, move rows, re-add CHECK.
--
-- Crates now pay `$STONKZ` reward credits (was Stonk Optionz) and RWA
-- positions, so the off-chain balance column, the ledger asset and the crate
-- audit column are renamed, and RWA holdings get their own table.

ALTER TABLE "treasuries" DROP CONSTRAINT IF EXISTS "treasuries_kind_ck";
--> statement-breakpoint
UPDATE "treasuries" SET "kind" = 'buyback' WHERE "kind" = 'stonkz_ops';
--> statement-breakpoint
UPDATE "treasuries" SET "kind" = 'rwa' WHERE "kind" = 'burn';
--> statement-breakpoint
ALTER TABLE "treasuries" ADD CONSTRAINT "treasuries_kind_ck" CHECK ("kind" IN ('protocol', 'buyback', 'rwa'));
--> statement-breakpoint
ALTER TABLE "treasury_credits" DROP CONSTRAINT IF EXISTS "treasury_credits_kind_ck";
--> statement-breakpoint
UPDATE "treasury_credits" SET "kind" = 'buyback' WHERE "kind" = 'stonkz_ops';
--> statement-breakpoint
UPDATE "treasury_credits" SET "kind" = 'rwa' WHERE "kind" = 'burn';
--> statement-breakpoint
ALTER TABLE "treasury_credits" ADD CONSTRAINT "treasury_credits_kind_ck" CHECK ("kind" IN ('protocol', 'buyback', 'rwa'));
--> statement-breakpoint
ALTER TABLE "balances" RENAME COLUMN "optionz" TO "stonkz";
--> statement-breakpoint
ALTER TABLE "crate_opens" RENAME COLUMN "optionz_awarded" TO "stonkz_awarded";
--> statement-breakpoint
ALTER TABLE "balance_ledger" DROP CONSTRAINT IF EXISTS "balance_ledger_asset_ck";
--> statement-breakpoint
UPDATE "balance_ledger" SET "asset" = 'STONKZ' WHERE "asset" = 'OPTIONZ';
--> statement-breakpoint
ALTER TABLE "balance_ledger" ADD CONSTRAINT "balance_ledger_asset_ck" CHECK ("asset" IN ('XP', 'SP', 'STONKZ'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rwa_rewards" (
  "net" text NOT NULL,
  "wallet" text NOT NULL,
  "asset" text NOT NULL,
  "units" double precision NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "rwa_rewards_pkey" PRIMARY KEY ("net", "wallet", "asset"),
  CONSTRAINT "rwa_rewards_units_nonneg_ck" CHECK ("units" >= 0)
);
