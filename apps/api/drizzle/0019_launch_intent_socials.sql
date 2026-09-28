-- Launch socials (x / website / telegram) travel with the prepare intent so
-- `/launch/confirm` can write them onto `tokens`; before this the API had no
-- way to accept them and every app launch lost its links.
ALTER TABLE "launch_intents" ADD COLUMN IF NOT EXISTS "x_handle" text;
--> statement-breakpoint
ALTER TABLE "launch_intents" ADD COLUMN IF NOT EXISTS "website" text;
--> statement-breakpoint
ALTER TABLE "launch_intents" ADD COLUMN IF NOT EXISTS "telegram" text;
--> statement-breakpoint
-- Solana: the pinned Metaplex metadata JSON the on-chain `uri` points at;
-- `uri` keeps the display image.
ALTER TABLE "launch_intents" ADD COLUMN IF NOT EXISTS "metadata_uri" text;
--> statement-breakpoint
-- `/launch/confirm` looks a signature up to refuse replaying it onto a second intent.
CREATE INDEX IF NOT EXISTS "launch_intents_consumed_sig_idx" ON "launch_intents" ("net", "consumed_tx_sig") WHERE "consumed_tx_sig" IS NOT NULL;
