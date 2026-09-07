import type { Hono } from 'hono';
import type { Net } from '@stonkz/shared';
import { createApp } from '../app/create.js';
import { buildDeps } from '../app/deps.js';
import type { AppDeps, AppEnv } from '../app/context.js';
import { FakePriceOracle, createFakeRpcs, type FakeChainRpc } from '../chain/fake.js';
import { readEnv } from '../env.js';
import { createLogger } from '../observability/logger.js';
import { MemoryRedis } from '../redis/memory.js';
import { FakeJupiterClient, FakeUniswapClient } from '../router/fixtures.js';
import type { UserEvent } from '../redis/channels.js';
import { createTestDb, type TestDb } from './harness.js';
import { evmWallet, solanaWallet, type TestWallet } from './wallets.js';

/**
 * A whole API wired to fakes.
 *
 * PGlite for Postgres, `MemoryRedis` for Redis, `FakeChainRpc` for both chains
 * and `FakePriceOracle` for the footer price. Requests go through
 * `app.request()`, so routing, middleware, CORS, CSP and auth all execute for
 * real — only the external world is substituted.
 */
export interface TestApp {
  app: Hono<AppEnv>;
  deps: AppDeps;
  db: TestDb;
  redis: MemoryRedis;
  rpcs: { SOL: FakeChainRpc; RH: FakeChainRpc };
  oracle: FakePriceOracle;
  jupiter: FakeJupiterClient;
  uniswap: FakeUniswapClient;
  /** Advance the frozen clock; every service reads through `deps.now`. */
  setNow(ms: number): void;
  advance(ms: number): void;
  now(): number;
  /** Every `user:` event published during the test, in order. */
  userEvents: { channel: string; event: UserEvent }[];
  /**
   * Drops every rate-limit counter.
   *
   * The limiter windows on wall-clock time, but the test clock is frozen, so
   * counters accumulate across an entire file and an unrelated test
   * eventually trips the limit. Tests that assert limiter behaviour call this
   * to isolate themselves; everything else gets it from `beforeEach`.
   */
  clearRateLimits(): Promise<void>;
  login(net: Net, wallet?: TestWallet): Promise<{ token: string; address: string; refreshToken: string }>;
  close(): Promise<void>;
}

export const TEST_ORIGIN = 'https://ston.kz';
export const FROZEN_NOW = Date.parse('2026-09-06T12:00:00.000Z');

export interface CreateTestAppOptions {
  now?: number;
  env?: Record<string, string>;
}

export async function createTestApp(opts: CreateTestAppOptions = {}): Promise<TestApp> {
  const db = await createTestDb();
  let clock = opts.now ?? FROZEN_NOW;
  const now = (): number => clock;

  const redis = new MemoryRedis(now);
  const rpcs = createFakeRpcs();
  const oracle = new FakePriceOracle({ SOL: 214.08, ETH: 4200 });
  const jupiter = new FakeJupiterClient();
  const uniswap = new FakeUniswapClient();

  const env = readEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    JWT_SECRET: 'test-secret-that-is-at-least-32-chars-long',
    CRATE_HMAC_SECRET: 'test-crate-secret-at-least-32-chars-long',
    SIWS_DOMAIN: 'ston.kz',
    ...opts.env,
  });

  const built = await buildDeps(env, {
    db: db.db,
    redis,
    rpcs,
    oracle,
    jupiter,
    uniswap,
    logger: createLogger('silent'),
    now,
  });

  const userEvents: { channel: string; event: UserEvent }[] = [];
  await redis.psubscribe('user:*', (message, channel) => {
    userEvents.push({ channel, event: JSON.parse(message) as UserEvent });
  });

  const app = createApp(built.deps);

  const login: TestApp['login'] = async (net, wallet) => {
    const w = wallet ?? (net === 'SOL' ? solanaWallet() : evmWallet());
    const nonceRes = await app.request(
      `/auth/nonce?net=${net}&address=${encodeURIComponent(w.address)}`,
    );
    const challenge = (await nonceRes.json()) as { message: string };

    const path = net === 'SOL' ? '/auth/siws' : '/auth/siwe';
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        address: w.address,
        message: challenge.message,
        signature: w.sign(challenge.message),
      }),
    });
    if (res.status !== 200) throw new Error(`login failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { accessToken: string; refreshToken: string; wallet: string };
    return { token: body.accessToken, address: body.wallet, refreshToken: body.refreshToken };
  };

  return {
    app,
    deps: built.deps,
    db,
    redis,
    rpcs,
    oracle,
    jupiter,
    uniswap,
    now,
    setNow: (ms) => {
      clock = ms;
    },
    advance: (ms) => {
      clock += ms;
    },
    userEvents,
    login,
    async clearRateLimits() {
      const keys = await redis.keys('rl:*');
      if (keys.length > 0) await redis.del(...keys);
    },
    async close() {
      await built.close();
      await db.close();
    },
  };
}

/** Authorization + Origin headers for an authenticated browser call. */
export function authed(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, origin: TEST_ORIGIN };
}
