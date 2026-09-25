-- Extend net CHECK constraints to allow Circle Arc (`ARC`), and seed the rows
-- 0013 / 0014 had to add separately for Base: the ARC replay cursor and both
-- ARC treasury vaults (ingest credits vaults with a plain UPDATE, so a net
-- without vault rows silently drops every protocol / ops fee).
-- One statement per breakpoint: the migrator runs each chunk as a single
-- prepared statement, which refuses more than one command.

ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_net_ck";
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_net_ck" CHECK ("net" IN ('SOL', 'RH', 'BASE', 'ARC'));
--> statement-breakpoint
ALTER TABLE "auth_nonces" DROP CONSTRAINT IF EXISTS "auth_nonces_net_ck";
--> statement-breakpoint
ALTER TABLE "auth_nonces" ADD CONSTRAINT "auth_nonces_net_ck" CHECK ("net" IN ('SOL', 'RH', 'BASE', 'ARC'));
--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_net_ck";
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_net_ck" CHECK ("net" IN ('SOL', 'RH', 'BASE', 'ARC'));
--> statement-breakpoint
ALTER TABLE "tokens" DROP CONSTRAINT IF EXISTS "tokens_net_ck";
--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_net_ck" CHECK ("net" IN ('SOL', 'RH', 'BASE', 'ARC'));
--> statement-breakpoint
ALTER TABLE "trades" DROP CONSTRAINT IF EXISTS "trades_net_ck";
--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_net_ck" CHECK ("net" IN ('SOL', 'RH', 'BASE', 'ARC'));
--> statement-breakpoint
ALTER TABLE "koth" DROP CONSTRAINT IF EXISTS "koth_net_ck";
--> statement-breakpoint
ALTER TABLE "koth" ADD CONSTRAINT "koth_net_ck" CHECK ("net" IN ('SOL', 'RH', 'BASE', 'ARC'));
--> statement-breakpoint
ALTER TABLE "chain_events" DROP CONSTRAINT IF EXISTS "chain_events_net_ck";
--> statement-breakpoint
ALTER TABLE "chain_events" ADD CONSTRAINT "chain_events_net_ck" CHECK ("net" IN ('SOL', 'RH', 'BASE', 'ARC'));
--> statement-breakpoint
ALTER TABLE "indexer_cursors" DROP CONSTRAINT IF EXISTS "indexer_cursors_net_ck";
--> statement-breakpoint
ALTER TABLE "indexer_cursors" ADD CONSTRAINT "indexer_cursors_net_ck" CHECK ("net" IN ('SOL', 'RH', 'BASE', 'ARC'));
--> statement-breakpoint
ALTER TABLE "indexer_dead_letters" DROP CONSTRAINT IF EXISTS "indexer_dead_letters_net_ck";
--> statement-breakpoint
ALTER TABLE "indexer_dead_letters" ADD CONSTRAINT "indexer_dead_letters_net_ck" CHECK ("net" IN ('SOL', 'RH', 'BASE', 'ARC'));
--> statement-breakpoint
ALTER TABLE "launch_intents" DROP CONSTRAINT IF EXISTS "launch_intents_net_ck";
--> statement-breakpoint
ALTER TABLE "launch_intents" ADD CONSTRAINT "launch_intents_net_ck" CHECK ("net" IN ('SOL', 'RH', 'BASE', 'ARC'));
--> statement-breakpoint
ALTER TABLE "xp_events" DROP CONSTRAINT IF EXISTS "xp_events_net_ck";
--> statement-breakpoint
ALTER TABLE "xp_events" ADD CONSTRAINT "xp_events_net_ck" CHECK ("net" IN ('SOL', 'RH', 'BASE', 'ARC'));
--> statement-breakpoint
ALTER TABLE "balances" DROP CONSTRAINT IF EXISTS "balances_net_ck";
--> statement-breakpoint
ALTER TABLE "balances" ADD CONSTRAINT "balances_net_ck" CHECK ("net" IN ('SOL', 'RH', 'BASE', 'ARC'));
--> statement-breakpoint
INSERT INTO "indexer_cursors" ("net") VALUES ('ARC')
ON CONFLICT ("net") DO NOTHING;
--> statement-breakpoint
INSERT INTO "treasuries" ("net", "kind") VALUES ('ARC', 'protocol')
ON CONFLICT ("net", "kind") DO NOTHING;
--> statement-breakpoint
INSERT INTO "treasuries" ("net", "kind") VALUES ('ARC', 'stonkz_ops')
ON CONFLICT ("net", "kind") DO NOTHING;
