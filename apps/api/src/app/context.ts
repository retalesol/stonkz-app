import type { Net } from '@stonkz/shared';
import type { ChainRpcs, PriceOracle } from '../chain/types.js';
import type { Db } from '../db/client.js';
import type { ApiEnv } from '../env.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import type { QuoteCache } from '../redis/quote-cache.js';
import type { RedisLike } from '../redis/types.js';
import type { AuthService } from '../auth/service.js';
import type { JwtService } from '../auth/jwt.js';
import type { GameAwards } from '../game/awards.js';
import type { CrateService } from '../game/crates.js';
import type { Ledger } from '../game/ledger.js';
import type { ReferralService } from '../game/referrals.js';
import type { SocialCapsService } from '../game/social-caps.js';
import type { SpLevelService } from '../game/sp-levels.js';
import type { Publisher } from '../ws/publisher.js';
import type { BaseMintRegistry } from '../router/base-mints.js';
import type { JupiterClient } from '../router/jupiter.js';
import type { UniswapClient } from '../router/uniswap.js';
import type { ChatService } from '../social/chat.js';
import type { XProfileCacheService } from '../social/x-cache.js';

/** Everything a route handler is allowed to reach for. Constructed once at boot. */
export interface AppDeps {
  env: ApiEnv;
  db: Db;
  redis: RedisLike;
  logger: Logger;
  metrics: Metrics;
  rpcs: ChainRpcs;
  oracle: PriceOracle;
  jwt: JwtService;
  auth: AuthService;
  quotes: QuoteCache;
  ledger: Ledger;
  awards: GameAwards;
  crates: CrateService;
  spLevels: SpLevelService;
  referrals: ReferralService;
  socialCaps: SocialCapsService;
  publisher: Publisher;
  now: () => number;

  /* -------------------------------------------------------- router (Phase 2.R/2.B) */
  jupiter: JupiterClient;
  uniswap: UniswapClient;
  baseMints: BaseMintRegistry;

  /* -------------------------------------------------------------- social (Phase 5) */
  chat: ChatService;
  xCache: XProfileCacheService;
}

/** The authenticated caller, set by `requireAuth`. */
export interface AuthedUser {
  net: Net;
  wallet: string;
  jti: string;
  sessionId: string | null;
}

export interface AppVariables {
  deps: AppDeps;
  requestId: string;
  user?: AuthedUser;
}

export type AppEnv = { Variables: AppVariables };
