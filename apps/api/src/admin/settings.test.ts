import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readEnv } from '../env.js';
import { MemoryRedis } from '../redis/memory.js';
import { createTestDb, type TestDb } from '../test/harness.js';
import {
  PlatformSettings,
  SETTING_DEFS,
  SettingsError,
  coerceSetting,
  settingDef,
} from './settings.js';

let h: TestDb;
let clock = Date.parse('2026-09-06T12:00:00Z');
const now = (): number => clock;
const env = readEnv({
  NODE_ENV: 'test',
  JWT_SECRET: 'test-secret-that-is-at-least-32-chars-long',
  LAUNCH_RATE_LIMIT_PER_WALLET: '7',
  LAUNCH_RATE_LIMIT_WINDOW_SECONDS: '600',
});

beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.reset();
});

describe('PlatformSettings', () => {
  it('falls back to env when no row exists, and DB wins once one does', async () => {
    const redis = new MemoryRedis(now);
    const s = new PlatformSettings({ db: h.db, redis, env, now });
    await s.start();
    expect(s.launchRateLimit()).toEqual({
      launchRateLimitPerWallet: 7,
      launchRateLimitWindowSeconds: 600,
    });
    expect(s.launchEnabled('RH')).toBe(true);

    const r = await s.set('limits.launch.perWallet', 3, 'owner-1');
    expect(r).toEqual({ before: 7, after: 3 });
    expect(s.launchRateLimit().launchRateLimitPerWallet).toBe(3);
    await s.set('features.launch.RH', false, 'owner-1');
    expect(s.launchEnabled('RH')).toBe(false);
    expect(s.launchEnabled('SOL')).toBe(true);

    const view = s.all().find((v) => v.key === 'limits.launch.perWallet');
    expect(view).toMatchObject({
      value: 3,
      fallback: 7,
      overridden: true,
      updatedBy: 'owner-1',
      wired: true,
    });

    await s.reset('limits.launch.perWallet');
    expect(s.launchRateLimit().launchRateLimitPerWallet).toBe(7);
    await s.stop();
  });

  it('hot-reloads other instances through the Redis channel', async () => {
    const redis = new MemoryRedis(now);
    const a = new PlatformSettings({ db: h.db, redis, env, now });
    const b = new PlatformSettings({ db: h.db, redis, env, now });
    await a.start();
    await b.start();
    expect(b.banner().text).toBe('');
    await a.set('banner.text', 'MAINTENANCE 22:00 UTC', 'owner-1');
    // MemoryRedis delivers synchronously; `load()` is async, so yield once.
    await new Promise((r) => setTimeout(r, 0));
    await b.load();
    expect(b.banner().text).toBe('MAINTENANCE 22:00 UTC');
    await a.stop();
    await b.stop();
  });

  it('validates types and bounds', () => {
    const perWallet = settingDef('limits.launch.perWallet')!;
    expect(coerceSetting(perWallet, 0)).toEqual({ ok: false, error: 'must be >= 1' });
    expect(coerceSetting(perWallet, 'abc').ok).toBe(false);
    expect(coerceSetting(perWallet, '12')).toEqual({ ok: true, value: 12 });
    const words = settingDef('moderation.words')!;
    expect(coerceSetting(words, 'Rug, PULL,rug\n')).toEqual({ ok: true, value: ['rug', 'pull'] });
    const flag = settingDef('features.chat')!;
    expect(coerceSetting(flag, 'yes').ok).toBe(false);
    expect(coerceSetting(flag, 'false')).toEqual({ ok: true, value: false });
  });

  it('refuses unknown keys and bad values with a typed error', async () => {
    const s = new PlatformSettings({ db: h.db, redis: new MemoryRedis(now), env, now });
    await s.load();
    await expect(s.set('nope', 1, 'x')).rejects.toBeInstanceOf(SettingsError);
    await expect(s.set('limits.chat.limit', -1, 'x')).rejects.toMatchObject({
      code: 'invalid_value',
    });
    expect(() => s.get('nope')).toThrow();
  });

  it('every definition has a unique key and a fallback that satisfies its own type', () => {
    const keys = new Set<string>();
    for (const def of SETTING_DEFS) {
      expect(keys.has(def.key)).toBe(false);
      keys.add(def.key);
      const fb = def.fallback(env);
      if (def.type === 'json' || fb === null) continue;
      expect(coerceSetting(def, fb).ok, def.key).toBe(true);
    }
  });

  it('survives a missing table (pre-migration boot) by serving env defaults', async () => {
    const broken = {
      select: () => ({ from: () => Promise.reject(new Error('relation missing')) }),
    } as never;
    const errors: unknown[] = [];
    const s = new PlatformSettings({
      db: broken,
      redis: new MemoryRedis(now),
      env,
      now,
      onError: (e) => errors.push(e),
    });
    await s.start();
    expect(s.chatEnabled()).toBe(true);
    expect(errors).toHaveLength(1);
  });

  it('re-reads after the staleness bound even without a pub/sub message', async () => {
    const redis = new MemoryRedis(now);
    const s = new PlatformSettings({ db: h.db, redis, env, now, staleMs: 1000 });
    await s.start();
    const other = new PlatformSettings({ db: h.db, redis: new MemoryRedis(now), env, now });
    await other.load();
    await other.set('features.chat', false, 'x');
    expect(s.chatEnabled()).toBe(true);
    clock += 1500;
    s.chatEnabled(); // triggers the background refresh
    await new Promise((r) => setTimeout(r, 0));
    await s.load();
    expect(s.chatEnabled()).toBe(false);
    await s.stop();
  });
});
