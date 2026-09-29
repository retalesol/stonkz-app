import type { EthCaller } from '../auth/siwe.js';
import type { Db } from '../db/client.js';
import type { ApiEnv } from '../env.js';
import type { Logger } from '../observability/logger.js';
import type { RedisLike } from '../redis/types.js';
import { AuditLog } from './audit.js';
import { ModerationGate } from './moderation-gate.js';
import { parseAdminWallets } from './roles.js';
import { AdminAuthService } from './service.js';
import { PlatformSettings } from './settings.js';
import { AdminTokenService } from './token.js';

/**
 * Everything the admin panel adds to the dependency container, built once in
 * `app/deps.ts` and reached as `deps.admin.*`. Kept as one object so the
 * shared `AppDeps` interface grows by a single field.
 */
export interface AdminServices {
  auth: AdminAuthService;
  tokens: AdminTokenService;
  audit: AuditLog;
  settings: PlatformSettings;
  gate: ModerationGate;
}

export async function buildAdminServices(input: {
  env: ApiEnv;
  db: Db;
  redis: RedisLike;
  logger: Logger;
  now: () => number;
  ethCaller?: EthCaller | undefined;
}): Promise<AdminServices> {
  const { env, db, redis, logger, now } = input;
  const onError = (err: unknown): void => logger.warn('admin service error', { err: String(err) });

  const tokens = new AdminTokenService(
    { secret: env.adminJwtSecret, issuer: env.jwtIssuer, ttlSeconds: env.adminTokenTtlSeconds },
    redis,
    now,
  );
  const auth = new AdminAuthService({
    db,
    redis,
    tokens,
    envOwners: parseAdminWallets(env.adminWallets),
    domain: env.siwsDomain,
    adminSecret: env.adminJwtSecret,
    challengeTtlSeconds: env.adminChallengeTtlSeconds,
    ...(input.ethCaller ? { ethCaller: input.ethCaller } : {}),
    now,
  });
  const audit = new AuditLog(db, now);
  const settings = new PlatformSettings({ db, redis, env, now, onError });
  const gate = new ModerationGate({ db, redis, now, onError });
  await settings.start();
  await gate.start();
  return { auth, tokens, audit, settings, gate };
}

export type { AdminActor, AdminEnv } from './middleware.js';
export { requireAdmin, audited } from './middleware.js';
export { gate, notHiddenFilter, kothOverrides } from './moderation-gate.js';
