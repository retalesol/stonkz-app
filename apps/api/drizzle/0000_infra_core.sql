-- Phase 1.A — identity, sessions, settings.
--
-- pgcrypto is enabled where it exists (Neon, the docker-compose image). The
-- guard keeps the same history runnable on PGlite, which the test suite uses
-- and which ships without the extension. Nothing depends on it: gen_random_uuid()
-- has been in Postgres core since 13.
DO $$
BEGIN
  EXECUTE 'CREATE EXTENSION IF NOT EXISTS pgcrypto';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgcrypto unavailable (%); gen_random_uuid() is core in PG13+', SQLERRM;
END
$$;
--> statement-breakpoint
CREATE TABLE "users" (
  "net" text NOT NULL,
  "wallet" text NOT NULL,
  "username" text,
  "bio" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "users_pkey" PRIMARY KEY ("net", "wallet"),
  CONSTRAINT "users_net_ck" CHECK ("net" IN ('SOL', 'RH')),
  CONSTRAINT "users_username_len_ck" CHECK ("username" IS NULL OR char_length("username") BETWEEN 1 AND 22),
  CONSTRAINT "users_bio_len_ck" CHECK ("bio" IS NULL OR char_length("bio") <= 160)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_uq" ON "users" (lower("username")) WHERE "username" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "auth_nonces" (
  "nonce" text PRIMARY KEY,
  "net" text NOT NULL,
  "domain" text NOT NULL,
  "statement" text NOT NULL,
  "issued_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "consumed_by" text,
  CONSTRAINT "auth_nonces_net_ck" CHECK ("net" IN ('SOL', 'RH'))
);
--> statement-breakpoint
CREATE INDEX "auth_nonces_expires_idx" ON "auth_nonces" ("expires_at");
--> statement-breakpoint
CREATE TABLE "sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "net" text NOT NULL,
  "wallet" text NOT NULL,
  "refresh_hash" text NOT NULL,
  "issued_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  "user_agent" text,
  "ip" text,
  CONSTRAINT "sessions_net_ck" CHECK ("net" IN ('SOL', 'RH'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_refresh_hash_uq" ON "sessions" ("refresh_hash");
--> statement-breakpoint
CREATE INDEX "sessions_wallet_idx" ON "sessions" ("net", "wallet");
--> statement-breakpoint
CREATE TABLE "settings" (
  "net" text NOT NULL,
  "wallet" text NOT NULL,
  "slip" double precision NOT NULL DEFAULT 1.5,
  "prio" double precision NOT NULL DEFAULT 0.0005,
  "mev" text NOT NULL DEFAULT 'SHIELD',
  "mev_tip" double precision NOT NULL DEFAULT 0.001,
  "cap" double precision NOT NULL DEFAULT 5,
  "def_buy" double precision NOT NULL DEFAULT 0.5,
  "confirm" boolean NOT NULL DEFAULT true,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "settings_pkey" PRIMARY KEY ("net", "wallet"),
  CONSTRAINT "settings_mev_ck" CHECK ("mev" IN ('SHIELD', 'RELAY', 'OFF'))
);
