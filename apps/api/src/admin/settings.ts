import { eq } from 'drizzle-orm';
import { ALL_NETS, type Net } from '@stonkz/shared';
import type { Db } from '../db/client.js';
import { platformSettings } from '../db/schema.js';
import type { ApiEnv } from '../env.js';
import type { RateLimitRule } from '../redis/ratelimit.js';
import type { RedisLike } from '../redis/types.js';

/**
 * DB-backed platform settings with env as the fallback.
 *
 * Precedence is always **DB row > env/default**. Reads are synchronous off an
 * in-process cache so hot paths (chat moderation, launch gates) never wait on
 * Postgres; writes go to `platform_settings`, then publish on
 * `admin:settings` so every API instance drops its cache at once. A 15-second
 * staleness bound re-reads the table even if a pub/sub message is lost.
 *
 * `wired` is documentation as much as code: it says whether anything in the
 * API actually reads the key (through `deps.admin.settings`) or whether it is
 * stored for a future read site. The panel shows the same flag.
 */
export type SettingType = 'boolean' | 'number' | 'string' | 'string[]' | 'json';

export interface SettingDef {
  key: string;
  group: string;
  label: string;
  type: SettingType;
  /** Env / constant fallback when no row exists. */
  fallback: (env: ApiEnv) => unknown;
  /** True when a read site in the API consults this key. */
  wired: boolean;
  /** Numeric bounds, when `type` is `number`. */
  min?: number;
  max?: number;
}

export const SETTINGS_CHANNEL = 'admin:settings';

function perNet(
  prefix: string,
  group: string,
  label: (net: Net) => string,
  type: SettingType,
  fallback: (env: ApiEnv, net: Net) => unknown,
  wired: boolean,
): SettingDef[] {
  return ALL_NETS.map((net) => ({
    key: `${prefix}.${net}`,
    group,
    label: label(net),
    type,
    fallback: (env) => fallback(env, net),
    wired,
  }));
}

export const SETTING_DEFS: readonly SettingDef[] = [
  /* ------------------------------------------------------- feature flags */
  ...perNet(
    'features.launch',
    'features',
    (n) => `Launches enabled · ${n}`,
    'boolean',
    () => true,
    true,
  ),
  ...perNet(
    'features.trading',
    'features',
    (n) => `Trading enabled · ${n}`,
    'boolean',
    () => true,
    true,
  ),
  {
    key: 'features.chat',
    group: 'features',
    label: 'Chat enabled',
    type: 'boolean',
    fallback: () => true,
    wired: true,
  },
  {
    key: 'features.crates',
    group: 'features',
    label: 'Crates enabled',
    type: 'boolean',
    fallback: () => true,
    wired: false,
  },
  {
    key: 'features.referrals',
    group: 'features',
    label: 'Referrals enabled',
    type: 'boolean',
    fallback: () => true,
    wired: false,
  },
  {
    key: 'banner.text',
    group: 'features',
    label: 'Maintenance banner text',
    type: 'string',
    fallback: () => '',
    wired: true,
  },
  {
    key: 'banner.severity',
    group: 'features',
    label: 'Banner severity (info | warn | critical)',
    type: 'string',
    fallback: () => 'info',
    wired: true,
  },

  /* ---------------------------------------------------------- rate limits */
  {
    key: 'limits.launch.perWallet',
    group: 'limits',
    label: 'Launches per wallet per window',
    type: 'number',
    fallback: (e) => e.launchRateLimitPerWallet,
    wired: true,
    min: 1,
    max: 10_000,
  },
  {
    key: 'limits.launch.windowSeconds',
    group: 'limits',
    label: 'Launch window (seconds)',
    type: 'number',
    fallback: (e) => e.launchRateLimitWindowSeconds,
    wired: true,
    min: 1,
    max: 86_400 * 7,
  },
  {
    key: 'limits.launch.perIp',
    group: 'limits',
    label: 'Launch prepares per IP per hour',
    type: 'number',
    fallback: () => 30,
    wired: false,
    min: 1,
    max: 100_000,
  },
  {
    key: 'limits.chat.limit',
    group: 'limits',
    label: 'Chat messages per window',
    type: 'number',
    fallback: () => 20,
    wired: true,
    min: 1,
    max: 10_000,
  },
  {
    key: 'limits.chat.windowSeconds',
    group: 'limits',
    label: 'Chat window (seconds)',
    type: 'number',
    fallback: () => 30,
    wired: true,
    min: 1,
    max: 86_400,
  },
  {
    key: 'limits.uploads.perHour',
    group: 'limits',
    label: 'Avatar uploads per hour',
    type: 'number',
    fallback: () => 10,
    wired: false,
    min: 1,
    max: 10_000,
  },

  /* ----------------------------------------------------------- moderation */
  {
    key: 'moderation.words',
    group: 'moderation',
    label: 'Extra blocked terms (chat + launches)',
    type: 'string[]',
    fallback: () => [],
    wired: true,
  },

  /* ---------------------------------------------------------- base mints */
  ...perNet(
    'baseMints.overrides',
    'launch',
    (n) => `Base-mint allowlist overrides · ${n}`,
    'json',
    () => ({}),
    false,
  ),

  /* ------------------------------------------------------ game tables */
  {
    key: 'crates.rwaCatalog',
    group: 'game',
    label: 'RWA catalog override',
    type: 'json',
    fallback: () => null,
    wired: false,
  },
  {
    key: 'crates.dropTables',
    group: 'game',
    label: 'Crate drop tables override',
    type: 'json',
    fallback: () => null,
    wired: false,
  },
  {
    key: 'sp.levels',
    group: 'game',
    label: 'SP level table override',
    type: 'json',
    fallback: () => null,
    wired: false,
  },
  {
    key: 'referrals.tiers',
    group: 'game',
    label: 'Referral tiers override',
    type: 'json',
    fallback: () => null,
    wired: false,
  },
  ...perNet(
    'thresholds.dust',
    'game',
    (n) => `Dust threshold · ${n}`,
    'number',
    (e, n) => e.dust[n],
    false,
  ),
  ...perNet(
    'thresholds.whale',
    'game',
    (n) => `Whale cut · ${n}`,
    'number',
    (e, n) => e.whaleCut[n],
    false,
  ),

  /* ---------------------------------------------------------- oracles */
  {
    key: 'oracle.priceDivergenceBps',
    group: 'oracle',
    label: 'Stock price max divergence (bps)',
    type: 'number',
    fallback: (e) => e.stockPriceMaxDivergenceBps,
    wired: false,
    min: 0,
    max: 10_000,
  },
  {
    key: 'oracle.hermesEnabled',
    group: 'oracle',
    label: 'Pyth Hermes enabled',
    type: 'boolean',
    fallback: () => true,
    wired: false,
  },
  {
    key: 'oracle.defillamaEnabled',
    group: 'oracle',
    label: 'DefiLlama enabled',
    type: 'boolean',
    fallback: () => true,
    wired: false,
  },
];

