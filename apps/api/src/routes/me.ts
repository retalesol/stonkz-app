import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { nativeUnit } from '@stonkz/shared';
import { settings, users } from '../db/schema.js';
import { requireAuth } from '../app/middleware.js';
import type { AppEnv } from '../app/context.js';

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

  app.get('/me', requireAuth(), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const { net, wallet } = user;
    const unit = nativeUnit(net);

    // Visiting counts as showing up; the streak is a server-UTC fact.
    await deps.ledger.touchStreak(net, wallet);

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

    return c.json({
      net,
      wallet,
      username: profileRow?.username ?? null,
      bio: profileRow?.bio ?? null,
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
      optionz: snapshot.optionz,
      streak: snapshot.streak,
      streakMult: snapshot.streakMult,
      achievements: snapshot.achievements,
      crates,
      items: snapshot.items,
      settings: settingsRow
        ? {
            slip: settingsRow.slip,
            prio: settingsRow.prio,
            mev: settingsRow.mev,
            mevTip: settingsRow.mevTip,
            cap: settingsRow.cap,
            defBuy: settingsRow.defBuy,
            confirm: settingsRow.confirm,
          }
        : null,
    });
  });

  /**
   * The footer price on its own, for the pre-connect state where there is no
   * session yet but the tape still needs a USD figure.
   */
  app.get('/native-price', async (c) => {
    const deps = c.get('deps');
    const [sol, eth] = await Promise.all([
      deps.oracle.nativeUsd('SOL').catch(() => null),
      deps.oracle.nativeUsd('ETH').catch(() => null),
    ]);
    return c.json({ SOL: sol, ETH: eth });
  });

  return app;
}
