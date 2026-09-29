import { Hono } from 'hono';
import { CRATES, RAR, type CrateTier } from '@stonkz/shared';
import { CrateError } from '../game/crates.js';
import { limit, optionalAuth, requireAuth } from '../app/middleware.js';
import { RATE_LIMITS } from '../redis/ratelimit.js';
import type { AppEnv } from '../app/context.js';
import { defiLlamaClientFor, rwaUsdValues, type RwaUsdValues } from '../router/defillama.js';

function parseTier(raw: string): CrateTier | null {
  const upper = raw.toUpperCase();
  return CRATES.some((c) => c.k === upper) ? (upper as CrateTier) : null;
}

/** Plan step 120 — `GET /rewards`, `POST /rewards/crates/:tier/open`, `GET /achievements`. */
export function rewardsRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  /**
   * Crate definitions with cooldown state, the drop tables, XP and rank.
   *
   * The drop tables are public — they are the advertised odds — but every roll
   * happens server-side, so publishing them gives a client nothing.
   */
  app.get('/rewards', requireAuth(), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);

    await deps.awards.dailyCheckin({ net: user.net, wallet: user.wallet });

    const [snapshot, states, spSnap] = await Promise.all([
      deps.ledger.snapshot(user.net, user.wallet),
      deps.crates.states(user.net, user.wallet),
      deps.ledger
        .readBalance(user.net, user.wallet)
        .then((b) => deps.spLevels.snapshot(user.net, user.wallet, b.sp)),
    ]);

    // USD value of RWA crate rewards, from DefiLlama. Priced only when the
    // wallet holds any; a DefiLlama outage leaves `usd: null`, never an error.
    const rwaUsd: RwaUsdValues =
      snapshot.rwa.length > 0
        ? await rwaUsdValues(defiLlamaClientFor(deps.env, deps.logger), snapshot.rwa)
        : { total: null, positions: [] };

    const globalReadyAt = states[0]?.readyAt ?? Date.now();
    const globalReady = states[0]?.ready ?? true;
    const lastTier = states[0]?.lastTier ?? null;

    return c.json({
      net: user.net,
      wallet: user.wallet,
      xp: snapshot.xp,
      rank: snapshot.rank,
      sp: snapshot.sp,
      stonkz: snapshot.stonkz,
      rwa: snapshot.rwa,
      rwaUsd,
      streak: snapshot.streak,
      streakMult: snapshot.streakMult,
      achievementCount: snapshot.achievements.length,
      achievements: snapshot.achievements,
      cratesReady: states.filter((s) => s.openable).length,
      globalCooldown: {
        readyAt: globalReadyAt,
        ready: globalReady,
        lastTier,
      },
      spLevel: {
        level: spSnap.level.level,
        sp: spSnap.level.sp,
        cur: spSnap.level.cur,
        next: spSnap.level.next,
        pct: spSnap.level.pct,
        toNext: spSnap.level.toNext,
        nextLevel: spSnap.nextLevel,
        newlyClaimed: spSnap.newlyClaimed,
        granted: spSnap.granted,
      },
      crates: states.map((state) => {
        const def = CRATES.find((cr) => cr.k === state.tier);
        return {
          ...state,
          drops: (def?.drops ?? []).map((d, i) => ({
            rarity: (RAR[i] as (typeof RAR)[number])[0],
            rarityClass: (RAR[i] as (typeof RAR)[number])[1],
            odds: d[0],
            kind:
              d[1] === 'S'
                ? ('STONKZ' as const)
                : d[1] === 'R'
                  ? ('RWA' as const)
                  : ('ITEM' as const),
            // `S` rows range over `$STONKZ`, `R` rows over asset units.
            min: d[1] === 'S' ? d[2] : d[1] === 'R' ? d[3] : null,
            max: d[1] === 'S' ? d[3] : d[1] === 'R' ? d[4] : null,
            asset: d[1] === 'R' ? d[2] : null,
            item: d[1] === 'I' ? d[2] : null,
          })),
        };
      }),
      dropLog: snapshot.dropLog,
      items: snapshot.items,
    });
  });

  app.post('/rewards/crates/:tier/open', requireAuth(), limit(RATE_LIMITS.crate), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);

    const tier = parseTier(c.req.param('tier'));
    if (!tier) return c.json({ error: 'unknown_tier' }, 404);

    try {
      const result = await deps.crates.open(user.net, user.wallet, tier);
      return c.json({
        tier: result.tier,
        kind: result.kind,
        amount: result.amount,
        asset: result.asset,
        units: result.units,
        item: result.item,
        rarity: result.rarity,
        label: result.label,
        dropIndex: result.dropIndex,
        stonkz: result.stonkz,
        stonkzTotal: result.stonkzTotal,
        rwa: result.rwa,
        xp: result.xp,
        rankedUp: result.rankedUp,
        readyAt: result.readyAt,
        cooldownHours: result.cooldownHours,
        inventoryLeft: result.inventoryLeft,
        // The commitment is returned so an open can be checked later; the
        // secret behind it never leaves the server.
        proof: {
          rollCommit: result.roll.rollCommit,
          serverSeedHash: result.roll.serverSeedHash,
          nonce: result.roll.clientNonce,
        },
      });
    } catch (err) {
      if (err instanceof CrateError) {
        if (err.code === 'cooling_down') {
          return c.json({ error: 'cooling_down', readyAt: err.readyAt ?? null }, 429);
        }
        if (err.code === 'no_inventory') {
          return c.json({ error: 'no_inventory', detail: err.message }, 409);
        }
        return c.json({ error: err.code }, 404);
      }
      throw err;
    }
  });

  /** Definitions always; unlock timestamps when there is a session. */
  app.get('/achievements', optionalAuth(), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    const net = user?.net ?? 'SOL';
    const list = await deps.ledger.achievementList(net, user?.wallet ?? null);
    return c.json({
      net: user?.net ?? null,
      unlocked: list.filter((a) => a.unlockedAt !== null).length,
      total: list.length,
      achievements: list,
    });
  });

  return app;
}
