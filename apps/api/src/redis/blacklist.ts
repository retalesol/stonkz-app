import type { RedisLike } from './types.js';

/**
 * Access tokens are short-lived, so revocation is a deny-list keyed by JWT id
 * that only has to outlive the token itself. Refresh tokens are revoked in
 * Postgres (`sessions.revoked_at`) because those must survive a Redis flush.
 */
export async function blacklistToken(
  redis: RedisLike,
  jti: string,
  ttlSeconds: number,
): Promise<void> {
  // A cleared Redis re-admits an already-expired token at worst.
  await redis.set(`bl:jti:${jti}`, '1', { ttlSeconds: Math.max(1, ttlSeconds) });
}

export async function isTokenBlacklisted(redis: RedisLike, jti: string): Promise<boolean> {
  return redis.exists(`bl:jti:${jti}`);
}

/** Used on logout-everywhere: every access token issued before `atSeconds` dies. */
export async function blacklistWalletBefore(
  redis: RedisLike,
  net: string,
  wallet: string,
  atSeconds: number,
  ttlSeconds: number,
): Promise<void> {
  await redis.set(`bl:wallet:${net}:${wallet}`, String(atSeconds), {
    ttlSeconds: Math.max(1, ttlSeconds),
  });
}

export async function walletBlacklistedBefore(
  redis: RedisLike,
  net: string,
  wallet: string,
): Promise<number | null> {
  const raw = await redis.get(`bl:wallet:${net}:${wallet}`);
  if (raw === null) return null;
  const at = Number.parseInt(raw, 10);
  return Number.isFinite(at) ? at : null;
}
