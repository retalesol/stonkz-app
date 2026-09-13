import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryRedis } from './memory.js';
import { RATE_LIMITS, rateLimit, type RateLimitRule } from './ratelimit.js';
import {
  blacklistToken,
  blacklistWalletBefore,
  isTokenBlacklisted,
  walletBlacklistedBefore,
} from './blacklist.js';
import { QUOTE_CACHE_TTL_SECONDS, QuoteCache, quantiseNativeAmount, quoteCacheKey, type QuoteCacheKey } from './quote-cache.js';
import { CHANNELS, CHANNEL_PATTERNS } from './channels.js';
import { fanout } from './fanout.js';

let redis: MemoryRedis;
let now = 1_760_000_000_000;

beforeEach(() => {
  now = 1_760_000_000_000;
  redis = new MemoryRedis(() => now);
});

const advance = (ms: number) => {
  now += ms;
};
const nowSeconds = () => Math.floor(now / 1000);

describe('MemoryRedis', () => {
  it('round-trips values and reports existence', async () => {
    await redis.set('k', 'v');
    expect(await redis.get('k')).toBe('v');
    expect(await redis.exists('k')).toBe(true);
    expect(await redis.get('missing')).toBeNull();
    expect(await redis.exists('missing')).toBe(false);
  });

  it('expires keys on the injected clock, not a timer', async () => {
    await redis.set('k', 'v', { ttlSeconds: 10 });
    expect(await redis.get('k')).toBe('v');
    advance(9_999);
    expect(await redis.get('k')).toBe('v');
    advance(1);
    expect(await redis.get('k')).toBeNull();
    expect(await redis.exists('k')).toBe(false);
  });

  it('reports remaining ttl the way Redis does', async () => {
    await redis.set('none', 'v');
    expect(await redis.ttl('none')).toBe(-1);
    expect(await redis.ttl('absent')).toBe(-2);
    await redis.set('k', 'v', { ttlSeconds: 30 });
    advance(10_000);
    expect(await redis.ttl('k')).toBe(20);
  });

  it('honours SET NX and counts deletes', async () => {
    await redis.set('k', 'first');
    expect(await redis.set('k', 'second', { ifNotExists: true })).toBe(false);
    expect(await redis.get('k')).toBe('first');
    expect(await redis.del('k', 'absent')).toBe(1);
    expect(await redis.set('k', 'second', { ifNotExists: true })).toBe(true);
    expect(await redis.get('k')).toBe('second');
  });

  it('lets an expired key be claimed with NX again', async () => {
    await redis.set('lock', '1', { ttlSeconds: 5, ifNotExists: true });
    expect(await redis.set('lock', '2', { ifNotExists: true })).toBe(false);
    advance(5_000);
    expect(await redis.set('lock', '2', { ifNotExists: true })).toBe(true);
  });

  it('matches keys by glob and skips expired ones', async () => {
    await redis.set('rl:a:1', '1');
    await redis.set('rl:a:2', '1');
    await redis.set('rl:b:1', '1', { ttlSeconds: 5 });
    expect((await redis.keys('rl:a:*')).sort()).toEqual(['rl:a:1', 'rl:a:2']);
    expect(await redis.keys('rl:*')).toHaveLength(3);
    advance(5_000);
    expect(await redis.keys('rl:*')).toHaveLength(2);
  });

  it('treats glob metacharacters in the pattern literally where Redis does', async () => {
    await redis.set('a.b', '1');
    await redis.set('axb', '1');
    // `.` is not a wildcard in Redis globs, so it must not behave like one.
    expect(await redis.keys('a.b')).toEqual(['a.b']);
    expect(await redis.keys('a?b')).toHaveLength(2);
  });

  it('increments with a ttl set only on the first hit', async () => {
    expect(await redis.incrWithTtl('c', 60)).toBe(1);
    advance(30_000);
    expect(await redis.incrWithTtl('c', 60)).toBe(2);
    // The window is fixed: a later hit must not push the expiry out.
    expect(await redis.ttl('c')).toBe(30);
    advance(30_000);
    expect(await redis.incrWithTtl('c', 60)).toBe(1);
  });
});

