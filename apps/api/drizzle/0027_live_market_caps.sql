-- Pump.fun-style market caps: the base-denominated figures are the source of
-- truth and every USD figure is `base × the LIVE base price` at read time.
--
-- Until now `tokens.mc`, `trades.mc`, `tape.mc` and the candle OHLC were USD
-- at the oracle snapshot stamped on the launch (`tokens.base_price_usd_1e6`),
-- so a coin's cap never moved when ETH/SOL moved. The snapshot columns stay:
-- lanes, KOTH selection and graduation are base-proportional through them,
-- and rows without a curve (fixtures, `'0'` price) keep reading them as USD.
--
-- Backfill: `base = usd × 1e6 / base_price_usd_1e6`, which is exactly how the
-- USD figure was produced (`mcapUsd1e6`), so the round trip is lossless up to
-- double precision.
ALTER TABLE "tokens" ADD COLUMN IF NOT EXISTS "mc_base" double precision;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN IF NOT EXISTS "last_mc_base" double precision;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN IF NOT EXISTS "mc_base" double precision;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN IF NOT EXISTS "price_base" double precision;--> statement-breakpoint
ALTER TABLE "tape" ADD COLUMN IF NOT EXISTS "mc_base" double precision;--> statement-breakpoint
ALTER TABLE "koth" ADD COLUMN IF NOT EXISTS "mc_base" double precision;--> statement-breakpoint
ALTER TABLE "candles" ADD COLUMN IF NOT EXISTS "o_base" double precision;--> statement-breakpoint
ALTER TABLE "candles" ADD COLUMN IF NOT EXISTS "h_base" double precision;--> statement-breakpoint
ALTER TABLE "candles" ADD COLUMN IF NOT EXISTS "l_base" double precision;--> statement-breakpoint
ALTER TABLE "candles" ADD COLUMN IF NOT EXISTS "c_base" double precision;--> statement-breakpoint
UPDATE "tokens"
SET "mc_base" = ("mc" * 1e6 / "base_price_usd_1e6"::numeric)::double precision,
    "last_mc_base" = ("last_mc" * 1e6 / "base_price_usd_1e6"::numeric)::double precision
WHERE "mc_base" IS NULL
  AND "base_price_usd_1e6" ~ '^[0-9]+$'
  AND "base_price_usd_1e6" <> '0';--> statement-breakpoint
UPDATE "trades" tr
SET "mc_base" = (tr."mc" * 1e6 / t."base_price_usd_1e6"::numeric)::double precision,
    "price_base" = (tr."price" * 1e6 / t."base_price_usd_1e6"::numeric)::double precision
FROM "tokens" t
WHERE tr."mc_base" IS NULL
  AND t."net" = tr."net"
  AND t."mint" = tr."mint"
  AND t."base_price_usd_1e6" ~ '^[0-9]+$'
  AND t."base_price_usd_1e6" <> '0';--> statement-breakpoint
UPDATE "tape" tp
SET "mc_base" = (tp."mc" * 1e6 / t."base_price_usd_1e6"::numeric)::double precision
FROM (
  SELECT DISTINCT ON ("net", "sym") "net", "sym", "base_price_usd_1e6"
  FROM "tokens"
  ORDER BY "net", "sym", "launched_at" DESC
) t
WHERE tp."mc_base" IS NULL
  AND t."net" = tp."net"
  AND t."sym" = tp."sym"
  AND t."base_price_usd_1e6" ~ '^[0-9]+$'
  AND t."base_price_usd_1e6" <> '0';--> statement-breakpoint
UPDATE "koth" k
SET "mc_base" = (k."mc" * 1e6 / t."base_price_usd_1e6"::numeric)::double precision
FROM (
  SELECT DISTINCT ON ("net", "sym") "net", "sym", "base_price_usd_1e6"
  FROM "tokens"
  ORDER BY "net", "sym", "launched_at" DESC
) t
WHERE k."mc_base" IS NULL
  AND t."net" = k."net"
  AND t."sym" = k."sym"
  AND t."base_price_usd_1e6" ~ '^[0-9]+$'
  AND t."base_price_usd_1e6" <> '0';--> statement-breakpoint
UPDATE "candles" c
SET "o_base" = (c."o" * 1e6 / t."base_price_usd_1e6"::numeric)::double precision,
    "h_base" = (c."h" * 1e6 / t."base_price_usd_1e6"::numeric)::double precision,
    "l_base" = (c."l" * 1e6 / t."base_price_usd_1e6"::numeric)::double precision,
    "c_base" = (c."c" * 1e6 / t."base_price_usd_1e6"::numeric)::double precision
FROM "tokens" t
WHERE c."o_base" IS NULL
  AND t."net" = c."net"
  AND t."mint" = c."mint"
  AND t."base_price_usd_1e6" ~ '^[0-9]+$'
  AND t."base_price_usd_1e6" <> '0';
