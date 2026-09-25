import { randomBytes } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { isTokenBlacklisted } from '../redis/blacklist.js';
import { resolveClientIp } from '../net/client-ip.js';
import { rateLimit, type RateLimitRule } from '../redis/ratelimit.js';
import { redact } from '../observability/logger.js';
import type { AppDeps, AppEnv } from './context.js';

/** Injects the dependency container and a request id. */
export function withDeps(deps: AppDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set('deps', deps);
    const inbound = c.req.header('X-Request-Id');
    c.set('requestId', inbound && inbound.length <= 64 ? inbound : randomBytes(8).toString('hex'));
    await next();
  };
}

/** One structured line per request, plus the latency/status counters. */
export function requestLogger(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const deps = c.get('deps');
    const started = deps.now();
    deps.metrics.requestStarted();
    let thrown: unknown = null;
    try {
      await next();
    } catch (err) {
      thrown = err;
      throw err;
    } finally {
      const durationMs = deps.now() - started;
      const status = thrown ? 500 : c.res.status;
      deps.metrics.requestFinished(status, durationMs);
      const fields = {
        requestId: c.get('requestId'),
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        status,
        durationMs,
        net: c.get('user')?.net,
        wallet: c.get('user')?.wallet,
        // Never the token itself.
        auth: redact(c.req.header('Authorization')?.replace(/^Bearer\s+/i, '') ?? null),
      };
      if (thrown) deps.logger.error('request failed', { ...fields, err: String(thrown) });
      else if (status >= 500) deps.logger.error('request', fields);
      else if (status >= 400) deps.logger.warn('request', fields);
      else deps.logger.info('request', fields);
    }
  };
}

/**
 * Per-IP identity used before a wallet is authenticated. Only trusts the
 * fixed number of `X-Forwarded-For` hops this deployment's edge proxy is
 * known to append (`deps.env.trustedProxyDepth`, see `net/client-ip.ts`) —
 * never the raw, client-controllable left end of the header. Without this,
 * a client can bypass every per-IP limit below by prepending a fresh fake
 * entry on every request (`docs/security-review-findings.md` M1).
 */
function clientIdentity(c: Parameters<MiddlewareHandler<AppEnv>>[0], deps: AppDeps): string {
  const user = c.get('user');
  if (user) return `w:${user.net}:${user.wallet}`;
  const ip = resolveClientIp(c.req.header('X-Forwarded-For'), deps.env.trustedProxyDepth);
  return `ip:${ip ?? 'unknown'}`;
}

/** Per-IP before auth, per-wallet after — whichever is known at this point. */
export function limit(rule: RateLimitRule): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const deps = c.get('deps');
    const verdict = await rateLimit(
      deps.redis,
      rule,
      clientIdentity(c, deps),
      Math.floor(deps.now() / 1000),
    );
    c.header('X-RateLimit-Limit', String(verdict.limit));
    c.header('X-RateLimit-Remaining', String(verdict.remaining));
    if (!verdict.ok) {
      c.header('Retry-After', String(verdict.resetSeconds));
      return c.json({ error: 'rate_limited', retryAfter: verdict.resetSeconds }, 429);
    }
    await next();
    return undefined;
  };
}

/**
 * Requires a live access token. Checks the Redis deny-list too, so a logout
 * takes effect immediately instead of at token expiry.
 */
export function requireAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const deps = c.get('deps');
    const header = c.req.header('Authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match?.[1]) return c.json({ error: 'unauthorized' }, 401);

    try {
      const claims = await deps.jwt.verify(match[1], 'access');
      if (await isTokenBlacklisted(deps.redis, claims.jti)) {
        return c.json({ error: 'token_revoked' }, 401);
      }
      c.set('user', {
        net: claims.net,
        wallet: claims.sub,
        jti: claims.jti,
        sessionId: claims.sid ?? null,
      });
    } catch {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
    return undefined;
  };
}

/** Attaches the user when a token is present but does not demand one. */
export function optionalAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const deps = c.get('deps');
    const match = /^Bearer\s+(.+)$/i.exec(c.req.header('Authorization') ?? '');
    if (match?.[1]) {
      try {
        const claims = await deps.jwt.verify(match[1], 'access');
        if (!(await isTokenBlacklisted(deps.redis, claims.jti))) {
          c.set('user', {
            net: claims.net,
            wallet: claims.sub,
            jti: claims.jti,
            sessionId: claims.sid ?? null,
          });
        }
      } catch {
        // An expired token on a public route is not an error.
      }
    }
    await next();
  };
}
