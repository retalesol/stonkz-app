import { Hono } from 'hono';
import { limit, requireAuth } from '../app/middleware.js';
import { RATE_LIMITS } from '../redis/ratelimit.js';
import type { AppEnv } from '../app/context.js';

/** Referral code attach + earnings snapshot. */
export function referralRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/referrals', requireAuth(), limit(RATE_LIMITS.read), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const snap = await deps.referrals.snapshot(user.net, user.wallet);
    return c.json({ net: user.net, wallet: user.wallet, ...snap });
  });

  app.post('/referrals/attach', requireAuth(), limit(RATE_LIMITS.social), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const body = (await c.req.json().catch(() => ({}))) as { code?: string };
    const code = String(body.code ?? '').trim();
    if (!code) return c.json({ error: 'invalid_code' }, 400);

    const result = await deps.referrals.attach(user.net, user.wallet, code);
    if (!result.ok) {
      const status =
        result.error === 'unknown_code' || result.error === 'invalid_code'
          ? 404
          : result.error === 'already_referred'
            ? 409
            : 400;
      return c.json({ error: result.error }, status);
    }
    return c.json({ ok: true, referrer: result.referrer });
  });

  /** Convert pending referral fee native → `$STONKZ` reward credits. */
  app.post('/referrals/claim', requireAuth(), limit(RATE_LIMITS.social), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const result = await deps.referrals.claimFees(user.net, user.wallet);
    return c.json({
      ok: true,
      claimedNative: result.claimedNative,
      stonkz: result.stonkz,
      stonkzTotal: result.stonkzTotal,
    });
  });

  return app;
}