describe('pub/sub', () => {
  it('delivers to exact-channel subscribers only', async () => {
    const seen: string[] = [];
    await redis.subscribe(CHANNELS.board(), (msg) => seen.push(msg));
    await redis.publish(CHANNELS.board(), 'hello');
    await redis.publish(CHANNELS.tape(), 'not the board');
    expect(seen).toEqual(['hello']);
  });

  it('passes the originating channel to the handler', async () => {
    const seen: [string, string][] = [];
    await redis.psubscribe(CHANNEL_PATTERNS.token, (msg, channel) => seen.push([channel, msg]));
    await redis.publish(CHANNELS.token('DOGE'), 'a');
    await redis.publish(CHANNELS.token('RHDOG'), 'b');
    await redis.publish(CHANNELS.board(), 'not a token channel');
    expect(seen).toEqual([
      [CHANNELS.token('DOGE'), 'a'],
      [CHANNELS.token('RHDOG'), 'b'],
    ]);
  });

  it('reaches exact and pattern subscribers from one publish', async () => {
    const exact: string[] = [];
    const pattern: string[] = [];
    await redis.subscribe(CHANNELS.user('SOL', 'W'), (m) => exact.push(m));
    await redis.psubscribe(CHANNEL_PATTERNS.user, (m) => pattern.push(m));
    expect(await redis.publish(CHANNELS.user('SOL', 'W'), 'x')).toBe(2);
    expect(exact).toEqual(['x']);
    expect(pattern).toEqual(['x']);
  });

  it('fans out to every subscriber on a channel and counts receivers', async () => {
    const a: string[] = [];
    const b: string[] = [];
    await redis.subscribe(CHANNELS.tape(), (m) => a.push(m));
    await redis.subscribe(CHANNELS.tape(), (m) => b.push(m));
    expect(await redis.publish(CHANNELS.tape(), 'x')).toBe(2);
    expect(a).toEqual(['x']);
    expect(b).toEqual(['x']);
  });

  it('reports zero receivers when nothing is listening', async () => {
    expect(await redis.publish(CHANNELS.tape(), 'x')).toBe(0);
  });

  it('stops delivering after unsubscribe', async () => {
    const seen: string[] = [];
    const off = await redis.subscribe(CHANNELS.tape(), (m) => seen.push(m));
    await redis.publish(CHANNELS.tape(), 'first');
    await off();
    await redis.publish(CHANNELS.tape(), 'second');
    expect(seen).toEqual(['first']);
  });

  it('unsubscribing one handler leaves its siblings attached', async () => {
    const kept: string[] = [];
    const off = await redis.subscribe(CHANNELS.tape(), () => {});
    await redis.subscribe(CHANNELS.tape(), (m) => kept.push(m));
    await off();
    await redis.publish(CHANNELS.tape(), 'x');
    expect(kept).toEqual(['x']);
  });
});

