import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { MAX_TRADE_CAP, DEFAULT_TRADE_CAP, nativeUnit } from '@stonkz/shared';
import { settings, users } from '../db/schema.js';
import { limit, requireAuth } from '../app/middleware.js';
import { RATE_LIMITS } from '../redis/ratelimit.js';
import type { AppEnv } from '../app/context.js';

function clampSetting(raw: unknown, min: number, max: number, fallback: number): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseFloat(raw) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * `GET /me` — plan steps 52 and 120.
 *
 * Hydrates the profile shell, the wallet line and the whole rewards strip in
 * one round trip: the native balance comes from that net's RPC (SOL on Solana,
 * ETH on Robinhood) and the USD figure from the oracle, which is what replaces
 * the hardcoded `$214.08` in the footer.
 */
export function meRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/me', requireAuth(), limit(RATE_LIMITS.read), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const { net, wallet } = user;
    const unit = nativeUnit(net);

    // Visiting counts as showing up; the streak is a server-UTC fact.
    await deps.ledger.touchStreak(net, wallet);
    const checkin = await deps.awards.dailyCheckin({ net, wallet });

    const [profileRow] = await deps.db
      .select()
      .from(users)
      .where(and(eq(users.net, net), eq(users.wallet, wallet)))
      .limit(1);

    const [settingsRow] = await deps.db
      .select()
      .from(settings)
      .where(and(eq(settings.net, net), eq(settings.wallet, wallet)))
      .limit(1);

    // A dead RPC or oracle must not blank the profile — the UI degrades to a
    // missing balance, not a failed page.
    const [balance, usdPrice] = await Promise.all([
      deps.rpcs[net]
        .nativeBalance(wallet)
        .then((v) => {
          deps.metrics.rpcCall(net, true);
          return v;
        })
        .catch(() => {
          deps.metrics.rpcCall(net, false);
          return null;
        }),
      deps.oracle.nativeUsd(unit).catch(() => null),
    ]);

    const snapshot = await deps.ledger.snapshot(net, wallet);
    const crates = await deps.crates.states(net, wallet);
    const referral = await deps.referrals.snapshot(net, wallet);

    return c.json({
      net,
      wallet,
      username: profileRow?.username ?? null,
      bio: profileRow?.bio ?? null,
      avatarUrl: profileRow?.avatarUrl ?? null,
      createdAt: profileRow?.createdAt.getTime() ?? null,
      native: {
        unit,
        balance,
        usdPrice,
        usdValue: balance !== null && usdPrice !== null ? balance * usdPrice : null,
      },
      xp: snapshot.xp,
      rank: snapshot.rank,
      sp: snapshot.sp,
      stonkz: snapshot.stonkz,
      rwa: snapshot.rwa,
      streak: snapshot.streak,
      streakMult: snapshot.streakMult,
      achievements: snapshot.achievements,
      crates,
      items: snapshot.items,
      dailyCheckin: checkin,
      referral: {
        code: referral.code,
        pendingNative: referral.pendingNative,
        lifetimeNative: referral.lifetimeNative,
        directReferrals: referral.directReferrals,
        referredBy: referral.referredBy,
      },
      settings: settingsRow
        ? {
            slip: settingsRow.slip,
            prio: settingsRow.prio,
            mev: settingsRow.mev,
            mevTip: settingsRow.mevTip,
            cap: settingsRow.cap,
            capUnit: nativeUnit(net),
            defBuy: settingsRow.defBuy,
            confirm: settingsRow.confirm,
          }
        : null,
    });
  });

  /**
   * Persist trade settings for the authenticated wallet so `/trade/prepare`
   * and the web UI stay aligned across devices/reloads.
   */
  app.put('/me/settings', requireAuth(), limit(RATE_LIMITS.social), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    const slip = clampSetting(body['slip'], 0.1, 50, 2.5);
    const prio = clampSetting(body['prio'], 0, 1, 0.0012);
    const mevTip = clampSetting(body['mevTip'], 0, 1, 0.0009);
    // The row is per (net, wallet), so the cap is in that net's gas unit:
    // 50 ETH is a sane ceiling, 50 USDC on Arc is not.
    const unit = nativeUnit(user.net);
    const cap = clampSetting(body['cap'], 0.001, MAX_TRADE_CAP[unit], DEFAULT_TRADE_CAP[unit]);
    const defBuy = clampSetting(body['defBuy'], 0.01, 999, 0.5);
    const mevRaw = typeof body['mev'] === 'string' ? body['mev'].toUpperCase() : 'SHIELD';
    const mev = mevRaw === 'OFF' || mevRaw === 'RELAY' || mevRaw === 'SHIELD' ? mevRaw : 'SHIELD';
    const confirm = typeof body['confirm'] === 'boolean' ? body['confirm'] : true;

    await deps.db
      .insert(settings)
      .values({
        net: user.net,
        wallet: user.wallet,
        slip,
        prio,
        mev,
        mevTip,
        cap,
        defBuy,
        confirm,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [settings.net, settings.wallet],
        set: { slip, prio, mev, mevTip, cap, defBuy, confirm, updatedAt: new Date() },
      });

    return c.json({ slip, prio, mev, mevTip, cap, defBuy, confirm });
  });

  /**
   * The footer price on its own, for the pre-connect state where there is no
   * session yet but the tape still needs a USD figure.
   */
  app.get('/native-price', limit(RATE_LIMITS.read), async (c) => {
    const deps = c.get('deps');
    const [sol, eth] = await Promise.all([
      deps.oracle.nativeUsd('SOL').catch(() => null),
      deps.oracle.nativeUsd('ETH').catch(() => null),
    ]);
    return c.json({ SOL: sol, ETH: eth });
  });

  return app;
}
