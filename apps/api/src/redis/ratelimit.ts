import type { RedisLike } from './types.js';

export interface RateLimitRule {
  /** Bucket name, e.g. `auth`, `crate`, `launch`. */
  bucket: string;
  limit: number;
  windowSeconds: number;
}

export interface RateLimitVerdict {
  ok: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the window rolls. */
  resetSeconds: number;
}

/** Per-IP and per-wallet limits, per the plan's step 93. */
export const RATE_LIMITS = {
  /** Nonce + signature verification; brute-forcing a nonce is pointless but cheap to try. */
  auth: { bucket: 'auth', limit: 30, windowSeconds: 60 },
  /** Crate opens are cooldown-gated in Postgres; this only blunts hammering. */
  crate: { bucket: 'crate', limit: 20, windowSeconds: 60 },
  /** Quote requests refresh on an 8s bar, so ~8/min per token is generous. */
  quote: { bucket: 'quote', limit: 120, windowSeconds: 60 },
  read: { bucket: 'read', limit: 600, windowSeconds: 60 },
  /** `POST /trade/prepare` composes a real transaction; cheaper to allow than a quote, still capped against spam. */
  trade: { bucket: 'trade', limit: 60, windowSeconds: 60 },
  /**
   * Per-IP guard on `/launch/prepare`, ahead of the per-wallet limit `env`
   * configures (`LAUNCH_RATE_LIMIT_PER_WALLET`/`_WINDOW_SECONDS` —
   * `routes/launch.ts`). A flat IP ceiling generous enough that no legitimate
   * multi-wallet user (e.g. testing both nets) trips it, but that still bounds
   * a single source hammering distinct wallets to dodge the per-wallet cap.
   */
  launchIp: { bucket: 'launch_ip', limit: 30, windowSeconds: 3600 },
  fees: { bucket: 'fees', limit: 60, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitRule>;

/**
 * Fixed-window counter. Chosen over a sliding log because the failure mode of
 * a fixed window (a burst across a boundary) is acceptable here, and it costs
 * one round trip.
 */
export async function rateLimit(
  redis: RedisLike,
  rule: RateLimitRule,
  identity: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<RateLimitVerdict> {
  const window = Math.floor(nowSeconds / rule.windowSeconds);
  const key = `rl:${rule.bucket}:${identity}:${window}`;
  const count = await redis.incrWithTtl(key, rule.windowSeconds);
  const resetSeconds = (window + 1) * rule.windowSeconds - nowSeconds;
  return {
    ok: count <= rule.limit,
    limit: rule.limit,
    remaining: Math.max(0, rule.limit - count),
    resetSeconds,
  };
}
