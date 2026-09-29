import { PublicKey } from '@solana/web3.js';
import { withChainsFile } from './chains-file.js';
import type { Net } from '@stonkz/shared';
import { DEFAULT_DUST, DEFAULT_WHALE_CUT } from '@stonkz/shared';
import { ARC_BLOCK_MS, ARC_CHAIN_ID, ARC_EXPLORER_URL, ARC_RPC_URL } from './chain/arc.js';
import {
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_EXPLORER_URL,
  BASE_SEPOLIA_RPC_URL,
} from './chain/base.js';
import {
  RH_CHAIN_ID,
  RH_PUBLIC_RPC_URL,
  RH_TESTNET_CHAIN_ID,
  RH_TESTNET_PUBLIC_RPC_URL,
} from './chain/evm.js';

/**
 * Every knob the API reads, resolved once at boot. Defaults target
 * `docker compose up` so a clean checkout runs with no `.env` at all; nothing
 * here reaches for a cloud resource.
 */
export interface ApiEnv {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';

  databaseUrl: string;
  databasePoolMax: number;

  /** `memory://` (or empty) selects the in-process Redis fake. */
  redisUrl: string;

  jwtSecret: string;
  jwtIssuer: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  nonceTtlSeconds: number;
  siwsDomain: string;

  corsOrigins: readonly string[];

  /**
   * Number of reverse-proxy hops in front of this process that are trusted
   * to append their own observed connecting IP to `X-Forwarded-For` — see
   * `net/client-ip.ts`. Only the last this-many entries of that header are
   * ever trusted for rate-limit identity/session `ip` logging; anything to
   * the left is client-controllable and ignored. Defaults to `1`, matching
   * Railway's single edge-proxy hop (`README.md`'s "Production deployment"
   * table). Set to `0` to distrust the header entirely (e.g. reachable
   * directly, with no proxy in front).
   */
  trustedProxyDepth: number;

  solanaRpcUrl: string;
  /**
   * `mainnet-beta` | `devnet` | `testnet` | `localnet`. Defaults to **devnet**
   * so staging can settle against a free cluster; mainnet is an RPC + cluster
   * env switch only.
   */
  solanaCluster: 'mainnet-beta' | 'devnet' | 'testnet' | 'localnet';
  /** CAIP-2 id written into SIWS messages (`solana:devnet`, `solana:mainnet`, …). */
  solanaSiwsChainId: string;
  rhRpcUrl: string;
  /** Blockscout / RH explorer base (no trailing slash). Used for live token holders. */
  rhExplorerUrl: string;
  rhChainId: number;
  /**
   * EVM chain ids a SIWE message may name (RH + Base, plus Arc once
   * `ARC_LAUNCHPAD_ADDRESS` is configured). See `AuthServiceOptions`.
   */
  allowedRhChainIds: readonly number[];
  rhNetworkLabel: string;
  baseRpcUrl: string;
  baseExplorerUrl: string;
  baseChainId: number;
  baseLaunchpadAddress: string;
  baseRouterAddress: string;
  baseV3FeeTierOverrides: Record<string, number>;
  baseV3FactoryAddress: string;
  baseV3QuoterAddress: string;
  /* ------------------------------------------------------------------ Arc */
  /** Circle's Arc (chain id 5042, USDC gas). See `chain/arc.ts`. */
  arcRpcUrl: string;
  arcExplorerUrl: string;
  arcChainId: number;
  /**
   * Zero address (the default) means "not deployed on Arc": `/trade/prepare`
   * refuses Arc trades and SIWE does not accept 5042 until this is set.
   */
  arcLaunchpadAddress: string;
  arcRouterAddress: string;
  arcV3FeeTierOverrides: Record<string, number>;
  arcV3FactoryAddress: string;
  arcV3QuoterAddress: string;
  maxChainLagSeconds: number;
  chainTickMs: Record<Net, number>;

  priceOracleUrl: string;
  priceOracleTtlSeconds: number;

  crateHmacSecret: string;
  dailyXpCap: number;
  dailySpCap: number;
  dust: Record<Net, number>;
  whaleCut: Record<Net, number>;

  quoteCacheTtlSeconds: number;

  /* -------------------------------------------------------- router (Phase 2.R) */

