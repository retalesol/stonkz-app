import type { Redis } from 'ioredis';
import { fanout, type HandlerErrorSink } from './fanout.js';
import type { RedisHandler, RedisLike, RedisUnsubscribe, SetOptions } from './types.js';

/**
 * The real client. Pub/sub needs a second connection because a subscribed
 * ioredis connection refuses ordinary commands, so the subscriber is created
 * lazily and only when something actually listens.
 */
export class IoRedis implements RedisLike {
  private subscriber: Redis | null = null;
  private readonly channelHandlers = new Map<string, Set<RedisHandler>>();
  private readonly patternHandlers = new Map<string, Set<RedisHandler>>();

  constructor(
    private readonly client: Redis,
    private readonly onHandlerError?: HandlerErrorSink,
  ) {}

  static async connect(url: string, onHandlerError?: HandlerErrorSink): Promise<IoRedis> {
    const { Redis: RedisCtor } = await import('ioredis');
    return new IoRedis(
      new RedisCtor(url, { maxRetriesPerRequest: 3, lazyConnect: false }),
      onHandlerError,
    );
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, opts: SetOptions = {}): Promise<boolean> {
    let result: string | null;
    if (opts.ttlSeconds !== undefined && opts.ifNotExists) {
      result = await this.client.set(key, value, 'EX', opts.ttlSeconds, 'NX');
    } else if (opts.ttlSeconds !== undefined) {
      result = await this.client.set(key, value, 'EX', opts.ttlSeconds);
    } else if (opts.ifNotExists) {
      result = await this.client.set(key, value, 'NX');
    } else {
      result = await this.client.set(key, value);
    }
    return result === 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    return keys.length === 0 ? 0 : this.client.del(...keys);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.client.exists(key)) === 1;
  }

  async incrWithTtl(key: string, ttlSeconds: number): Promise<number> {
    // INCR then a conditional EXPIRE, so a window is never extended mid-flight.
    const [[, count]] = (await this.client
      .multi()
      .incr(key)
      .expire(key, ttlSeconds, 'NX')
      .exec()) as [[Error | null, number], [Error | null, number]];
    return count;
  }

  async ttl(key: string): Promise<number> {
    return this.client.ttl(key);
  }

  async keys(pattern: string): Promise<string[]> {
    // SCAN, not KEYS: this runs against a shared production instance.
    const found: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      found.push(...batch);
    } while (cursor !== '0');
    return found;
  }

  async publish(channel: string, message: string): Promise<number> {
    return this.client.publish(channel, message);
  }

  private async ensureSubscriber(): Promise<Redis> {
    if (this.subscriber) return this.subscriber;
    const sub = this.client.duplicate();
    // Anything thrown in these callbacks is an unhandled exception inside
    // ioredis's emitter, so `fanout` has to contain it.
    sub.on('message', (channel: string, message: string) => {
      fanout(this.channelHandlers.get(channel) ?? [], message, channel, this.onHandlerError);
    });
    sub.on('pmessage', (pattern: string, channel: string, message: string) => {
      fanout(this.patternHandlers.get(pattern) ?? [], message, channel, this.onHandlerError);
    });
    this.subscriber = sub;
    return sub;
  }

  async subscribe(channel: string, handler: RedisHandler): Promise<RedisUnsubscribe> {
    const sub = await this.ensureSubscriber();
    let set = this.channelHandlers.get(channel);
    if (!set) {
      set = new Set();
      this.channelHandlers.set(channel, set);
      await sub.subscribe(channel);
    }
    set.add(handler);
    return async () => {
      set.delete(handler);
      if (set.size === 0) {
        this.channelHandlers.delete(channel);
        await sub.unsubscribe(channel);
      }
    };
  }

  async psubscribe(pattern: string, handler: RedisHandler): Promise<RedisUnsubscribe> {
    const sub = await this.ensureSubscriber();
    let set = this.patternHandlers.get(pattern);
    if (!set) {
      set = new Set();
      this.patternHandlers.set(pattern, set);
      await sub.psubscribe(pattern);
    }
    set.add(handler);
    return async () => {
      set.delete(handler);
      if (set.size === 0) {
        this.patternHandlers.delete(pattern);
        await sub.punsubscribe(pattern);
      }
    };
  }

  async ping(): Promise<boolean> {
    return (await this.client.ping()) === 'PONG';
  }

  async close(): Promise<void> {
    if (this.subscriber) await this.subscriber.quit();
    await this.client.quit();
  }
}

/** `memory://` or an empty URL selects the in-process fake. */
export async function createRedis(url: string, onHandlerError?: HandlerErrorSink): Promise<RedisLike> {
  if (url === '' || url.startsWith('memory:')) {
    const { MemoryRedis } = await import('./memory.js');
    return new MemoryRedis(Date.now, onHandlerError);
  }
  return IoRedis.connect(url, onHandlerError);
}
