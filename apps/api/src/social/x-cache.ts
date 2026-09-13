import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { xProfileCache } from '../db/schema.js';
import type { XProfile, XProvider } from './x-provider.js';

/**
 * The cache in front of `XProvider` — plan step 153's "server X API v2 cache
 * ... to avoid hitting rate limits on every profile view". `x_profile_cache`
 * is keyed by lower-cased handle; a row past `expiresAt` is treated as a
 * cache miss and refetched, same as a row that never existed.
 *
 * Misses from an unconfigured provider (`source: 'none'`) are **not** cached,
 * so flipping on `X_BEARER_TOKEN` starts working without waiting out the TTL.
 */
export interface XProfileCacheOptions {
  db: Db;
  provider: XProvider;
  ttlSeconds: number;
  now?: () => number;
}

export interface CachedXProfile extends XProfile {
  cachedAt: number;
  source: XProvider['source'];
}

export class XProfileCacheService {
  private readonly now: () => number;

  constructor(private readonly opts: XProfileCacheOptions) {
    this.now = opts.now ?? Date.now;
  }

  async get(rawHandle: string): Promise<CachedXProfile> {
    const handle = rawHandle.replace(/^@/, '').trim().toLowerCase();
    const nowMs = this.now();
    const source = this.opts.provider.source;

    // No real X credentials — never serve a fabricated or stale "found" row.
    if (source === 'none') {
      const fresh = await this.opts.provider.fetchProfile(handle);
      return { ...fresh, handle, cachedAt: nowMs, source };
    }

    const [row] = await this.opts.db
      .select()
      .from(xProfileCache)
      .where(eq(xProfileCache.handle, handle))
      .limit(1);

    if (row && row.expiresAt.getTime() > nowMs) {
      return {
        handle,
        displayName: row.displayName,
        avatarUrl: row.avatarUrl,
        verified: row.verified,
        found: row.found,
        status: row.found ? 'ok' : 'not_found',
        ...(row.found ? {} : { reason: "Username doesn't exist" as const }),
        cachedAt: row.fetchedAt.getTime(),
        source,
      };
    }

    const fresh = await this.opts.provider.fetchProfile(handle);
    const expiresAt = new Date(nowMs + this.opts.ttlSeconds * 1000);

    await this.opts.db
      .insert(xProfileCache)
      .values({
        handle,
        displayName: fresh.displayName,
        avatarUrl: fresh.avatarUrl,
        verified: fresh.verified,
        found: fresh.found,
        fetchedAt: new Date(nowMs),
        expiresAt,
      })
      .onConflictDoUpdate({
        target: xProfileCache.handle,
        set: {
          displayName: fresh.displayName,
          avatarUrl: fresh.avatarUrl,
          verified: fresh.verified,
          found: fresh.found,
          fetchedAt: new Date(nowMs),
          expiresAt,
        },
      });

    return { ...fresh, handle, cachedAt: nowMs, source };
  }
}