  /**
   * Jupiter's public Swap API v6. No key needed for `lite-api.jup.ag` at
   * moderate volume; a paid plan moves to `api.jup.ag` and sets
   * `JUPITER_API_KEY` — see `router/jupiter.ts`.
   */
  jupiterApiBaseUrl: string;
  jupiterApiKey: string | undefined;
  /** Uniswap Trading API. Confirmed live for chain id 4663 — docs/robinhood-chain.md §3.2. */
  uniswapApiBaseUrl: string;
  uniswapApiKey: string | undefined;

  /* -------------------------------------------------------- launchpad (Phase 2.B) */

  /** `Anchor.toml`'s `[programs.localnet]` id — override per environment. */
  solanaLaunchpadProgramId: string;
  /**
   * `SOLANA_LAUNCH_ALT`: comma-separated address lookup tables holding the
   * launchpad's static accounts (created by
   * `programs/solana/scripts/create-launch-alt.ts`). Optional — every v0
   * launch/trade compiles against them on top of Jupiter's own tables.
   */
  solanaLaunchAlts: string[];
  /**
   * No `StonkzLaunchpad` deployment address is recorded anywhere in this
   * repo yet (`programs/evm` has no deploy script/address file at the time
   * of this phase). The zero address is a loud placeholder, not a guess —
   * `readEnv` refuses it in production.
   */
  rhLaunchpadAddress: string;

  /**
   * `programs/evm/src/StonkzRouter.sol`'s deployment address. Zero address
   * (the default) means "not deployed here". Production refuses to boot
   * without it — RH trades are atomic-only; the old multi-step `EvmStep[]`
   * fallback is gone (`docs/rh-trade-atomicity-gap.md`).
   */
  rhRouterAddress: string;
  /**
   * `SYM_OR_MINT:feeBps,SYM_OR_MINT:feeBps` — the Uniswap v3 pool fee tier
   * `router/evm-router.ts` is allowed to route an aggregator-hop trade
   * through `StonkzRouter` against, keyed by base mint address (lowercased)
   * or symbol. Deliberately empty by default: `docs/robinhood-chain.md`
   * row 43's "~1,900 hookless v4 pools carry 88-100% LP fees" warning is
   * exactly why this is an explicit allow-list a human pins per base asset,
   * never a guessed/probed default — the same posture `base-mints.ts`
   * already takes for RH base addresses.
   */
  rhV3FeeTierOverrides: Record<string, number>;
  /**
   * Uniswap V3 factory used by `V3PoolHopClient` for `getPool` on RH.
   * Defaults: testnet 46630 factory from `RobinhoodChainTestnet.sol`, else
   * mainnet 4663 factory.
   */
  rhV3FactoryAddress: string;
  /**
   * Deployed `V3ExactInputQuoter` (or QuoterV2) for executable on-chain hops.
   * Zero address disables the V3 pool hop (Trading API / oracle only).
   */
  rhV3QuoterAddress: string;

  /**
   * Pyth Hermes (`PYTH_HERMES_URL`, `PYTH_HERMES_API_KEY`, sent as
   * `Authorization: Bearer`). EVM launches fetch a signed ETH/USD update here
   * and submit it in the launch transaction (`router/evm-pyth.ts`). Both
   * optional: unset, launches send an empty update and work while the
   * on-chain price is still fresh.
   */
  pythHermesUrl: string | undefined;
  pythHermesApiKey: string | undefined;

  launchIntentTtlSeconds: number;
  launchRateLimitPerWallet: number;
  launchRateLimitWindowSeconds: number;

  /* -------------------------------------------------------------- social (Phase 5) */

  /** Absent (the default in every environment today) selects `PlaceholderXProvider` — see `social/x-provider.ts`. */
  xBearerToken: string | undefined;
  xCacheTtlSeconds: number;
  /** How long a verified tip signature is accepted as "recent" evidence of payment. */
  tipMaxAgeSeconds: number;
  /** Canonical origin OG crawlers should be told the shareable page lives at. */
  publicWebOrigin: string;

  /** Pinata JWT for `POST /me/avatar`. Absent → avatar uploads return 503. */
  pinataJwt: string | undefined;
  /** Dedicated gateway host, e.g. `indigo-hollow-catfish-851.mypinata.cloud`. */
  pinataGateway: string;
}

export const ZERO_EVM_ADDRESS = '0x0000000000000000000000000000000000000000';