describe('subscriber isolation', () => {
  it('does not let one throwing handler starve the others', async () => {
    const errors: string[] = [];
    const isolated = new MemoryRedis(() => now, (_err, channel) => errors.push(channel));
    const seen: string[] = [];
    await isolated.subscribe(CHANNELS.tape(), () => {
      throw new Error('socket already closed');
    });
    await isolated.subscribe(CHANNELS.tape(), (m) => seen.push(m));

    // The WS hub writes to real sockets from inside these handlers, so a
    // client that vanished mid-publish must not silence the tape.
    await expect(isolated.publish(CHANNELS.tape(), 'x')).resolves.toBe(2);
    expect(seen).toEqual(['x']);
    expect(errors).toEqual([CHANNELS.tape()]);
  });

  it('isolates pattern subscribers too', async () => {
    const seen: string[] = [];
    const isolated = new MemoryRedis(() => now);
    await isolated.psubscribe(CHANNEL_PATTERNS.token, () => {
      throw new Error('boom');
    });
    await isolated.psubscribe(CHANNEL_PATTERNS.token, (m) => seen.push(m));
    await isolated.publish(CHANNELS.token('DOGE'), 'x');
    expect(seen).toEqual(['x']);
  });

  it('survives a handler that throws without an error sink attached', async () => {
    await redis.subscribe(CHANNELS.tape(), () => {
      throw new Error('boom');
    });
    await expect(redis.publish(CHANNELS.tape(), 'x')).resolves.toBe(1);
  });

  it('counts receivers rather than successes, like PUBLISH', () => {
    const delivered = fanout(
      [
        () => {
          throw new Error('a');
        },
        () => {},
      ],
      'msg',
      'chan',
      () => {},
    );
    expect(delivered).toBe(2);
  });
});