const DEF_BY_KEY = new Map(SETTING_DEFS.map((d) => [d.key, d]));

export function settingDef(key: string): SettingDef | undefined {
  return DEF_BY_KEY.get(key);
}

/** Type-checks a candidate value for `def`; returns the normalised value or an error string. */
export function coerceSetting(
  def: SettingDef,
  raw: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  switch (def.type) {
    case 'boolean':
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      if (raw === 'true' || raw === 'false') return { ok: true, value: raw === 'true' };
      return { ok: false, error: 'expected a boolean' };
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n)) return { ok: false, error: 'expected a number' };
      if (def.min !== undefined && n < def.min)
        return { ok: false, error: `must be >= ${def.min}` };
      if (def.max !== undefined && n > def.max)
        return { ok: false, error: `must be <= ${def.max}` };
      return { ok: true, value: n };
    }
    case 'string':
      if (typeof raw !== 'string') return { ok: false, error: 'expected a string' };
      if (raw.length > 2000) return { ok: false, error: 'too long (max 2000)' };
      return { ok: true, value: raw };
    case 'string[]': {
      const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\n,]/) : null;
      if (!list) return { ok: false, error: 'expected a list of strings' };
      const out = list
        .map((s) => String(s).trim().toLowerCase())
        .filter((s) => s.length > 0 && s.length <= 64);
      if (out.length > 2000) return { ok: false, error: 'too many entries (max 2000)' };
      return { ok: true, value: [...new Set(out)] };
    }
    case 'json': {
      if (raw === undefined) return { ok: false, error: 'expected JSON' };
      const text = JSON.stringify(raw);
      if (text.length > 200_000) return { ok: false, error: 'too large (max 200 KB)' };
      return { ok: true, value: raw };
    }
  }
}

export interface SettingView {
  key: string;
  group: string;
  label: string;
  type: SettingType;
  wired: boolean;
  value: unknown;
  fallback: unknown;
  /** True when a DB row overrides the fallback. */
  overridden: boolean;
  updatedBy: string | null;
  updatedAt: number | null;
}

interface CachedRow {
  value: unknown;
  updatedBy: string;
  updatedAt: number;
}

export interface PlatformSettingsOptions {
  db: Db;
  redis: RedisLike;
  env: ApiEnv;
  now?: () => number;
  /** How old the cache may be before a read triggers a background refresh. */
  staleMs?: number;
  onError?: (err: unknown) => void;
}

export class PlatformSettings {
  private rows = new Map<string, CachedRow>();
  private loadedAt = 0;
  private loading: Promise<void> | null = null;
  private readonly now: () => number;
  private readonly staleMs: number;
  private unsubscribe: (() => Promise<void>) | null = null;

  constructor(private readonly opts: PlatformSettingsOptions) {
    this.now = opts.now ?? Date.now;
    this.staleMs = opts.staleMs ?? 15_000;
  }