/** The dev fallbacks. Booting production on either of these is fatal. */
export const DEV_JWT_SECRET = 'dev-only-insecure-secret-change-me-0000000000';
export const DEV_CRATE_SECRET = 'dev-only-crate-secret-change-me-000000000000';

const DEFAULT_CORS = [
  'https://ston.kz',
  'https://www.ston.kz',
  'http://localhost:5173',
  'http://localhost:4173',
  // Vite's own dev/preview server prints (and Playwright's `live.spec.ts`
  // header instructions use) `http://127.0.0.1:<port>`, not `localhost` — a
  // browser treats those as different origins even though they resolve to
  // the same host, so both spellings need their own allow-list entry or the
  // documented local live-e2e workflow gets a same-origin-looking 403.
  'http://127.0.0.1:5173',
  'http://127.0.0.1:4173',
];

export type EnvSource = Record<string, string | undefined>;

function str(src: EnvSource, key: string, fallback: string): string {
  const v = src[key];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

function int(src: EnvSource, key: string, fallback: number): number {
  const raw = src[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n))
    throw new Error(`env ${key} must be an integer, got ${JSON.stringify(raw)}`);
  return n;
}

function float(src: EnvSource, key: string, fallback: number): number {
  const raw = src[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n))
    throw new Error(`env ${key} must be a number, got ${JSON.stringify(raw)}`);
  return n;
}

function list(src: EnvSource, key: string, fallback: readonly string[]): string[] {
  const raw = src[key];
  if (raw === undefined || raw.trim() === '') return [...fallback];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function ints(src: EnvSource, key: string, fallback: readonly number[]): number[] {
  const raw = src[key];
  if (raw === undefined || raw.trim() === '') return [...fallback];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const n = Number.parseInt(s, 10);
      if (!Number.isInteger(n)) {
        throw new Error(
          `env ${key} must be a comma-separated integer list, got ${JSON.stringify(raw)}`,
        );
      }
      return n;
    });
}

/** `KEY:123,KEY:456` \u2192 `{KEY: 123, KEY2: 456}`, keys uppercased. Used for `rhV3FeeTierOverrides`. */
function intMap(src: EnvSource, key: string): Record<string, number> {
  const raw = src[key];
  if (!raw || !raw.trim()) return {};
  const out: Record<string, number> = {};
  for (const pair of raw.split(',')) {
    const [k, v] = pair.split(':').map((s) => s.trim());
    if (!k || !v) continue;
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n)) out[k.toUpperCase()] = n;
  }
  return out;
}

function oneOf<T extends string>(
  src: EnvSource,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const v = str(src, key, fallback);
  if (!(allowed as readonly string[]).includes(v)) {
    throw new Error(`env ${key} must be one of ${allowed.join(' | ')}, got ${JSON.stringify(v)}`);
  }
  return v as T;
}

