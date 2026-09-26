import { fanout, type HandlerErrorSink } from './fanout.js';
import type { RedisHandler, RedisLike, RedisUnsubscribe, SetOptions } from './types.js';

interface Entry {
  value: string;
  /** Epoch ms, or null for no expiry. */
  expiresAt: number | null;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/**
 * A complete in-process implementation of `RedisLike`.
 *
 * This is what `REDIS_URL=memory://` (and the whole test suite) runs on. It is
 * single-node, so pub/sub only reaches subscribers in the same process — fine
 * for tests and single-instance local dev, wrong for a scaled deployment,
 * which is what `redis://` is for.
 *
 * `now` is injectable so TTL behaviour can be tested without sleeping.
 */
export class MemoryRedis implements RedisLike {
  private readonly store = new Map<string, Entry>();
  private readonly channels = new Map<string, Set<RedisHandler>>();
  private readonly patterns = new Map<string, Set<RedisHandler>>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly onHandlerError?: HandlerErrorSink,
  ) {}

  private live(key: string): Entry | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, opts: SetOptions = {}): Promise<boolean> {
    if (opts.ifNotExists && this.live(key)) return false;
    this.store.set(key, {
      value,
      expiresAt: opts.ttlSeconds === undefined ? null : this.now() + opts.ttlSeconds * 1000,
    });
    return true;
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const key of keys) if (this.store.delete(key)) n++;
    return n;
  }

  async exists(key: string): Promise<boolean> {
    return this.live(key) !== null;
  }

  async incrWithTtl(key: string, ttlSeconds: number): Promise<number> {
    const entry = this.live(key);
    const next = entry ? Number.parseInt(entry.value, 10) + 1 : 1;
    this.store.set(key, {
      value: String(next),
      expiresAt: entry ? entry.expiresAt : this.now() + ttlSeconds * 1000,
    });
    return next;
  }

  async ttl(key: string): Promise<number> {
    const entry = this.live(key);
    if (!entry) return -2;
    if (entry.expiresAt === null) return -1;
    return Math.ceil((entry.expiresAt - this.now()) / 1000);
  }

  async keys(pattern: string): Promise<string[]> {
    const re = globToRegExp(pattern);
    return [...this.store.keys()].filter((k) => re.test(k) && this.live(k) !== null);
  }

  async publish(channel: string, message: string): Promise<number> {
    let n = fanout(this.channels.get(channel) ?? [], message, channel, this.onHandlerError);
    for (const [pattern, handlers] of this.patterns) {
      if (!globToRegExp(pattern).test(channel)) continue;
      n += fanout(handlers, message, channel, this.onHandlerError);
    }
    return n;
  }

  async subscribe(channel: string, handler: RedisHandler): Promise<RedisUnsubscribe> {
    return this.attach(this.channels, channel, handler);
  }

  async psubscribe(pattern: string, handler: RedisHandler): Promise<RedisUnsubscribe> {
    return this.attach(this.patterns, pattern, handler);
  }

  private attach(
    map: Map<string, Set<RedisHandler>>,
    key: string,
    handler: RedisHandler,
  ): RedisUnsubscribe {
    let set = map.get(key);
    if (!set) {
      set = new Set();
      map.set(key, set);
    }
    set.add(handler);
    return async () => {
      const current = map.get(key);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) map.delete(key);
    };
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    this.store.clear();
    this.channels.clear();
    this.patterns.clear();
  }
}
