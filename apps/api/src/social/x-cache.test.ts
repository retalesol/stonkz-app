import { describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../test/harness.js';
import { XProfileCacheService } from './x-cache.js';
import { PlaceholderXProvider, type XProfile, type XProvider } from './x-provider.js';

class CountingProvider implements XProvider {
  readonly source = 'x_api' as const;
  calls = 0;
  constructor(private readonly profile: XProfile) {}
  async fetchProfile(): Promise<XProfile> {
    this.calls++;
    return this.profile;
  }
}

describe('XProfileCacheService', () => {
  it('placeholder provider never invents a found profile', async () => {
    const provider = new PlaceholderXProvider();
    const a = await provider.fetchProfile('@degen');
    expect(a.found).toBe(false);
    expect(a.status).toBe('unavailable');
    expect(a.reason).toMatch(/not configured/i);
  });

  it('only calls the provider once within the TTL', async () => {
    let db: TestDb | null = null;
    try {
      db = await createTestDb();
      const provider = new CountingProvider({
        handle: 'degen',
        displayName: 'Degen',
        avatarUrl: null,
        verified: false,
        found: true,
        status: 'ok',
      });
      let now = 1_000_000;
      const cache = new XProfileCacheService({ db: db.db, provider, ttlSeconds: 3600, now: () => now });

      await cache.get('@degen');
      await cache.get('degen'); // same handle, different casing/@ — still one cache row
      expect(provider.calls).toBe(1);

      now += 3601 * 1000;
      await cache.get('degen');
      expect(provider.calls).toBe(2);
    } finally {
      await db?.close();
    }
  });
});