export function readEnv(rawSrc: EnvSource = process.env): ApiEnv {
  // `STONKZ_CHAINS_FILE` fills blank launchpad / router / program keys from
  // the deployment record; explicit env always wins (chains-file.ts).
  const src = withChainsFile(rawSrc);
  const nodeEnv = oneOf(
    src,
    'NODE_ENV',
    ['development', 'test', 'production'] as const,
    'development',
  );

  const env: ApiEnv = {
    nodeEnv,
    port: int(src, 'PORT', 8787),
    logLevel: oneOf(
      src,
      'LOG_LEVEL',
      ['debug', 'info', 'warn', 'error', 'silent'] as const,
      nodeEnv === 'test' ? 'silent' : 'info',
    ),

    databaseUrl: str(src, 'DATABASE_URL', 'postgres://stonkz:stonkz@localhost:5432/stonkz'),
    databasePoolMax: int(src, 'DATABASE_POOL_MAX', 10),

    redisUrl: str(src, 'REDIS_URL', 'redis://localhost:6379'),

    jwtSecret: str(src, 'JWT_SECRET', DEV_JWT_SECRET),
    jwtIssuer: str(src, 'JWT_ISSUER', 'https://api.ston.kz'),
    accessTokenTtlSeconds: int(src, 'ACCESS_TOKEN_TTL_SECONDS', 900),
    refreshTokenTtlSeconds: int(src, 'REFRESH_TOKEN_TTL_SECONDS', 2_592_000),
    nonceTtlSeconds: int(src, 'NONCE_TTL_SECONDS', 300),
    siwsDomain: str(src, 'SIWS_DOMAIN', 'ston.kz'),

    corsOrigins: list(src, 'CORS_ORIGINS', DEFAULT_CORS),

    trustedProxyDepth: int(src, 'TRUSTED_PROXY_DEPTH', 1),

    solanaRpcUrl: str(src, 'SOLANA_RPC_URL', 'https://api.devnet.solana.com'),
    solanaCluster: oneOf(
      src,
      'SOLANA_CLUSTER',
      ['mainnet-beta', 'devnet', 'testnet', 'localnet'] as const,
      'devnet',
    ),
    solanaSiwsChainId: (() => {
      const cluster = oneOf(
        src,
        'SOLANA_CLUSTER',
        ['mainnet-beta', 'devnet', 'testnet', 'localnet'] as const,
        'devnet',
      );
      if (cluster === 'devnet') return 'solana:devnet';
      if (cluster === 'testnet') return 'solana:testnet';
      if (cluster === 'localnet') return 'solana:localnet';
      return 'solana:mainnet';
    })(),
    // RPC and explorer defaults follow the configured chain id, which itself
    // defaults to the testnet: a bare checkout must never pair a testnet id
    // with the mainnet RPC (verifyChainId() would refuse to boot).
    rhRpcUrl: str(
      src,
      'RH_RPC_URL',
      int(src, 'RH_CHAIN_ID', RH_TESTNET_CHAIN_ID) === RH_TESTNET_CHAIN_ID
        ? RH_TESTNET_PUBLIC_RPC_URL
        : RH_PUBLIC_RPC_URL,
    ),
    rhExplorerUrl: str(
      src,
      'RH_EXPLORER_URL',
      int(src, 'RH_CHAIN_ID', RH_TESTNET_CHAIN_ID) === 46630
        ? 'https://explorer.testnet.chain.robinhood.com'
        : 'https://robinhoodchain.blockscout.com',
    ).replace(/\/$/, ''),
    rhChainId: int(src, 'RH_CHAIN_ID', RH_TESTNET_CHAIN_ID),
    allowedRhChainIds: (() => {
      const rhId = int(src, 'RH_CHAIN_ID', RH_TESTNET_CHAIN_ID);
      const baseId = int(src, 'BASE_CHAIN_ID', BASE_SEPOLIA_CHAIN_ID);
      // Arc joins the default allow-list only once something is deployed
      // there: a deployment with nothing on Arc must not accept a 5042 SIWE.
      const arcDeployed = str(src, 'ARC_LAUNCHPAD_ADDRESS', ZERO_EVM_ADDRESS) !== ZERO_EVM_ADDRESS;
      const arcId = int(src, 'ARC_CHAIN_ID', ARC_CHAIN_ID);
      const fromEnv = ints(src, 'EVM_ALLOWED_CHAIN_IDS', ints(src, 'RH_ALLOWED_CHAIN_IDS', []));
      const merged =
        fromEnv.length > 0 ? fromEnv : arcDeployed ? [rhId, baseId, arcId] : [rhId, baseId];
      return [...new Set(merged)];
    })(),
    rhNetworkLabel: str(src, 'RH_NETWORK_LABEL', 'ROBINHOOD'),
    baseRpcUrl: str(src, 'BASE_RPC_URL', BASE_SEPOLIA_RPC_URL),
    baseExplorerUrl: str(src, 'BASE_EXPLORER', BASE_SEPOLIA_EXPLORER_URL).replace(/\/$/, ''),
    baseChainId: int(src, 'BASE_CHAIN_ID', BASE_SEPOLIA_CHAIN_ID),
    baseLaunchpadAddress: str(src, 'BASE_LAUNCHPAD_ADDRESS', ZERO_EVM_ADDRESS),
    baseRouterAddress: str(src, 'BASE_ROUTER_ADDRESS', ZERO_EVM_ADDRESS),
    baseV3FeeTierOverrides: intMap(src, 'BASE_V3_FEE_TIER_OVERRIDES'),
    baseV3FactoryAddress: str(
      src,
      'BASE_V3_FACTORY_ADDRESS',
      int(src, 'BASE_CHAIN_ID', BASE_SEPOLIA_CHAIN_ID) === BASE_SEPOLIA_CHAIN_ID
        ? '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24'
        : // Uniswap v3 factory on Base mainnet (8453).
          '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
    ),
    baseV3QuoterAddress: str(src, 'BASE_V3_QUOTER_ADDRESS', ZERO_EVM_ADDRESS),
    arcRpcUrl: str(src, 'ARC_RPC_URL', ARC_RPC_URL),
    arcExplorerUrl: str(src, 'ARC_EXPLORER', ARC_EXPLORER_URL).replace(/\/$/, ''),
    arcChainId: int(src, 'ARC_CHAIN_ID', ARC_CHAIN_ID),
    arcLaunchpadAddress: str(src, 'ARC_LAUNCHPAD_ADDRESS', ZERO_EVM_ADDRESS),
    arcRouterAddress: str(src, 'ARC_ROUTER_ADDRESS', ZERO_EVM_ADDRESS),
    arcV3FeeTierOverrides: intMap(src, 'ARC_V3_FEE_TIER_OVERRIDES'),
    // No canonical Uniswap v3 factory is confirmed for Arc yet; zero means
    // "no on-chain pool hop" until an operator pins one.
    arcV3FactoryAddress: str(src, 'ARC_V3_FACTORY_ADDRESS', ZERO_EVM_ADDRESS),
    arcV3QuoterAddress: str(src, 'ARC_V3_QUOTER_ADDRESS', ZERO_EVM_ADDRESS),
    maxChainLagSeconds: int(src, 'MAX_CHAIN_LAG_SECONDS', 30),
    chainTickMs: {
      SOL: int(src, 'SOLANA_SLOT_MS', 400),
      RH: int(src, 'RH_BLOCK_MS', 2000),
      BASE: int(src, 'BASE_BLOCK_MS', 2000),
      ARC: int(src, 'ARC_BLOCK_MS', ARC_BLOCK_MS),
    },

    priceOracleUrl: str(src, 'PRICE_ORACLE_URL', 'https://api.coinbase.com/v2/prices'),
    priceOracleTtlSeconds: int(src, 'PRICE_ORACLE_TTL_SECONDS', 30),

    crateHmacSecret: str(src, 'CRATE_HMAC_SECRET', DEV_CRATE_SECRET),
    dailyXpCap: int(src, 'DAILY_XP_CAP', 25_000),
    dailySpCap: int(src, 'DAILY_SP_CAP', 25_000),
    dust: {
      SOL: float(src, 'DUST_SOL', 0.01),
      RH: float(src, 'DUST_ETH', 0.0005),
      BASE: float(src, 'DUST_BASE_ETH', float(src, 'DUST_ETH', 0.0005)),
      // USDC-denominated: the shared registry's floor, not the ETH one.
      ARC: float(src, 'DUST_ARC_USDC', DEFAULT_DUST.ARC),
    },
    whaleCut: {
      SOL: float(src, 'WHALE_SOL', 5),
      RH: float(src, 'WHALE_ETH', 2),
      BASE: float(src, 'WHALE_BASE_ETH', float(src, 'WHALE_ETH', 2)),
      ARC: float(src, 'WHALE_ARC_USDC', DEFAULT_WHALE_CUT.ARC),
    },

    quoteCacheTtlSeconds: int(src, 'QUOTE_CACHE_TTL_SECONDS', 8),

    jupiterApiBaseUrl: str(src, 'JUPITER_API_BASE_URL', 'https://lite-api.jup.ag/swap/v1'),
    jupiterApiKey: src['JUPITER_API_KEY']?.trim() || undefined,
    uniswapApiBaseUrl: str(src, 'UNISWAP_API_BASE_URL', 'https://trade-api.gateway.uniswap.org/v1'),
    uniswapApiKey: src['UNISWAP_API_KEY']?.trim() || undefined,

    solanaLaunchpadProgramId: str(
      src,
      'SOLANA_LAUNCHPAD_PROGRAM_ID',
      'FF1f3V47FtApwWWMHX462Gm7NVqNpUJ7K4yqKrYGSMbg',
    ),
    solanaLaunchAlts: (() => {
      try {
        return [
          ...new Set(list(src, 'SOLANA_LAUNCH_ALT', []).map((a) => new PublicKey(a).toBase58())),
        ];
      } catch {
        throw new Error(
          `env SOLANA_LAUNCH_ALT must be comma-separated base58 addresses, got ${JSON.stringify(src['SOLANA_LAUNCH_ALT'])}`,
        );
      }
    })(),
    rhLaunchpadAddress: str(src, 'RH_LAUNCHPAD_ADDRESS', ZERO_EVM_ADDRESS),
    rhRouterAddress: str(src, 'RH_ROUTER_ADDRESS', ZERO_EVM_ADDRESS),
    rhV3FeeTierOverrides: (() => {
      const mapped = intMap(src, 'RH_V3_FEE_TIER_OVERRIDES');
      // Testnet WETH/USDG pool is fee 3000 — pin when unset so aggregator hops
      // stay atomic on 46630 without requiring every operator to copy the pin.
      if (Object.keys(mapped).length === 0 && int(src, 'RH_CHAIN_ID', 4663) === 46630) {
        return { USDG: 3000 };
      }
      return mapped;
    })(),
    rhV3FactoryAddress: str(
      src,
      'RH_V3_FACTORY_ADDRESS',
      // Testnet factory from RobinhoodChainTestnet; mainnet from Uniswap docs.
      int(src, 'RH_CHAIN_ID', RH_CHAIN_ID) === 46630
        ? '0xdf9e3D6ffaC4513dD7b053212bbECcbCD15ec932'
        : '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA',
    ),
    rhV3QuoterAddress: str(src, 'RH_V3_QUOTER_ADDRESS', ZERO_EVM_ADDRESS),

    pythHermesUrl: src['PYTH_HERMES_URL']?.trim() || undefined,
    pythHermesApiKey: src['PYTH_HERMES_API_KEY']?.trim() || undefined,

    launchIntentTtlSeconds: int(src, 'LAUNCH_INTENT_TTL_SECONDS', 120),
    launchRateLimitPerWallet: int(src, 'LAUNCH_RATE_LIMIT_PER_WALLET', 5),
    launchRateLimitWindowSeconds: int(src, 'LAUNCH_RATE_LIMIT_WINDOW_SECONDS', 3600),

    xBearerToken: src['X_BEARER_TOKEN']?.trim() || undefined,
    xCacheTtlSeconds: int(src, 'X_CACHE_TTL_SECONDS', 6 * 3600),
    tipMaxAgeSeconds: int(src, 'TIP_MAX_AGE_SECONDS', 24 * 3600),
    publicWebOrigin: str(src, 'PUBLIC_WEB_ORIGIN', 'https://ston.kz'),

    pinataJwt: src['PINATA_JWT']?.trim() || undefined,
    pinataGateway: str(src, 'PINATA_GATEWAY', 'indigo-hollow-catfish-851.mypinata.cloud').replace(
      /^https?:\/\//,
      '',
    ),
  };

  /**
   * Staging on Railway/Vercel before any program is deployed. Secrets are
   * still required — this only skips the checks that assume a live
   * launchpad and a paid RH RPC, which we do not have yet.
   */
  const staging = str(src, 'STONKZ_STAGING', '') === '1';

  if (env.nodeEnv === 'production') {
    if (env.jwtSecret === DEV_JWT_SECRET) throw new Error('JWT_SECRET must be set in production');
    if (env.crateHmacSecret === DEV_CRATE_SECRET)
      throw new Error('CRATE_HMAC_SECRET must be set in production');
    if (env.jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
    // Atomic RH path is mandatory even on STONKZ_STAGING — never boot a
    // production image that would fall through to multi-signature EvmStep[].
    if (env.rhRouterAddress === ZERO_EVM_ADDRESS) {
      throw new Error(
        'RH_ROUTER_ADDRESS must be set in production; non-atomic RH trades are disabled',
      );
    }
    if (!staging) {
      // Robinhood documents the public endpoint as rate-limited and not for
      // production use, and a wallet render reads a balance.
      if (env.rhRpcUrl === RH_PUBLIC_RPC_URL) {
        throw new Error(
          'RH_RPC_URL must be a provider endpoint in production; the public RPC is rate-limited and unsupported',
        );
      }
      if (env.rhLaunchpadAddress === ZERO_EVM_ADDRESS) {
        throw new Error(
          'RH_LAUNCHPAD_ADDRESS must be set in production; no deployment address is checked in',
        );
      }
    }
  }

  return env;
}
