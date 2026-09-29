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
import { ReferralService } from '../game/referrals.js';
import { SocialCapsService } from '../game/social-caps.js';
import { SpLevelService } from '../game/sp-levels.js';
import { createLogger, type Logger } from '../observability/logger.js';
import { Metrics, loggingAlertHook } from '../observability/metrics.js';
import { createRedis } from '../redis/ioredis.js';
import { QuoteCache } from '../redis/quote-cache.js';
import type { RedisLike } from '../redis/types.js';
import { Publisher } from '../ws/publisher.js';
import {
  createBaseMintRegistry,
  parseBaseMintOverrides,
  type BaseMintRegistry,
} from '../router/base-mints.js';
import { HttpJupiterClient, type JupiterClient } from '../router/jupiter.js';
import { OracleHopClient } from '../router/oracle-hop.js';
import { ResilientUniswapClient } from '../router/resilient-uniswap.js';
import { HttpSolanaBroadcaster, type SolanaBroadcaster } from '../router/solana-broadcast.js';
import { HttpUniswapClient, type UniswapClient } from '../router/uniswap.js';
import { V3PoolHopClient } from '../router/v3-pool-hop.js';
import { ChatService } from '../social/chat.js';
import { XProfileCacheService } from '../social/x-cache.js';
import { HttpXProvider, PlaceholderXProvider, type XProvider } from '../social/x-provider.js';
import type { AppDeps } from './context.js';
import { buildAdminServices } from '../admin/index.js';

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
  solanaBroadcaster?: SolanaBroadcaster;
  xProvider?: XProvider;
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
        net: 'RH',
        onCall: (ok) => metrics.rpcCall('RH', ok),
      }),
      BASE: new EvmRpc({
        url: env.baseRpcUrl,
        chainId: env.baseChainId,
        net: 'BASE',
        onCall: (ok) => metrics.rpcCall('BASE', ok),
      }),
      ARC: new EvmRpc({
        url: env.arcRpcUrl,
        chainId: env.arcChainId,
        net: 'ARC',
        onCall: (ok) => metrics.rpcCall('ARC', ok),
      }),
    } satisfies ChainRpcs);

  const oracle =
    overrides.oracle ??
    new CachedPriceOracle(
      new HttpPriceOracle({ baseUrl: env.priceOracleUrl }),
      redis,
      env.priceOracleTtlSeconds,
    );

  const ethCaller = asEthCaller(rpcs.RH) ?? asEthCaller(rpcs.BASE);
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
    baseChainId: env.baseChainId,
    arcChainId: env.arcChainId,
    solanaSiwsChainId: env.solanaSiwsChainId,
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

  const socialCaps = new SocialCapsService({ db, ledger, now });
  const awards = new GameAwards({ ledger, socialCaps, dust: env.dust, whaleCut: env.whaleCut });
  const spLevels = new SpLevelService({ db, publisher, now });
  const referrals = new ReferralService({ db, ledger, now });
  const crates = new CrateService({
    db,
    ledger,
    publisher,
    spLevels,
    secret: env.crateHmacSecret,
    now,
  });
  ledger.setAfterSpCredit(async (net, wallet, totalSp) => {
    await spLevels.sync(net, wallet, totalSp);
  });
  ledger.setAfterSpAwarded(async (net, wallet, spAwarded, _reason, eventId) => {
    await referrals.kickbackSp(net, wallet, spAwarded, eventId);
  });

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
  const baseMints: BaseMintRegistry =
    overrides.baseMints ??
    createBaseMintRegistry({
      SOL: parseBaseMintOverrides(process.env['BASE_MINT_OVERRIDES_SOL']),
      RH: parseBaseMintOverrides(process.env['BASE_MINT_OVERRIDES_RH']),
      BASE: parseBaseMintOverrides(process.env['BASE_MINT_OVERRIDES_BASE']),
      ARC: parseBaseMintOverrides(process.env['BASE_MINT_OVERRIDES_ARC']),
      solanaCluster: env.solanaCluster,
    });
  const uniswap: UniswapClient =
    overrides.uniswap ??
    (() => {
      const weth = baseMints.mintFor('RH', 'WETH') ?? undefined;
      const http = new HttpUniswapClient({
        baseUrl: env.uniswapApiBaseUrl,
        ...(env.uniswapApiKey ? { apiKey: env.uniswapApiKey } : {}),
        chainId: env.rhChainId,
        ...(weth ? { wethAddress: weth } : {}),
      });
      // Trading API (mainnet) → on-chain V3 pool quoter (testnet seed) →
      // oracle-priced display hop. Prepare rejects oracle-only hops.
      if (!weth) return http;
      const oracleHop = new OracleHopClient({ oracle, baseMints, wethMint: weth });
      const eth = asEthCaller(rpcs.RH);
      if (!eth) {
        return new ResilientUniswapClient(http, oracleHop);
      }
      const v3Hop = new V3PoolHopClient({
        eth,
        factory: env.rhV3FactoryAddress,
        quoter: env.rhV3QuoterAddress,
        wethMint: weth,
        baseMints,
        feeTierOverrides: env.rhV3FeeTierOverrides,
      });
      return new ResilientUniswapClient(new ResilientUniswapClient(http, v3Hop), oracleHop);
    })();

  const solanaBroadcaster: SolanaBroadcaster =
    overrides.solanaBroadcaster ??
    new HttpSolanaBroadcaster({
      rpcUrl: env.solanaRpcUrl,
      jitoBlockEngineUrl: env.jitoBlockEngineUrl,
      privateRpcUrl: env.solanaPrivateRpcUrl,
      logger,
    });

  const xProvider: XProvider =
    overrides.xProvider ??
    (env.xBearerToken
      ? new HttpXProvider({ bearerToken: env.xBearerToken })
      : new PlaceholderXProvider());
  const xCache = new XProfileCacheService({
    db,
    provider: xProvider,
    ttlSeconds: env.xCacheTtlSeconds,
    now,
  });
  const admin = await buildAdminServices({ env, db, redis, logger, now, ethCaller });
  const chat = new ChatService({
    db,
    redis,
    now,
    rpcs,
    settings: admin.settings,
    moderation: admin.gate,
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
    spLevels,
    referrals,
    socialCaps,
    publisher,
    now,
    jupiter,
    uniswap,
    baseMints,
    solanaBroadcaster,
    chat,
    xCache,
    admin,
  };

  return {
    deps,
    async close() {
      for (const close of closers.reverse()) await close();
    },
  };
}
