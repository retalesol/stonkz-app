-- Self-serve on-chain referral claims (docs/referral-payouts.md).
--
-- A `native` payout row is now either the operator batch (`method = 'batch'`,
-- the original path: the protocol withdraw authority pays it) or a voucher the
-- referrer redeems against the chain's ReferralVault (`method = 'onchain'`).
-- On-chain rows carry the exact atoms the voucher was cut for and the
-- **cumulative** lifetime atoms it certifies: the vault pays
-- `cumulative - already claimed`, so the API only ever signs the running
-- maximum of these rows and a replayed or stale voucher pays nothing.
ALTER TABLE "referral_payouts" ADD COLUMN IF NOT EXISTS "method" text NOT NULL DEFAULT 'batch';--> statement-breakpoint
ALTER TABLE "referral_payouts" ADD COLUMN IF NOT EXISTS "asset" text;--> statement-breakpoint
ALTER TABLE "referral_payouts" ADD COLUMN IF NOT EXISTS "amount_atoms" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "referral_payouts" ADD COLUMN IF NOT EXISTS "cumulative_atoms" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "referral_payouts" ADD COLUMN IF NOT EXISTS "voucher" jsonb;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "referral_payouts_onchain_idx" ON "referral_payouts" ("net", "wallet", "method", "asset");
