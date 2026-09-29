-- Referral earnings per tier, a payout ledger, and the staker token peel.
--
-- Referral commissions (15 / 10 / 5% of a referred trader's curve fee, paid
-- out of the platform's 15% leg) were credited to one running balance per
-- wallet. A referrer could see a total but not which tier earned it, and a
-- claim could only convert the balance into `$STONKZ` reward credits. This
-- adds:
--
--   * `referral_fee_tier_balances` — pending / lifetime per (wallet, tier),
--     kept in step with `referral_fee_balances` on every credit and claim.
--   * `referral_payouts` — one row per claim. `mode = 'stonkz'` is the
--     existing credit conversion, settled at once. `mode = 'native'` is a
--     request for the commission in the chain's native/base asset: the money
--     is already in the on-chain protocol vault (the indexer credits the
--     protocol treasury net of every referral cut), so settlement is a
--     `withdrawTreasury(0, base, amount, wallet)` signed by the protocol
--     withdraw authority — a cold key the API does not hold. The operator
--     batch (`scripts/referral-payouts.ts`) lists requests, produces the
--     calldata, and marks them paid with the transaction hash.
--
-- `creator_vaults.staker_pool_tokens`: during a cashback window the creator
-- bucket is converted into the launched token on chain, so the staker peel of
-- that fill is in tokens too. It was folded into `staker_pool_native` (wrong
-- unit) and the creator's `unclaimed_native` was credited with base that was
-- never claimable. The new column carries the token peel; the indexer no
-- longer books native for a converted fill.
CREATE TABLE IF NOT EXISTS "referral_fee_tier_balances" (
  "net" text NOT NULL,
  "wallet" text NOT NULL,
  "tier" integer NOT NULL,
  "pending_native" double precision NOT NULL DEFAULT 0,
  "lifetime_native" double precision NOT NULL DEFAULT 0,
  "fills" integer NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "referral_fee_tier_balances_pk" PRIMARY KEY ("net", "wallet", "tier"),
  CONSTRAINT "referral_fee_tier_balances_tier_ck" CHECK ("tier" IN (1, 2, 3))
);
--> statement-breakpoint
-- Backfill from the per-fill ledger. Lifetime per tier is exact. Pending per
-- tier is the wallet's pending balance spread across tiers in proportion to
-- lifetime — exact wherever nothing has been claimed yet (every wallet on the
-- test nets), and the only defensible split where something has.
INSERT INTO "referral_fee_tier_balances" ("net", "wallet", "tier", "pending_native", "lifetime_native", "fills")
SELECT
  e."net",
  e."earner",
  e."tier",
  CASE
    WHEN coalesce(b."lifetime_native", 0) > 0
      THEN sum(e."payout_native") * (coalesce(b."pending_native", 0) / b."lifetime_native")
    ELSE 0
  END,
  sum(e."payout_native"),
  count(*)::int
FROM "referral_fee_events" e
LEFT JOIN "referral_fee_balances" b ON b."net" = e."net" AND b."wallet" = e."earner"
GROUP BY e."net", e."earner", e."tier", b."pending_native", b."lifetime_native"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "referral_payouts" (
  "id" bigserial PRIMARY KEY,
  "net" text NOT NULL,
  "wallet" text NOT NULL,
  "amount_native" double precision NOT NULL,
  "mode" text NOT NULL,
  "status" text NOT NULL DEFAULT 'requested',
  "tiers" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "stonkz" double precision,
  "tx_sig" text,
  "note" text,
  "requested_at" timestamptz NOT NULL DEFAULT now(),
  "settled_at" timestamptz,
  CONSTRAINT "referral_payouts_mode_ck" CHECK ("mode" IN ('stonkz', 'native')),
  CONSTRAINT "referral_payouts_status_ck" CHECK ("status" IN ('requested', 'paid', 'void'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "referral_payouts_wallet_idx" ON "referral_payouts" ("net", "wallet", "requested_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "referral_payouts_status_idx" ON "referral_payouts" ("net", "status");
--> statement-breakpoint
ALTER TABLE "creator_vaults" ADD COLUMN IF NOT EXISTS "staker_pool_tokens" double precision NOT NULL DEFAULT 0;
