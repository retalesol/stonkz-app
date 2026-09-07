import { JwtService } from '../auth/jwt.js';
import { AuthService } from '../auth/service.js';
import type { EthCaller } from '../auth/siwe.js';
import { EvmRpc } from '../chain/evm.js';
import type { ChainRpc } from '../chain/types.js';
import { CachedPriceOracle, HttpPriceOracle } from '../chain/oracle.js';
import { SolanaRpc } from '../chain/solana.js';
import type { ChainRpcs, PriceOracle } from '../chain/types.js';
import { createDb, type Db } from '../db/client.js';
import type { ApiEnv } from '../env.js';
import { GameAwards } from '../game/awards.js';
import { CrateService } from '../game/crates.js';
import { Ledger } from '../game/ledger.js';
import { createLogger, type Logger } from '../observability/logger.js';
import { Metrics, loggingAlertHook } from '../observability/metrics.js';
import { createRedis } from '../redis/ioredis.js';
import { QuoteCache } from '../redis/quote-cache.js';
import type { RedisLike } from '../redis/types.js';
import { Publisher } from '../ws/publisher.js';
import { createBaseMintRegistry, parseBaseMintOverrides, type BaseMintRegistry } from '../router/base-mints.js';
import { HttpJupiterClient, type JupiterClient } from '../router/jupiter.js';
import { HttpUniswapClient, type UniswapClient } from '../router/uniswap.js';
import type { AppDeps } from './context.js';

/**
 * The RH slot of `ChainRpcs` is typed as the generic `ChainRpc`, so a test can
 * swap in a fake. Only the real EVM client can answer `eth_call`; a fake that
 * cannot simply leaves contract-account logins refused.
 */
function asEthCaller(rpc: ChainRpc): EthCaller | undefined {
  const candidate = rpc as Partial<EthCaller>;
  return typeof candidate.ethCall === 'function' ? (candidate as EthCaller) : undefined;
}

/**
 * Anything a caller wants to substitute. Production overrides nothing; tests
 * override the database, Redis, both RPCs and the oracle.
 */
export interface DepsOverrides {
  db?: Db;
  redis?: RedisLike;
  logger?: Logger;
  rpcs?: ChainRpcs;
  oracle?: PriceOracle;
  now?: () => number;
  jupiter?: JupiterClient;
  uniswap?: UniswapClient;
  baseMints?: BaseMintRegistry;
}

export interface BuiltDeps {
  deps: AppDeps;
  /** Closes only what this call created; injected resources are the caller's. */
  close(): Promise<void>;
}

export async function buildDeps(env: ApiEnv, overrides: DepsOverrides = {}): Promise<BuiltDeps> {
  const now = overrides.now ?? Date.now;
  const logger = overrides.logger ?? createLogger(env.logLevel, { svc: 'api' });
  const metrics = new Metrics(env.maxChainLagSeconds, loggingAlertHook(logger), now);

  const closers: (() => Promise<void>)[] = [];

  let db = overrides.db;
  if (!db) {
    const handle = createDb({ url: env.databaseUrl, poolMax: env.databasePoolMax });
    db = handle.db;
    closers.push(handle.close);
  }

  let redis = overrides.redis;
  if (!redis) {
    redis = await createRedis(env.redisUrl, (err, channel) =>
      logger.error('redis subscriber threw', { channel, err: String(err) }),
    );
    closers.push(() => (redis as RedisLike).close());
  }

  const rpcs: ChainRpcs =
    overrides.rpcs ??
    ({
      SOL: new SolanaRpc({
        url: env.solanaRpcUrl,
        onCall: (ok) => metrics.rpcCall('SOL', ok),
      }),
      RH: new EvmRpc({
        url: env.rhRpcUrl,
        chainId: env.rhChainId,
        onCall: (ok) => metrics.rpcCall('RH', ok),
      }),
    } satisfies ChainRpcs);

  const oracle =
    overrides.oracle ??
    new CachedPriceOracle(
      new HttpPriceOracle({ baseUrl: env.priceOracleUrl }),
      redis,
      env.priceOracleTtlSeconds,
    );

  const ethCaller = asEthCaller(rpcs.RH);
  const publisher = new Publisher(redis, now);
  const jwt = new JwtService(
    {
      secret: env.jwtSecret,
      issuer: env.jwtIssuer,
      accessTtlSeconds: env.accessTokenTtlSeconds,
      refreshTtlSeconds: env.refreshTokenTtlSeconds,
    },
    now,
  );

  const auth = new AuthService({
    db,
    redis,
    jwt,
    domain: env.siwsDomain,
    uri: `https://${env.siwsDomain}`,
    rhChainId: env.rhChainId,
    allowedRhChainIds: env.allowedRhChainIds,
    nonceTtlSeconds: env.nonceTtlSeconds,
    accessTtlSeconds: env.accessTokenTtlSeconds,
    refreshTtlSeconds: env.refreshTokenTtlSeconds,
    // Smart-contract accounts are first-class on Robinhood Chain, so the
    // verifier needs an `eth_call` to fall back to ERC-1271.
    ...(ethCaller ? { ethCaller } : {}),
    now,
  });

  const ledger = new Ledger({
    db,
    publisher,
    dailyXpCap: env.dailyXpCap,
    dailySpCap: env.dailySpCap,
    now,
  });

  const awards = new GameAwards({ ledger, dust: env.dust, whaleCut: env.whaleCut });
  const crates = new CrateService({ db, ledger, publisher, secret: env.crateHmacSecret, now });

  // No real Jupiter/Uniswap credentials exist in this environment (see the
  // phase report). These are still real HTTP clients pointed at the public
  // APIs — only the test suite overrides them with `FakeJupiterClient`/
  // `FakeUniswapClient` from `router/fixtures.ts`.
  const jupiter: JupiterClient =
    overrides.jupiter ??
    new HttpJupiterClient({
      baseUrl: env.jupiterApiBaseUrl,
      ...(env.jupiterApiKey ? { apiKey: env.jupiterApiKey } : {}),
    });
  const uniswap: UniswapClient =
    overrides.uniswap ??
    new HttpUniswapClient({
      baseUrl: env.uniswapApiBaseUrl,
      ...(env.uniswapApiKey ? { apiKey: env.uniswapApiKey } : {}),
      chainId: env.rhChainId,
    });
  const baseMints: BaseMintRegistry =
    overrides.baseMints ??
    createBaseMintRegistry({
      SOL: parseBaseMintOverrides(process.env['BASE_MINT_OVERRIDES_SOL']),
      RH: parseBaseMintOverrides(process.env['BASE_MINT_OVERRIDES_RH']),
    });

  const deps: AppDeps = {
    env,
    db,
    redis,
    logger,
    metrics,
    rpcs,
    oracle,
    jwt,
    auth,
    quotes: new QuoteCache(redis, env.quoteCacheTtlSeconds, now),
    ledger,
    awards,
    crates,
    publisher,
    now,
    jupiter,
    uniswap,
    baseMints,
  };

  return {
    deps,
    async close() {
      for (const close of closers.reverse()) await close();
    },
  };
}
