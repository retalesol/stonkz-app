export type RedisUnsubscribe = () => Promise<void>;
export type RedisHandler = (message: string, channel: string) => void;

export interface SetOptions {
  ttlSeconds?: number;
  /** SET NX — resolves false when the key already exists. */
  ifNotExists?: boolean;
}

/**
 * The slice of Redis the API actually uses: rate limits, the session
 * blacklist, the 8-second quote cache and pub/sub. Narrow on purpose so the
 * in-memory fake is a complete implementation rather than a partial mock, and
 * so tests never need a server.
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: SetOptions): Promise<boolean>;
  del(...keys: string[]): Promise<number>;
  exists(key: string): Promise<boolean>;
  /** Returns the value after incrementing; sets the TTL on first touch. */
  incrWithTtl(key: string, ttlSeconds: number): Promise<number>;
  ttl(key: string): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string, handler: RedisHandler): Promise<RedisUnsubscribe>;
  /** Pattern subscribe — the WS hub fans out `token:*` and `user:*`. */
  psubscribe(pattern: string, handler: RedisHandler): Promise<RedisUnsubscribe>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}
