import { eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { isEvm, parseNet, type Net } from '@stonkz/shared';
import { parseSignInMessage } from '../auth/message.js';
import { AuthError } from '../auth/service.js';
import { authNonces } from '../db/schema.js';
import { limit, requireAuth } from '../app/middleware.js';
import { resolveClientIp } from '../net/client-ip.js';
import { RATE_LIMITS } from '../redis/ratelimit.js';
import type { AppEnv } from '../app/context.js';

const STATUS: Record<AuthError['code'], 400 | 401 | 409> = {
  bad_address: 400,
  bad_nonce: 400,
  nonce_expired: 401,
  nonce_used: 409,
  net_mismatch: 400,
  message_mismatch: 400,
  bad_signature: 401,
  // A client-supplied chain id this deployment does not accept.
  chain_mismatch: 400,
  session_revoked: 401,
  bad_token: 401,
};

interface LoginBody {
  address?: unknown;
  message?: unknown;
  signature?: unknown;
}

/**
 * Phase 1.B. `GET /auth/nonce` issues a single-use challenge bound to a net;
 * `POST /auth/siws` and `POST /auth/siwe` verify it. Both mint the same token
 * pair — only the signature scheme differs.
 */
export function authRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('/auth/*', limit(RATE_LIMITS.auth));

  app.get('/auth/nonce', async (c) => {
    const net = parseNet(c.req.query('net'));
    if (!net) return c.json({ error: 'bad_request', detail: 'net must be SOL, RH, or BASE' }, 400);
    const address = c.req.query('address');
    const challenge = await c.get('deps').auth.issueNonce(net, address);
    return c.json(challenge);
  });

  const login = async (c: Context<AppEnv>, net: Net, bodyIn?: LoginBody) => {
    const deps = c.get('deps');
    let body: LoginBody;
    if (bodyIn) {
      body = bodyIn;
    } else {
      try {
        body = (await c.req.json()) as LoginBody;
      } catch {
        return c.json({ error: 'bad_request', detail: 'body must be JSON' }, 400);
      }
    }
    const { address, message, signature } = body;
    if (typeof address !== 'string' || typeof message !== 'string' || typeof signature !== 'string') {
      return c.json({ error: 'bad_request', detail: 'address, message and signature are required' }, 400);
    }

    try {
      const result = await deps.auth.login({
        net,
        address,
        message,
        signature,
        userAgent: c.req.header('User-Agent'),
        // Only the trusted-proxy-depth hop, never the client-controllable
        // left end of the header — see M1 in docs/security-review-findings.md.
        ip: resolveClientIp(c.req.header('X-Forwarded-For'), deps.env.trustedProxyDepth) ?? undefined,
      });
      // First sight of a wallet still starts its streak, so the multiplier is
      // right on the very first trade of the session.
      await deps.ledger.touchStreak(result.net, result.wallet);
      return c.json({
        net: result.net,
        wallet: result.wallet,
        created: result.created,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        accessExpiresAt: result.accessExpiresAt,
        refreshExpiresAt: result.refreshExpiresAt,
      });
    } catch (err) {
      if (err instanceof AuthError) {
        deps.logger.warn('auth rejected', { code: err.code, net });
        return c.json({ error: err.code, detail: err.message }, STATUS[err.code]);
      }
      throw err;
    }
  };

  /** Sign-In With Solana. */
  app.post('/auth/siws', (c) => login(c, 'SOL'));

  /** Sign-In With Ethereum — net is read from the nonce row (RH or BASE). */
  app.post('/auth/siwe', async (c) => {
    let body: LoginBody;
    try {
      body = (await c.req.json()) as LoginBody;
    } catch {
      return c.json({ error: 'bad_request', detail: 'body must be JSON' }, 400);
    }
    if (typeof body.message !== 'string') {
      return c.json({ error: 'bad_request', detail: 'message is required' }, 400);
    }
    const parsed = parseSignInMessage(body.message);
    if (!parsed) return c.json({ error: 'bad_request', detail: 'unparseable sign-in message' }, 400);
    const deps = c.get('deps');
    const [nonceRow] = await deps.db.select().from(authNonces).where(eq(authNonces.nonce, parsed.nonce)).limit(1);
    const nonceNet = parseNet(nonceRow?.net);
    if (!nonceRow || !nonceNet || !isEvm(nonceNet)) {
      return c.json({ error: 'bad_nonce', detail: 'unknown or non-EVM nonce' }, 400);
    }
    return login(c, nonceNet, body);
  });

  app.post('/auth/refresh', async (c) => {
    const deps = c.get('deps');
    let body: { refreshToken?: unknown };
    try {
      body = (await c.req.json()) as { refreshToken?: unknown };
    } catch {
      return c.json({ error: 'bad_request' }, 400);
    }
    if (typeof body.refreshToken !== 'string') {
      return c.json({ error: 'bad_request', detail: 'refreshToken is required' }, 400);
    }
    try {
      const result = await deps.auth.refresh(body.refreshToken);
      return c.json({
        net: result.net,
        wallet: result.wallet,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        accessExpiresAt: result.accessExpiresAt,
        refreshExpiresAt: result.refreshExpiresAt,
      });
    } catch (err) {
      if (err instanceof AuthError) return c.json({ error: err.code, detail: err.message }, STATUS[err.code]);
      throw err;
    }
  });

  app.post('/auth/logout', requireAuth(), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (user) await deps.auth.logout(user.jti, user.sessionId);
    return c.json({ ok: true });
  });

  return app;
}
