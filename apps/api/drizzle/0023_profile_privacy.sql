-- Profile privacy + wall moderation.
--
-- `users.private`: a private profile hides portfolio, PnL, recent actions,
-- wall and follow lists from everyone but the owner. Username, avatar, bio,
-- links and created tokens stay public (creator attribution is on chain).
-- Enforced in `routes/social.ts` on every profile endpoint, not just the UI.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "private" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- A wall post whose text trips the blocklist is persisted (the tip behind it
-- was real and already verified on chain) but never replayed to readers,
-- mirroring `chat_messages.flagged`.
ALTER TABLE "wall_posts" ADD COLUMN IF NOT EXISTS "flagged" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- Follow lists page newest-first by `created_at`; the PK only covers lookups
-- by follower, `follows_followee_idx` by followee — neither is ordered.
CREATE INDEX IF NOT EXISTS "follows_follower_time_idx" ON "follows" ("net", "follower", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "follows_followee_time_idx" ON "follows" ("net", "followee", "created_at");
