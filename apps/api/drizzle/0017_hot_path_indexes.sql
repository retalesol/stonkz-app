-- Indexes the read path grew to need after 0009 (mint-keyed trades) and the
-- fee-split work (per-coin fee aggregation, referral join). Each one backs a
-- query `db/index-advisor.test.ts` EXPLAINs.

CREATE INDEX IF NOT EXISTS "tokens_chg_idx" ON "tokens" ("net", "chg" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tokens_replies_idx" ON "tokens" ("net", "replies" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trades_mint_id_idx" ON "trades" ("net", "mint", "id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "treasury_credits_token_kind_idx" ON "treasury_credits" ("net", "sym", "kind");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "referral_fee_events_sig_idx" ON "referral_fee_events" ("net", "tx_sig");
