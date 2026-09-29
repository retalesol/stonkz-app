import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import type { Net } from '@stonkz/shared';
import type { AppEnv } from '../app/context.js';
import type { Db } from '../db/client.js';
import { tokenModeration, tokens, userModeration } from '../db/schema.js';
import type { RedisLike } from '../redis/types.js';

/**
 * Where admin moderation state meets the public API.
 *
 * `user_moderation` rows are read through a tiny per-process cache (5 s, plus
 * an `admin:moderation` pub/sub invalidation) so the launch/trade/chat gates
 * cost nothing on the hot path. Everything here fails *open* on a database
 * error: a moderation outage must never take trading down with it.
 */
export type BanKind = 'chat' | 'comments' | 'launch' | 'trade';
export type FeatureKind = 'launch' | 'trading' | 'chat';

export const MODERATION_CHANNEL = 'admin:moderation';

export interface ModerationState {
  chatBanned: boolean;
  commentsBanned: boolean;
  launchBanned: boolean;
  tradeBanned: boolean;
  shadowMuted: boolean;
  reason: string | null;
  until: number | null;
}

const NONE: ModerationState = {
  chatBanned: false,
  commentsBanned: false,
  launchBanned: false,
  tradeBanned: false,
  shadowMuted: false,
  reason: null,
  until: null,
};

export interface ModerationGateOptions {
  db: Db;
  redis: RedisLike;
  now?: () => number;
  ttlMs?: number;
  onError?: (err: unknown) => void;
}

export class ModerationGate {
  private readonly cache = new Map<string, { at: number; state: ModerationState }>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(private readonly opts: ModerationGateOptions) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? 5_000;
  }

  async start(): Promise<void> {
    try {
      await this.opts.redis.subscribe(MODERATION_CHANNEL, (message) => {
        if (message === '*') this.cache.clear();
        else this.cache.delete(message);
      });
    } catch (err) {
      this.opts.onError?.(err);
    }
  }

  /** Call after any write so every instance drops the stale entry. */
  async invalidate(net: Net, wallet: string): Promise<void> {
    const key = `${net}:${wallet}`;
    this.cache.delete(key);
    try {
      await this.opts.redis.publish(MODERATION_CHANNEL, key);
    } catch (err) {
      this.opts.onError?.(err);
    }
  }

  async state(net: Net, wallet: string): Promise<ModerationState> {
    const key = `${net}:${wallet}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return this.applyExpiry(hit.state);
    try {
      const [row] = await this.opts.db
        .select()
        .from(userModeration)
        .where(and(eq(userModeration.net, net), eq(userModeration.wallet, wallet)))
        .limit(1);
      const state: ModerationState = row
        ? {
            chatBanned: row.chatBanned,
            commentsBanned: row.commentsBanned,
            launchBanned: row.launchBanned,
            tradeBanned: row.tradeBanned,
            shadowMuted: row.shadowMuted,
            reason: row.reason,
            until: row.until?.getTime() ?? null,
          }
        : NONE;
      this.cache.set(key, { at: this.now(), state });
      return this.applyExpiry(state);
    } catch (err) {
      this.opts.onError?.(err);
      return NONE;
    }
  }

  /** A ban with an `until` in the past is no ban. */
  private applyExpiry(state: ModerationState): ModerationState {
    if (state.until !== null && state.until <= this.now()) return { ...NONE, until: state.until };
    return state;
  }

  async isBanned(net: Net, wallet: string, kind: BanKind): Promise<boolean> {
    const s = await this.state(net, wallet);
    switch (kind) {
      case 'chat':
        return s.chatBanned;
      case 'comments':
        return s.commentsBanned;
      case 'launch':
        return s.launchBanned;
      case 'trade':
        return s.tradeBanned;
    }
  }
}

/**
 * Route middleware: refuses a banned wallet (`403 banned`) and/or a disabled
 * feature (`503 feature_disabled`). Runs after `requireAuth`, so the
 * caller's `(net, wallet)` is known; on a public route it is a no-op.
 */
export function gate(opts: { feature?: FeatureKind; ban?: BanKind }): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const deps = c.get('deps');
    const user = c.get('user');
    const net: Net | undefined = user?.net;
    if (opts.feature && net) {
      const settings = deps.admin.settings;
      const enabled =
        opts.feature === 'launch'
          ? settings.launchEnabled(net)
          : opts.feature === 'trading'
            ? settings.tradingEnabled(net)
            : settings.chatEnabled();
      if (!enabled) {
        return c.json(
          {
            error: 'feature_disabled',
            detail: `${opts.feature} is temporarily disabled on ${net}`,
          },
          503,
        );
      }
    }
    if (opts.ban && user) {
      const state = await deps.admin.gate.state(user.net, user.wallet);
      const banned =
        (opts.ban === 'chat' && state.chatBanned) ||
        (opts.ban === 'comments' && state.commentsBanned) ||
        (opts.ban === 'launch' && state.launchBanned) ||
        (opts.ban === 'trade' && state.tradeBanned);
      if (banned) {
        return c.json(
          {
            error: 'banned',
            detail:
              `this wallet is restricted from ${opts.ban}` +
              (state.reason ? `: ${state.reason}` : ''),
            ...(state.until ? { until: state.until } : {}),
          },
          403,
        );
      }
    }
    await next();
    return undefined;
  };
}

/** `WHERE` fragment for the public token list: drop anything an admin hid from the board. */
export function notHiddenFilter(): SQL {
  return sql`not exists (select 1 from ${tokenModeration} tm where tm.net = ${tokens.net} and tm.mint = ${tokens.mint} and tm.hidden)`;
}

/** Nets → mint with an active KOTH override, for `GET /koth`. */
export async function kothOverrides(db: Db, net: Net | null): Promise<Map<Net, string>> {
  const rows = await db
    .select({ net: tokenModeration.net, mint: tokenModeration.mint })
    .from(tokenModeration)
    .where(
      net
        ? and(eq(tokenModeration.kothOverride, true), eq(tokenModeration.net, net))
        : eq(tokenModeration.kothOverride, true),
    )
    .catch(() => []);
  return new Map(rows.map((r) => [r.net as Net, r.mint]));
}
