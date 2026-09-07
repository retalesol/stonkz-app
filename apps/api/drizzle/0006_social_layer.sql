ALTER TABLE "users" ADD COLUMN "avatar_url" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "x_handle" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "website" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "telegram" text;
--> statement-breakpoint
CREATE TABLE "follows" (
	"net" text NOT NULL,
	"follower" text NOT NULL,
	"followee" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follows_net_follower_followee_pk" PRIMARY KEY("net","follower","followee")
);
--> statement-breakpoint
CREATE INDEX "follows_followee_idx" ON "follows" USING btree ("net","followee");
--> statement-breakpoint
CREATE TABLE "wall_posts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"net" text NOT NULL,
	"to_wallet" text NOT NULL,
	"from_wallet" text NOT NULL,
	"text" text NOT NULL,
	"tip_native" double precision NOT NULL,
	"tip_tx_sig" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "wall_posts_sig_uq" ON "wall_posts" USING btree ("net","tip_tx_sig");
--> statement-breakpoint
CREATE INDEX "wall_posts_to_idx" ON "wall_posts" USING btree ("net","to_wallet","id");
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"net" text NOT NULL,
	"room" text NOT NULL,
	"wallet" text NOT NULL,
	"text" text NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "chat_messages_room_idx" ON "chat_messages" USING btree ("net","room","id");
--> statement-breakpoint
CREATE TABLE "x_profile_cache" (
	"handle" text PRIMARY KEY NOT NULL,
	"display_name" text,
	"avatar_url" text,
	"verified" boolean DEFAULT false NOT NULL,
	"found" boolean DEFAULT true NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
