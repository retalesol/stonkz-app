import { Hono, type Context } from 'hono';
import type { Net } from '@stonkz/shared';
import { AuthError } from '../auth/service.js';
import { limit, requireAuth } from '../app/middleware.js';
import { RATE_LIMITS } from '../redis/ratelimit.js';
import type { AppEnv } from '../app/context.js';

function parseNet(raw: string | undefined): Net | null {
  return raw === 'SOL' || raw === 'RH' ? raw : null;
}

const STATUS: Record<AuthError['code'], 400 | 401 | 409> = {
  bad_address: 400,
  bad_nonce: 400,
  nonce_expired: 401,
  nonce_used: 409,
  net_mismatch: 400,
  message_mismatch: 400,
  bad_signature: 401,
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
    if (!net) return c.json({ error: 'bad_request', detail: 'net must be SOL or RH' }, 400);
    const address = c.req.query('address');
    const challenge = await c.get('deps').auth.issueNonce(net, address);
    return c.json(challenge);
  });

  const login = async (c: Context<AppEnv>, net: Net) => {
    const deps = c.get('deps');
    let body: LoginBody;
    try {
      body = (await c.req.json()) as LoginBody;
    } catch {
      return c.json({ error: 'bad_request', detail: 'body must be JSON' }, 400);
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
        ip: c.req.header('X-Forwarded-For')?.split(',')[0]?.trim(),
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

  /** Sign-In With Ethereum, for the Robinhood net. */
  app.post('/auth/siwe', (c) => login(c, 'RH'));

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
