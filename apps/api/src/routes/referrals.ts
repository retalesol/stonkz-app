import { Hono } from 'hono';
import { limit, requireAuth } from '../app/middleware.js';
import { RATE_LIMITS } from '../redis/ratelimit.js';
import type { AppEnv } from '../app/context.js';
import type { ReferralPayoutMode } from '../game/referrals.js';

/**
 * Referral code attach, earnings snapshot (per tier) and claims.
 *
 * A claim is `POST /referrals/claim` with `{ payout: 'stonkz' | 'native' }`:
 *
 * - `stonkz` (default, the original behaviour): the pending commission is
 *   converted into `$STONKZ` reward credits on the spot.
 * - `native`: the pending commission is booked as a payout request in the
 *   chain's native/base asset. The money already sits in the on-chain
 *   protocol vault (the indexer credits the DB protocol treasury net of every
 *   referral cut), and only the protocol withdraw authority — a cold key the
 *   API never holds — can move it, so settlement is an operator batch
 *   (`scripts/referral-payouts.ts`) that runs `withdrawTreasury(0, …)` per
 *   request and marks the rows paid. The snapshot shows `requestedNative`
 *   until then.
 */
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

  /** Claim pending referral commission — as `$STONKZ` credits, or as a native payout request. */
  app.post('/referrals/claim', requireAuth(), limit(RATE_LIMITS.social), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const body = (await c.req.json().catch(() => ({}))) as { payout?: unknown };
    if (body.payout !== undefined && body.payout !== 'native' && body.payout !== 'stonkz') {
      return c.json({ error: 'bad_request', detail: "payout must be 'stonkz' or 'native'" }, 400);
    }
    const payout: ReferralPayoutMode = body.payout === 'native' ? 'native' : 'stonkz';
    const result = await deps.referrals.claimFees(user.net, user.wallet, payout);
    return c.json({
      ok: true,
      mode: result.mode,
      claimedNative: result.claimedNative,
      stonkz: result.stonkz,
      stonkzTotal: result.stonkzTotal,
      payoutId: result.payoutId,
      tiers: result.tiers,
    });
  });

  return app;
}
