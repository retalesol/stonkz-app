-- Admin panel: DB-managed roles on top of ADMIN_WALLETS, TOTP enrolment, the
-- step-up challenge table, an append-only audit log, DB-backed platform
-- settings (env is the fallback), user/token moderation state, comms notices
-- and operator jobs. No chain key is ever stored here.
CREATE TABLE "admin_roles" (
  "wallet" text PRIMARY KEY,
  "role" text NOT NULL CHECK ("role" IN ('owner', 'admin', 'moderator', 'viewer')),
  "granted_by" text NOT NULL,
  "note" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "admin_totp" (
  "wallet" text PRIMARY KEY,
  "secret_enc" text NOT NULL,
  "enabled_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "admin_challenges" (
  "nonce" text PRIMARY KEY,
  "net" text NOT NULL,
  "wallet" text NOT NULL,
  "message" text NOT NULL,
  "issued_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz
);
--> statement-breakpoint
CREATE INDEX "admin_challenges_expires_idx" ON "admin_challenges" ("expires_at");
--> statement-breakpoint
CREATE TABLE "admin_audit_log" (
  "id" bigserial PRIMARY KEY,
  "at" timestamptz NOT NULL DEFAULT now(),
  "actor" text NOT NULL,
  "actor_net" text NOT NULL,
  "role" text NOT NULL,
  "action" text NOT NULL,
  "target" text,
  "before" jsonb,
  "after" jsonb,
  "ip" text,
  "request_id" text,
  "ok" boolean NOT NULL DEFAULT true
);
--> statement-breakpoint
CREATE INDEX "admin_audit_log_at_idx" ON "admin_audit_log" ("at");
--> statement-breakpoint
CREATE INDEX "admin_audit_log_actor_idx" ON "admin_audit_log" ("actor", "id");
--> statement-breakpoint
CREATE INDEX "admin_audit_log_action_idx" ON "admin_audit_log" ("action", "id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "admin_audit_log_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit_log is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "admin_audit_log_immutable"
  BEFORE UPDATE OR DELETE ON "admin_audit_log"
  FOR EACH ROW EXECUTE FUNCTION "admin_audit_log_append_only"();
--> statement-breakpoint
CREATE TABLE "platform_settings" (
  "key" text PRIMARY KEY,
  "value" jsonb NOT NULL,
  "updated_by" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "user_moderation" (
  "net" text NOT NULL,
  "wallet" text NOT NULL,
  "chat_banned" boolean NOT NULL DEFAULT false,
  "comments_banned" boolean NOT NULL DEFAULT false,
  "launch_banned" boolean NOT NULL DEFAULT false,
  "trade_banned" boolean NOT NULL DEFAULT false,
  "shadow_muted" boolean NOT NULL DEFAULT false,
  "reason" text,
  "until" timestamptz,
  "updated_by" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("net", "wallet")
);
--> statement-breakpoint
CREATE TABLE "token_moderation" (
  "net" text NOT NULL,
  "mint" text NOT NULL,
  "featured" boolean NOT NULL DEFAULT false,
  "koth_override" boolean NOT NULL DEFAULT false,
  "hidden" boolean NOT NULL DEFAULT false,
  "scam_warning" text,
  "reason" text,
  "updated_by" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("net", "mint")
);
--> statement-breakpoint
CREATE TABLE "admin_notices" (
  "id" bigserial PRIMARY KEY,
  "kind" text NOT NULL CHECK ("kind" IN ('banner', 'notice', 'maintenance')),
  "net" text,
  "text" text NOT NULL,
  "severity" text NOT NULL DEFAULT 'info',
  "starts_at" timestamptz,
  "ends_at" timestamptz,
  "active" boolean NOT NULL DEFAULT true,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "admin_notices_active_idx" ON "admin_notices" ("active", "kind");
--> statement-breakpoint
CREATE TABLE "admin_jobs" (
  "id" bigserial PRIMARY KEY,
  "kind" text NOT NULL,
  "net" text NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" text NOT NULL DEFAULT 'queued',
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "admin_jobs_status_idx" ON "admin_jobs" ("status", "id");
