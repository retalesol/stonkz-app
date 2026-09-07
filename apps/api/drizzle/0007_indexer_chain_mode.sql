-- Phase C: everything `apps/indexer` needs to ingest a real chain safely.
--
-- Three groups of change:
--   1. `indexer_cursors` learns what the chain looked like at the cursor, so a
--      reorg is detectable at all (`0001` stored only a position number).
--   2. `indexer_dead_letters` gives a rejected event or a poison batch a
--      durable home, so ingest can skip it instead of re-looping forever.
--   3. `tape` and `treasury_credits` learn their chain position, so a rollback
--      can find the rows an orphaned range materialised. `trades` and
--      `chain_events` already carry one.

-- The block hash (EVM) or blockhash (Solana) of the block/slot the cursor sits
-- on. NULL means "never observed" — a fresh cursor, or fixture mode, which has
-- no hashes at all. Reorg detection treats NULL as "nothing to compare".
ALTER TABLE "indexer_cursors" ADD COLUMN "position_hash" text;
--> statement-breakpoint
-- Solana's `getSignaturesForAddress` pages by signature, not slot. Storing the
-- last signature committed at `position` lets the poller pass it as `until`
-- and stop walking backwards there, instead of re-scanning from the tip.
ALTER TABLE "indexer_cursors" ADD COLUMN "position_signature" text;
--> statement-breakpoint
-- The confirmation-gated head: `chain_head` stays the raw tip (so lag is
-- measured against reality) while this is the highest position ingest is
-- allowed to reach. Operators need both to tell "lagging" from "waiting for
-- confirmations".
ALTER TABLE "indexer_cursors" ADD COLUMN "confirmed_head" bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "indexer_cursors" ADD COLUMN "reorgs" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "indexer_cursors" ADD COLUMN "last_reorg_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "indexer_cursors" ADD COLUMN "last_error" text;
--> statement-breakpoint
ALTER TABLE "indexer_cursors" ADD COLUMN "last_error_at" timestamptz;
--> statement-breakpoint
-- Consecutive failures at the current position. `runner.ts` dead-letters the
-- batch once this crosses `INDEXER_MAX_BATCH_ATTEMPTS`, and zeroes it on any
-- successful pass, so a transient RPC blip never accumulates toward a skip.
ALTER TABLE "indexer_cursors" ADD COLUMN "failed_attempts" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE "indexer_dead_letters" (
  "id" bigserial PRIMARY KEY,
  "net" text NOT NULL,
  -- 'event' for a single rejected event, 'batch' for a whole poison range.
  "scope" text NOT NULL DEFAULT 'event',
  "kind" text NOT NULL,
  "tx_sig" text NOT NULL,
  "log_index" integer NOT NULL DEFAULT 0,
  "chain_position" bigint NOT NULL,
  -- The range a 'batch' entry covers; equal to `chain_position` for events.
  "from_position" bigint NOT NULL DEFAULT 0,
  "to_position" bigint NOT NULL DEFAULT 0,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "error" text NOT NULL,
  "attempts" integer NOT NULL DEFAULT 1,
  "first_seen_at" timestamptz NOT NULL DEFAULT now(),
  "last_seen_at" timestamptz NOT NULL DEFAULT now(),
  -- Set by an operator (or a successful backfill) to take an entry off the
  -- "needs a human" count without losing the record of it.
  "resolved_at" timestamptz,
  CONSTRAINT "indexer_dead_letters_net_ck" CHECK ("net" IN ('SOL', 'RH')),
  CONSTRAINT "indexer_dead_letters_scope_ck" CHECK ("scope" IN ('event', 'batch'))
);
--> statement-breakpoint
-- One row per distinct failure identity; a repeat bumps `attempts` instead of
-- growing the table without bound.
CREATE UNIQUE INDEX "indexer_dead_letters_uq" ON "indexer_dead_letters" ("net", "tx_sig", "log_index", "kind");
--> statement-breakpoint
CREATE INDEX "indexer_dead_letters_open_idx" ON "indexer_dead_letters" ("net", "resolved_at", "id");
--> statement-breakpoint
CREATE INDEX "indexer_dead_letters_position_idx" ON "indexer_dead_letters" ("net", "chain_position");
--> statement-breakpoint
-- Existing fixture-sourced rows have no position; 0 is correct for them
-- because a rollback only ever deletes rows *above* a fork position, and a
-- fork position is never negative.
ALTER TABLE "tape" ADD COLUMN "chain_position" bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX "tape_position_idx" ON "tape" ("net", "chain_position");
--> statement-breakpoint
ALTER TABLE "treasury_credits" ADD COLUMN "chain_position" bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX "treasury_credits_position_idx" ON "treasury_credits" ("net", "chain_position");
--> statement-breakpoint
-- The rollback walks orphaned events newest-first within a net; without this
-- it is a sort over the whole table on every reorg.
CREATE INDEX "chain_events_rollback_idx" ON "chain_events" ("net", "chain_position", "id");
--> statement-breakpoint
-- `tokens.mint` is how a decoded on-chain event (which names a mint/contract
-- address, never a ticker) finds the row it belongs to.
CREATE INDEX "tokens_mint_idx" ON "tokens" ("net", "mint");
