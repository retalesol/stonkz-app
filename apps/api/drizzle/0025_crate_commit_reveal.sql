-- Progression audit (rewards): crate commit–reveal, per-net award dedupe.
--
-- 1. `crate_commitments`: one pending server seed per (wallet, net). Its
--    sha256 is published on GET /rewards BEFORE an open; the open consumes it,
--    rolls HMAC-SHA256(seed, net|wallet|tier|clientSeed), reveals the seed on
--    the drop log and commits a fresh one. Replaces the single never-rotated
--    CRATE_HMAC_SECRET roll (security finding M2).
-- 2. `crate_opens.server_seed` / `client_seeded`: the revealed seed and whether
--    the client supplied its seed. Legacy rows keep NULL / false and are shown
--    as "not user-verifiable" in the history.
-- 3. `xp_events_sig_reason_uq` gains `net`: an EVM address is the same string
--    on RH, Base and Arc, so synthetic keys (`checkin:<day>`, `follow:<addr>`)
--    collided across nets and the second net's daily check-in never paid.

CREATE TABLE IF NOT EXISTS "crate_commitments" (
  "wallet" text NOT NULL,
  "net" text NOT NULL,
  "seed" text NOT NULL,
  "seed_hash" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("wallet", "net")
);
--> statement-breakpoint
ALTER TABLE "crate_opens" ADD COLUMN IF NOT EXISTS "server_seed" text;
--> statement-breakpoint
ALTER TABLE "crate_opens" ADD COLUMN IF NOT EXISTS "client_seeded" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
DROP INDEX IF EXISTS "xp_events_sig_reason_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "xp_events_sig_reason_uq" ON "xp_events" ("wallet", "net", "tx_sig", "reason") WHERE "tx_sig" IS NOT NULL;
