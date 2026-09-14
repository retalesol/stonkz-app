-- SP-level crate inventory + global open cooldown.
-- Crates are granted when lifetime SP crosses SP_LEVELS thresholds.
-- Opening any crate locks ALL crates for that tier's cooldown hours.

CREATE TABLE IF NOT EXISTS crate_inventory (
  wallet text NOT NULL,
  net text NOT NULL,
  tier text NOT NULL,
  count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet, net, tier),
  CONSTRAINT crate_inventory_count_nonneg CHECK (count >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS crate_cooldown (
  wallet text NOT NULL,
  net text NOT NULL,
  ready_at timestamptz NOT NULL DEFAULT now(),
  last_tier text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet, net)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS sp_level_claims (
  wallet text NOT NULL,
  net text NOT NULL,
  level integer NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet, net, level)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS crate_inventory_wallet_idx ON crate_inventory (wallet, net);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sp_level_claims_wallet_idx ON sp_level_claims (wallet, net);