describe('rate limits', () => {
  const rule: RateLimitRule = { bucket: 'test', limit: 3, windowSeconds: 60 };

  it('allows up to the bucket limit then refuses', async () => {
    for (let i = 0; i < 3; i++) {
      const hit = await rateLimit(redis, rule, 'ip:1.2.3.4', nowSeconds());
      expect(hit.ok).toBe(true);
      expect(hit.remaining).toBe(2 - i);
    }
    const blocked = await rateLimit(redis, rule, 'ip:1.2.3.4', nowSeconds());
    expect(blocked.ok).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.resetSeconds).toBeGreaterThan(0);
  });

  it('keys separately per identity and per bucket', async () => {
    const one: RateLimitRule = { bucket: 'one', limit: 1, windowSeconds: 60 };
    const two: RateLimitRule = { bucket: 'two', limit: 1, windowSeconds: 60 };
    expect((await rateLimit(redis, one, 'a', nowSeconds())).ok).toBe(true);
    expect((await rateLimit(redis, one, 'a', nowSeconds())).ok).toBe(false);
    expect((await rateLimit(redis, one, 'b', nowSeconds())).ok).toBe(true);
    // A different bucket is a different counter for the same identity.
    expect((await rateLimit(redis, two, 'a', nowSeconds())).ok).toBe(true);
  });

  it('resets when the fixed window rolls over', async () => {
    const short: RateLimitRule = { bucket: 'short', limit: 1, windowSeconds: 10 };
    expect((await rateLimit(redis, short, 'a', nowSeconds())).ok).toBe(true);
    expect((await rateLimit(redis, short, 'a', nowSeconds())).ok).toBe(false);
    advance(10_000);
    expect((await rateLimit(redis, short, 'a', nowSeconds())).ok).toBe(true);
  });

  it('counts down resetSeconds within a window', async () => {
    const first = await rateLimit(redis, rule, 'a', nowSeconds());
    advance(5_000);
    const later = await rateLimit(redis, rule, 'a', nowSeconds());
    expect(later.resetSeconds).toBe(first.resetSeconds - 5);
  });

  it('gives the write paths tighter buckets than the read paths', () => {
    expect(RATE_LIMITS.auth.limit).toBeLessThan(RATE_LIMITS.read.limit);
    expect(RATE_LIMITS.crate.limit).toBeLessThan(RATE_LIMITS.read.limit);
    for (const [name, bucket] of Object.entries(RATE_LIMITS)) {
      expect(bucket.limit, name).toBeGreaterThan(0);
      expect(bucket.windowSeconds, name).toBeGreaterThan(0);
    }
    // Distinct bucket names, or two limits would share one counter.
    const names = Object.values(RATE_LIMITS).map((r) => r.bucket);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('token blacklist', () => {
  it('blocks a token until its own expiry', async () => {
    expect(await isTokenBlacklisted(redis, 'jti-1')).toBe(false);
    // The entry only has to outlive the token it revokes.
    await blacklistToken(redis, 'jti-1', 60);
    expect(await isTokenBlacklisted(redis, 'jti-1')).toBe(true);
    advance(60_000);
    expect(await isTokenBlacklisted(redis, 'jti-1')).toBe(false);
  });

  it('keeps a floor of one second for an already-expired token', async () => {
    // Rounding a sub-second remainder down to 0 would mean PERSIST in Redis,
    // which is the one outcome worse than a redundant entry.
    await blacklistToken(redis, 'stale', 0);
    expect(await redis.ttl('bl:jti:stale')).toBe(1);
    advance(1_000);
    expect(await isTokenBlacklisted(redis, 'stale')).toBe(false);
  });

  it('scopes tokens by jti so revoking one leaves the other live', async () => {
    await blacklistToken(redis, 'a', 60);
    expect(await isTokenBlacklisted(redis, 'b')).toBe(false);
  });

  it('revokes every earlier session for a wallet by timestamp', async () => {
    expect(await walletBlacklistedBefore(redis, 'SOL', 'W')).toBeNull();
    const at = nowSeconds();
    await blacklistWalletBefore(redis, 'SOL', 'W', at, 3600);
    expect(await walletBlacklistedBefore(redis, 'SOL', 'W')).toBe(at);
    // Scoped per net: the same wallet on the other chain is untouched.
    expect(await walletBlacklistedBefore(redis, 'RH', 'W')).toBeNull();
  });

  it('reads a corrupt wallet entry as no revocation rather than NaN', async () => {
    await redis.set('bl:wallet:SOL:W', 'not-a-number');
    expect(await walletBlacklistedBefore(redis, 'SOL', 'W')).toBeNull();
  });
});

describe('quote cache', () => {
  const key: QuoteCacheKey = {
    net: 'SOL',
    side: 'buy',
    nativeAmount: 1,
    baseMint: 'So11111111111111111111111111111111111111112',
    sym: 'DOGE',
    reserves: '0-0',
  };
  const quote = { out: 1234, price: 0.0001, impact: 0.5 };

  it('serves a hit inside the ttl and misses after', async () => {
    const cache = new QuoteCache(redis, QUOTE_CACHE_TTL_SECONDS, () => now);
    const entry = await cache.set(key, quote);
    expect(entry.expiresAt).toBe(now + 8_000);
    expect((await cache.get<typeof quote>(key))?.value).toEqual(quote);
    advance(8_000);
    expect(await cache.get(key)).toBeNull();
  });

  it('matches the 8s qdrain bar the UI draws', () => {
    expect(QUOTE_CACHE_TTL_SECONDS).toBe(8);
  });

  it('separates net, symbol, side, size and base mint', async () => {
    const cache = new QuoteCache(redis, QUOTE_CACHE_TTL_SECONDS, () => now);
    await cache.set(key, quote);
    expect(await cache.get({ ...key, side: 'sell' })).toBeNull();
    expect(await cache.get({ ...key, sym: 'OTHER' })).toBeNull();
    expect(await cache.get({ ...key, net: 'RH' })).toBeNull();
    expect(await cache.get({ ...key, nativeAmount: 500 })).toBeNull();
    // Same size, different base asset — a completely different route.
    expect(await cache.get({ ...key, baseMint: 'other-mint' })).toBeNull();
  });

  it('is case-insensitive on the symbol', () => {
    expect(quoteCacheKey({ ...key, sym: 'doge' })).toBe(quoteCacheKey(key));
  });

  it('quantises the amount so keystroke-level noise shares an entry', async () => {
    const cache = new QuoteCache(redis, QUOTE_CACHE_TTL_SECONDS, () => now);
    await cache.set({ ...key, nativeAmount: 0.5000000001 }, quote);
    // Below lamport precision, so it must land on the same key.
    expect((await cache.get({ ...key, nativeAmount: 0.50000000009 }))?.value).toEqual(quote);
    expect(await cache.get({ ...key, nativeAmount: 0.51 })).toBeNull();
  });

  it('quantises to lamport precision', () => {
    expect(quantiseNativeAmount(0.5)).toBe('0.500000000');
    expect(quantiseNativeAmount(1 / 3)).toBe('0.333333333');
  });

  it('treats a corrupt entry as a miss rather than throwing', async () => {
    const cache = new QuoteCache(redis, QUOTE_CACHE_TTL_SECONDS, () => now);
    await cache.set(key, quote);
    await redis.set(quoteCacheKey(key), '{not json');
    expect(await cache.get(key)).toBeNull();
  });

  it('wrap() produces once on a miss and reuses the hit', async () => {
    const cache = new QuoteCache(redis, QUOTE_CACHE_TTL_SECONDS, () => now);
    let calls = 0;
    const produce = async () => {
      calls++;
      return quote;
    };

    expect((await cache.wrap(key, produce)).value).toEqual(quote);
    expect((await cache.wrap(key, produce)).value).toEqual(quote);
    // This is what keeps the aggregator call rate off the keystroke rate.
    expect(calls).toBe(1);

    advance(8_000);
    await cache.wrap(key, produce);
    expect(calls).toBe(2);
  });

  it('wrap() re-produces an entry that is stale but not yet evicted', async () => {
    // A longer Redis ttl than the logical one would otherwise serve a quote
    // the UI has already drained the bar on.
    const cache = new QuoteCache(redis, 8, () => now);
    await redis.set(
      quoteCacheKey(key),
      JSON.stringify({ value: quote, expiresAt: now - 1 }),
      { ttlSeconds: 60 },
    );
    let calls = 0;
    const fresh = await cache.wrap(key, async () => {
      calls++;
      return { ...quote, out: 9999 };
    });
    expect(calls).toBe(1);
    expect(fresh.value.out).toBe(9999);
  });
});

describe('channel names', () => {
  it('scopes user channels by net so the two chains never cross', () => {
    expect(CHANNELS.user('SOL', 'W')).not.toBe(CHANNELS.user('RH', 'W'));
  });

  it('keeps board and tape global, with net carried in the payload', () => {
    // Both chains share one board channel; a net-filtered client drops the
    // other chain from the event body rather than the channel name.
    expect(CHANNELS.board()).toBe('board');
    expect(CHANNELS.tape()).toBe('tape');
  });

  it('uppercases symbols so DOGE and doge are one channel', () => {
    expect(CHANNELS.token('doge')).toBe(CHANNELS.token('DOGE'));
  });

  it('has patterns that match their own builders and nothing else', () => {
    const toRegex = (p: string) => new RegExp(`^${p.replace(/[.]/g, '\\.').replace(/\*/g, '.*')}$`);
    expect(CHANNELS.token('DOGE')).toMatch(toRegex(CHANNEL_PATTERNS.token));
    expect(CHANNELS.user('SOL', 'W')).toMatch(toRegex(CHANNEL_PATTERNS.user));
    // Cross-checks: a board or tape message must not arrive on either pattern.
    expect(CHANNELS.board()).not.toMatch(toRegex(CHANNEL_PATTERNS.token));
    expect(CHANNELS.tape()).not.toMatch(toRegex(CHANNEL_PATTERNS.user));
    expect(CHANNELS.user('SOL', 'W')).not.toMatch(toRegex(CHANNEL_PATTERNS.token));
  });
});

describe('shutdown', () => {
  it('answers ping while open', async () => {
    expect(await redis.ping()).toBe(true);
  });

  it('drops subscriptions and data on close', async () => {
    const seen: string[] = [];
    await redis.subscribe(CHANNELS.tape(), (m) => seen.push(m));
    await redis.set('k', 'v');
    await redis.close();
    expect(await redis.publish(CHANNELS.tape(), 'x')).toBe(0);
    expect(seen).toEqual([]);
    expect(await redis.get('k')).toBeNull();
  });
});
