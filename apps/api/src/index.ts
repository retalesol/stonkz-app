/**
 * `@stonkz/api` — REST + WS, auth, persistence and the game ledger.
 *
 * This module is the package's public surface. `apps/indexer` imports from it
 * (schema, ingest targets, the ledger and the publisher) so there is exactly
 * one definition of the database and one code path that writes to it.
 *
 * The runnable service is `src/server.ts`, not this file.
 */

export { createApp } from './app/create.js';
export { buildDeps, type BuiltDeps, type DepsOverrides } from './app/deps.js';
export type { AppDeps, AppEnv, AppVariables, AuthedUser } from './app/context.js';
export { API_CSP, cors, securityHeaders } from './app/security.js';
export { limit, optionalAuth, requireAuth, requestLogger, withDeps } from './app/middleware.js';

export { readEnv, type ApiEnv, type EnvSource } from './env.js';

export { createDb, schema, type Db, type DbHandle } from './db/client.js';
export * as tables from './db/schema.js';
export {
  listAppliedMigrations,
  migrationsFolder,
  readMigrations,
  runMigrations,
  type MigrateResult,
} from './db/migrate.js';
export { isCheckViolation, isUniqueViolation, sqlStateOf } from './db/errors.js';
export { rowsOf } from './db/rows.js';

export { JwtService, hashRefreshToken, type StonkzClaims, type TokenPair } from './auth/jwt.js';
export { AuthError, AuthService, type LoginResult, type NonceChallenge } from './auth/service.js';
export { buildSignInMessage, parseSignInMessage, SIWS_STATEMENT } from './auth/message.js';
export { isSolanaAddress, verifySiws } from './auth/siws.js';
export { isEvmAddress, recoverSiweAddress, toChecksumAddress, verifySiwe } from './auth/siwe.js';

export { EvmRpc } from './chain/evm.js';
export { SolanaRpc } from './chain/solana.js';
export { CachedPriceOracle, HttpPriceOracle } from './chain/oracle.js';
export { FakeChainRpc, FakePriceOracle, createFakeRpcs } from './chain/fake.js';
export type { ChainRpc, ChainRpcs, FetchLike, PriceOracle } from './chain/types.js';

export { createLogger, redact, type Logger, type LogLevel } from './observability/logger.js';
export { Metrics, loggingAlertHook, type Alert, type ChainLag, type MetricsSnapshot } from './observability/metrics.js';

export { createRedis, IoRedis } from './redis/ioredis.js';
export { MemoryRedis } from './redis/memory.js';
export { CHANNELS, CHANNEL_PATTERNS } from './redis/channels.js';
export type { BoardEvent, TapeEvent, TokenEvent, UserEvent } from './redis/channels.js';
export { QuoteCache, quoteCacheKey, QUOTE_CACHE_TTL_SECONDS } from './redis/quote-cache.js';
export { RATE_LIMITS, rateLimit } from './redis/ratelimit.js';
export type { RedisLike } from './redis/types.js';

export { Ledger, UnverifiedEventError, type AwardInput, type AwardResult, type RewardsSnapshot } from './game/ledger.js';
export { GameAwards, type TradeEvent as TradeAwardEvent } from './game/awards.js';
export { CrateError, CrateService, type CrateOpenResult } from './game/crates.js';
export { REASONS, requiresVerifiedEvent, DEFAULT_DUST, DEFAULT_WHALE_CUT } from './game/rules.js';
export { daysBetween, previousUtcDay, utcDayKey } from './game/day.js';

export { Publisher } from './ws/publisher.js';
export { WsHub } from './ws/hub.js';

export { serialiseToken, type SerialisedToken, type TokenRow } from './routes/serialise.js';

export { verifyTip, minTipFor, type TipRejectionReason, type TipVerification } from './social/tips.js';
export { ChatService, CHAT_MAX_LEN, CHAT_RATE_LIMIT, isFlagged, normaliseRoom } from './social/chat.js';
export { XProfileCacheService, type CachedXProfile } from './social/x-cache.js';
export { HttpXProvider, PlaceholderXProvider, type XProfile, type XProvider } from './social/x-provider.js';
export type { NativeTransferSource, NativeTransferVerification } from './chain/types.js';
