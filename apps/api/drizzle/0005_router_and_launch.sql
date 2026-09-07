-- Phase 2.R / 2.B — native-in router and launch/confirm/claim.
--
-- `tokens` gains the curve-state fields the read path (1.C) never needed but
-- the trade path does: the launched token's own on-chain address, and the
-- CPMM parameters/reserves in atoms so `/quote` and `/trade/prepare` can call
-- the exact same `@stonkz/curve-sim` the chain settles against instead of the
-- linear mc/supply approximation. Values are `text` (decimal-digit strings of
-- non-negative bigints) rather than `bigint`/`numeric` because a fully-staked
-- `k` can reach ~1e31 — past Postgres `bigint`'s 2^63-1 ceiling — and every
-- consumer already speaks `bigint` via `@stonkz/curve-sim`, never SQL
-- arithmetic on these columns.
ALTER TABLE "tokens"
  ADD COLUMN "mint" text NOT NULL DEFAULT '',
  ADD COLUMN "token_decimals" integer NOT NULL DEFAULT 6,
  ADD COLUMN "base_decimals" integer NOT NULL DEFAULT 6,
  ADD COLUMN "base_price_usd_1e6" text NOT NULL DEFAULT '0',
  ADD COLUMN "curve_tokens_for_sale" text NOT NULL DEFAULT '0',
  ADD COLUMN "curve_virtual_base0" text NOT NULL DEFAULT '0',
  ADD COLUMN "curve_virtual_token0" text NOT NULL DEFAULT '0',
  ADD COLUMN "curve_k" text NOT NULL DEFAULT '0',
  ADD COLUMN "curve_real_base" text NOT NULL DEFAULT '0',
  ADD COLUMN "curve_real_token" text NOT NULL DEFAULT '0',
  ADD COLUMN "curve_grad_mcap_base" text NOT NULL DEFAULT '0';
--> statement-breakpoint
-- One row per `POST /launch/prepare` call. `/launch/confirm` reads it back to
-- verify the signed transaction it is handed matches — byte for byte, on
-- Solana; `to`+`data` on Robinhood — what this server actually built, rather
-- than trusting whatever ticker/supply/fee the client reports post-signature.
-- Never a source of truth on its own: the `tokens` primary key `(net, sym)` is
-- what actually rejects a duplicate ticker at confirm time if two prepares
-- for the same ticker race.
CREATE TABLE "launch_intents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "net" text NOT NULL,
  "ticker" text NOT NULL,
  "creator" text NOT NULL,
  "name" text NOT NULL,
  "descr" text NOT NULL DEFAULT '',
  "uri" text NOT NULL DEFAULT '',
  "supply" double precision NOT NULL,
  "fee_bps" integer NOT NULL,
  "cashback" boolean NOT NULL DEFAULT false,
  "base_symbol" text NOT NULL,
  "base_mint" text NOT NULL,
  "dev_buy_native" double precision NOT NULL DEFAULT 0,
  -- The predicted mint (Solana: a PDA of the ticker, known before signing) or
  -- null (Robinhood: `new StonkzToken(...)` picks the address at call time —
  -- `confirm` recovers it from the `TokenCreated` log instead).
  "predicted_mint" text,
  -- Solana: the compiled transaction *message* (no signatures) we handed
  -- back, base64. Robinhood: the exact `data` calldata we handed back.
  -- `confirm` re-derives the same encoding from the chain read and compares.
  "unsigned_payload" text NOT NULL,
  "issued_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "consumed_tx_sig" text,
  CONSTRAINT "launch_intents_net_ck" CHECK ("net" IN ('SOL', 'RH')),
  CONSTRAINT "launch_intents_fee_bps_ck" CHECK ("fee_bps" BETWEEN 100 AND 500)
);
--> statement-breakpoint
CREATE INDEX "launch_intents_lookup_idx" ON "launch_intents" ("net", "ticker", "consumed_at");
--> statement-breakpoint
CREATE INDEX "launch_intents_creator_idx" ON "launch_intents" ("net", "creator");
--> statement-breakpoint
CREATE INDEX "launch_intents_expires_idx" ON "launch_intents" ("expires_at");