  /** Reads the table once and subscribes to invalidations. Safe to call when the table is missing. */
  async start(): Promise<void> {
    await this.load();
    try {
      this.unsubscribe = await this.opts.redis.subscribe(SETTINGS_CHANNEL, () => {
        this.loadedAt = 0;
        void this.load();
      });
    } catch (err) {
      this.opts.onError?.(err);
    }
  }

  async stop(): Promise<void> {
    await this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const rows = await this.opts.db.select().from(platformSettings);
        const next = new Map<string, CachedRow>();
        for (const r of rows) {
          next.set(r.key, {
            value: r.value,
            updatedBy: r.updatedBy,
            updatedAt: r.updatedAt.getTime(),
          });
        }
        this.rows = next;
        this.loadedAt = this.now();
      } catch (err) {
        // A missing table (pre-migration boot) means env defaults, not a crash.
        this.opts.onError?.(err);
        this.loadedAt = this.now();
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  private maybeRefresh(): void {
    if (this.now() - this.loadedAt > this.staleMs) void this.load();
  }

  /** DB row if present, else the env/constant fallback. Synchronous. */
  get<T = unknown>(key: string): T {
    this.maybeRefresh();
    const def = DEF_BY_KEY.get(key);
    const row = this.rows.get(key);
    if (row) return row.value as T;
    if (!def) throw new Error(`unknown setting ${key}`);
    return def.fallback(this.opts.env) as T;
  }

  all(): SettingView[] {
    this.maybeRefresh();
    return SETTING_DEFS.map((def) => {
      const row = this.rows.get(def.key);
      const fallback = def.fallback(this.opts.env);
      return {
        key: def.key,
        group: def.group,
        label: def.label,
        type: def.type,
        wired: def.wired,
        value: row ? row.value : fallback,
        fallback,
        overridden: !!row,
        updatedBy: row?.updatedBy ?? null,
        updatedAt: row?.updatedAt ?? null,
      };
    });
  }

  /** Validates, persists and broadcasts. Returns `{before, after}` for the audit row. */
  async set(key: string, raw: unknown, by: string): Promise<{ before: unknown; after: unknown }> {
    const def = DEF_BY_KEY.get(key);
    if (!def) throw new SettingsError('unknown_setting', `unknown setting ${key}`);
    const coerced = coerceSetting(def, raw);
    if (!coerced.ok) throw new SettingsError('invalid_value', coerced.error);
    const before = this.get(key);
    const at = new Date(this.now());
    await this.opts.db
      .insert(platformSettings)
      .values({ key, value: coerced.value, updatedBy: by, updatedAt: at })
      .onConflictDoUpdate({
        target: platformSettings.key,
        set: { value: coerced.value, updatedBy: by, updatedAt: at },
      });
    this.rows.set(key, { value: coerced.value, updatedBy: by, updatedAt: at.getTime() });
    await this.broadcast();
    return { before, after: coerced.value };
  }

  /** Drops the DB override so the env/constant fallback applies again. */
  async reset(key: string): Promise<{ before: unknown; after: unknown }> {
    const def = DEF_BY_KEY.get(key);
    if (!def) throw new SettingsError('unknown_setting', `unknown setting ${key}`);
    const before = this.get(key);
    await this.opts.db.delete(platformSettings).where(eq(platformSettings.key, key));
    this.rows.delete(key);
    await this.broadcast();
    return { before, after: this.get(key) };
  }

  private async broadcast(): Promise<void> {
    try {
      await this.opts.redis.publish(SETTINGS_CHANNEL, String(this.now()));
    } catch (err) {
      this.opts.onError?.(err);
    }
  }

  /* ------------------------------------------------ typed convenience reads */

  launchEnabled(net: Net): boolean {
    return this.get<boolean>(`features.launch.${net}`) !== false;
  }

  tradingEnabled(net: Net): boolean {
    return this.get<boolean>(`features.trading.${net}`) !== false;
  }

  chatEnabled(): boolean {
    return this.get<boolean>('features.chat') !== false;
  }

  banner(): { text: string; severity: string } {
    return {
      text: String(this.get<string>('banner.text') ?? ''),
      severity: String(this.get<string>('banner.severity') ?? 'info'),
    };
  }

  moderationWords(): readonly string[] {
    const v = this.get<unknown>('moderation.words');
    return Array.isArray(v) ? v.map(String) : [];
  }

  /** The shape `routes/launch.ts`'s `walletLaunchRule()` takes. */
  launchRateLimit(): { launchRateLimitPerWallet: number; launchRateLimitWindowSeconds: number } {
    return {
      launchRateLimitPerWallet: Number(this.get('limits.launch.perWallet')),
      launchRateLimitWindowSeconds: Number(this.get('limits.launch.windowSeconds')),
    };
  }

  chatRateLimit(): RateLimitRule {
    return {
      bucket: 'chat',
      limit: Number(this.get('limits.chat.limit')),
      windowSeconds: Number(this.get('limits.chat.windowSeconds')),
    };
  }
}

export class SettingsError extends Error {
  constructor(
    readonly code: 'unknown_setting' | 'invalid_value',
    message: string,
  ) {
    super(message);
    this.name = 'SettingsError';
  }
}
