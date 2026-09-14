-- Referrals, social daily caps, wall likes.

CREATE TABLE IF NOT EXISTS referral_codes (
  net text NOT NULL,
  wallet text NOT NULL,
  code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (net, wallet),
  CONSTRAINT referral_codes_code_uq UNIQUE (net, code)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS referrals (
  net text NOT NULL,
  referee text NOT NULL,
  referrer text NOT NULL,
  code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (net, referee),
  CONSTRAINT referrals_no_self CHECK (referee <> referrer)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS referrals_referrer_idx ON referrals (net, referrer);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS referral_fee_balances (
  net text NOT NULL,
  wallet text NOT NULL,
  pending_native double precision NOT NULL DEFAULT 0,
  lifetime_native double precision NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (net, wallet),
  CONSTRAINT referral_fee_balances_pending_nonneg CHECK (pending_native >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS referral_fee_events (
  id bigserial PRIMARY KEY,
  net text NOT NULL,
  earner text NOT NULL,
  source_trader text NOT NULL,
  tier integer NOT NULL,
  tx_sig text NOT NULL,
  fee_amount double precision NOT NULL,
  payout_native double precision NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT referral_fee_events_tier_chk CHECK (tier BETWEEN 1 AND 3)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS referral_fee_events_uq
  ON referral_fee_events (net, earner, tx_sig, tier);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS social_daily (
  net text NOT NULL,
  wallet text NOT NULL,
  day_utc date NOT NULL,
  comments integer NOT NULL DEFAULT 0,
  likes integer NOT NULL DEFAULT 0,
  checkin_claimed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (net, wallet, day_utc)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS wall_likes (
  net text NOT NULL,
  post_id bigint NOT NULL,
  wallet text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (net, post_id, wallet)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS wall_likes_wallet_idx ON wall_likes (net, wallet);
