import { Hono } from 'hono';
import { RAR, crateRollMessage, type CrateTier } from '@stonkz/shared';
import { CrateError } from '../game/crates.js';
import { getCrateTables, progressionOverrideStatus } from '../game/tables.js';
import { limit, optionalAuth, requireAuth } from '../app/middleware.js';
import { RATE_LIMITS } from '../redis/ratelimit.js';
import type { AppEnv } from '../app/context.js';
import { defiLlamaClientFor, rwaUsdValues, type RwaUsdValues } from '../router/defillama.js';

function parseTier(raw: string): CrateTier | null {
  const upper = raw.toUpperCase();
  return getCrateTables().some((c) => c.k === upper) ? (upper as CrateTier) : null;
}

/**
 * On-chain claims of `$STONKZ` credits and RWA positions do not exist yet —
 * there is no rewards vault, no voucher signer and no token live on any net.
 * The API says so explicitly so the web can render "CLAIMS OPEN SOON" instead
 * of a dead button. Design: `docs/rewards-claims-design.md`.
 */
const CLAIMS = {
  open: false,
  stonkz: { open: false, reason: 'claims_open_soon' as const },
  rwa: { open: false, reason: 'claims_open_soon' as const },
};

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

    // `states` and `spLevels.snapshot` both call `sync`, which is idempotent
    // and race-safe; running them together is fine, but the snapshot is read
    // afterwards so its level block reflects any grant `sync` just applied.
    const [states, spSnap, nextCommit] = await Promise.all([
      deps.crates.states(user.net, user.wallet),
      deps.ledger
        .readBalance(user.net, user.wallet)
        .then((b) => deps.spLevels.snapshot(user.net, user.wallet, b.sp)),
      deps.crates.commitment(user.net, user.wallet),
    ]);
    const snapshot = await deps.ledger.snapshot(user.net, user.wallet);

    // USD value of RWA crate rewards, from DefiLlama. Priced only when the
    // wallet holds any; a DefiLlama outage leaves `usd: null`, never an error.
    const rwaUsd: RwaUsdValues =
      snapshot.rwa.length > 0
        ? await rwaUsdValues(defiLlamaClientFor(deps.env, deps.logger), snapshot.rwa)
        : { total: null, positions: [] };

    const globalReadyAt = states[0]?.readyAt ?? Date.now();
    const globalReady = states[0]?.ready ?? true;
    const lastTier = states[0]?.lastTier ?? null;
    const tables = getCrateTables();

    return c.json({
      net: user.net,
      wallet: user.wallet,
      xp: snapshot.xp,
      rank: snapshot.rank,
      sp: snapshot.sp,
      stonkz: snapshot.stonkz,
      rwa: snapshot.rwa,
      rwaUsd,
      claims: CLAIMS,
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
      /** sha256 of the server seed already committed for this wallet's next open. */
      nextCommit,
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
        claimed: spSnap.claimed,
        levels: spSnap.levels,
      },
      crates: states.map((state) => {
        const def = tables.find((cr) => cr.k === state.tier);
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
      tables: progressionOverrideStatus(),
    });
  });

  /**
   * Open one crate. Body (optional): `{ clientSeed, useKey }`. The client seed
   * is the wallet's half of the commit–reveal; `useKey` spends a held
   * `RHODIUM KEY · INSTANT CRATE` to bypass a running global cooldown.
   */
  app.post('/rewards/crates/:tier/open', requireAuth(), limit(RATE_LIMITS.crate), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);

    const tier = parseTier(c.req.param('tier'));
    if (!tier) return c.json({ error: 'unknown_tier' }, 404);

    const body = (await c.req.json().catch(() => ({}))) as {
      clientSeed?: unknown;
      useKey?: unknown;
    };
    const clientSeed = typeof body.clientSeed === 'string' ? body.clientSeed : undefined;
    const useKey = body.useKey === true;

    try {
      const result = await deps.crates.open(user.net, user.wallet, tier, { clientSeed, useKey });
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
        keyUsed: result.keyUsed,
        openId: result.openId,
        // Everything needed to re-derive the roll, plus the hash committed
        // for the NEXT open so the wallet can pin it before deciding.
        proof: {
          serverSeedHash: result.roll.serverSeedHash,
          serverSeed: result.roll.serverSeed,
          clientSeed: result.roll.clientSeed,
          clientSeeded: result.roll.clientSeeded,
          rollCommit: result.roll.rollCommit,
          rollValue: result.roll.rollValue,
          amountRoll: result.roll.amountRoll,
          dropIndex: result.dropIndex,
          message: crateRollMessage(user.net, user.wallet, tier, result.roll.clientSeed ?? ''),
          verifiable: true,
        },
        nextCommit: result.nextServerSeedHash,
      });
    } catch (err) {
      if (err instanceof CrateError) {
        if (err.code === 'cooling_down') {
          return c.json({ error: 'cooling_down', readyAt: err.readyAt ?? null }, 429);
        }
        if (err.code === 'no_inventory') {
          return c.json({ error: 'no_inventory', detail: err.message }, 409);
        }
        if (err.code === 'no_key') {
          return c.json({ error: 'no_key', detail: err.message }, 409);
        }
        if (err.code === 'bad_seed') {
          return c.json({ error: 'bad_seed', detail: err.message }, 400);
        }
        return c.json({ error: err.code }, 404);
      }
      throw err;
    }
  });

  /**
   * The wallet's own drop log with full commit–reveal proofs, newest first.
   * `?limit=` caps at 200. Rows opened before commit–reveal are marked
   * `verifiable: false`.
   */
  app.get('/rewards/crates/history', requireAuth(), limit(RATE_LIMITS.read), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const raw = Number.parseInt(c.req.query('limit') ?? '50', 10);
    const rows = await deps.crates.history(user.net, user.wallet, Number.isFinite(raw) ? raw : 50);
    return c.json({
      net: user.net,
      wallet: user.wallet,
      nextCommit: await deps.crates.commitment(user.net, user.wallet),
      formula:
        'digest = HMAC-SHA256(serverSeed, message); rollValue = uint64be(digest[0..8]) / 2^64 * 100; amountRoll = uint64be(digest[8..16]) / 2^64; sha256(serverSeed) must equal serverSeedHash',
      opens: rows,
    });
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
