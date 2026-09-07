import type { Net } from '@stonkz/shared';

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

  solanaRpcUrl: string;
  rhRpcUrl: string;
  rhChainId: number;
  rhNetworkLabel: string;
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
}

/** The dev fallbacks. Booting production on either of these is fatal. */
export const DEV_JWT_SECRET = 'dev-only-insecure-secret-change-me-0000000000';
export const DEV_CRATE_SECRET = 'dev-only-crate-secret-change-me-000000000000';

const DEFAULT_CORS = [
  'https://ston.kz',
  'https://www.ston.kz',
  'http://localhost:5173',
  'http://localhost:4173',
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
  if (!Number.isFinite(n)) throw new Error(`env ${key} must be an integer, got ${JSON.stringify(raw)}`);
  return n;
}

function float(src: EnvSource, key: string, fallback: number): number {
  const raw = src[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) throw new Error(`env ${key} must be a number, got ${JSON.stringify(raw)}`);
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

function oneOf<T extends string>(src: EnvSource, key: string, allowed: readonly T[], fallback: T): T {
  const v = str(src, key, fallback);
  if (!(allowed as readonly string[]).includes(v)) {
    throw new Error(`env ${key} must be one of ${allowed.join(' | ')}, got ${JSON.stringify(v)}`);
  }
  return v as T;
}

export function readEnv(src: EnvSource = process.env): ApiEnv {
  const nodeEnv = oneOf(src, 'NODE_ENV', ['development', 'test', 'production'] as const, 'development');

  const env: ApiEnv = {
    nodeEnv,
    port: int(src, 'PORT', 8787),
    logLevel: oneOf(src, 'LOG_LEVEL', ['debug', 'info', 'warn', 'error', 'silent'] as const, nodeEnv === 'test' ? 'silent' : 'info'),

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

    solanaRpcUrl: str(src, 'SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com'),
    rhRpcUrl: str(src, 'RH_RPC_URL', 'http://localhost:8545'),
    rhChainId: int(src, 'RH_CHAIN_ID', 1),
    rhNetworkLabel: str(src, 'RH_NETWORK_LABEL', 'ROBINHOOD'),
    maxChainLagSeconds: int(src, 'MAX_CHAIN_LAG_SECONDS', 30),
    chainTickMs: {
      SOL: int(src, 'SOLANA_SLOT_MS', 400),
      RH: int(src, 'RH_BLOCK_MS', 2000),
    },

    priceOracleUrl: str(src, 'PRICE_ORACLE_URL', 'https://api.coinbase.com/v2/prices'),
    priceOracleTtlSeconds: int(src, 'PRICE_ORACLE_TTL_SECONDS', 30),

    crateHmacSecret: str(src, 'CRATE_HMAC_SECRET', DEV_CRATE_SECRET),
    dailyXpCap: int(src, 'DAILY_XP_CAP', 25_000),
    dailySpCap: int(src, 'DAILY_SP_CAP', 25_000),
    dust: {
      SOL: float(src, 'DUST_SOL', 0.01),
      RH: float(src, 'DUST_ETH', 0.0005),
    },
    whaleCut: {
      SOL: float(src, 'WHALE_SOL', 5),
      RH: float(src, 'WHALE_ETH', 2),
    },

    quoteCacheTtlSeconds: int(src, 'QUOTE_CACHE_TTL_SECONDS', 8),
  };

  if (env.nodeEnv === 'production') {
    if (env.jwtSecret === DEV_JWT_SECRET) throw new Error('JWT_SECRET must be set in production');
    if (env.crateHmacSecret === DEV_CRATE_SECRET) throw new Error('CRATE_HMAC_SECRET must be set in production');
    if (env.jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
  }

  return env;
}
