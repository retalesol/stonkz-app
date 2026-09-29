import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { and, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { CRATES, type CrateTier, type Net } from '@stonkz/shared';
import { requireAdmin, audited, type AdminEnv } from '../admin/middleware.js';
import {
  bad,
  bool,
  confirmed,
  int,
  netParam,
  netQuery,
  num,
  readBody,
  str,
} from '../admin/http.js';
import {
  balanceLedger,
  balances,
  crateInventory,
  referralCodes,
  referrals,
  sessions,
  trades,
  userModeration,
  users,
} from '../db/schema.js';

/**
 * `/admin/users` — search, inspect, ban/unban, shadow-mute, reset profile
 * fields, grant/revoke SP and crates, view and revoke sessions.
 *
 * Moderators own bans and profile resets; grants (they mint value) need
 * `admin`. Every write is audited with the row before and after.
 */
const CRATE_TIERS = new Set<string>(CRATES.map((c) => c.k));

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function adminUserRoutes(): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();

  app.get('/admin/users', requireAdmin('viewer'), async (c) => {
    const deps = c.get('deps');
    const q = (c.req.query('q') ?? '').trim();
    const net = netQuery(c);
    const max = Math.min(Math.max(int(c.req.query('limit')) ?? 50, 1), 200);
    const filters = [];
    if (net) filters.push(eq(users.net, net));
    if (q) filters.push(or(ilike(users.wallet, `${q}%`), ilike(users.username, `%${q}%`)));
    const rows = await deps.db
      .select({
        net: users.net,
        wallet: users.wallet,
        username: users.username,
        avatarUrl: users.avatarUrl,
        createdAt: users.createdAt,
        xp: balances.xp,
        sp: balances.sp,
        stonkz: balances.stonkz,
        chatBanned: userModeration.chatBanned,
        launchBanned: userModeration.launchBanned,
        tradeBanned: userModeration.tradeBanned,
        commentsBanned: userModeration.commentsBanned,
        shadowMuted: userModeration.shadowMuted,
      })
      .from(users)
      .leftJoin(balances, and(eq(balances.net, users.net), eq(balances.wallet, users.wallet)))
      .leftJoin(
        userModeration,
        and(eq(userModeration.net, users.net), eq(userModeration.wallet, users.wallet)),
      )
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(users.createdAt))
      .limit(max);
    return c.json({
      users: rows.map((r) => ({
        ...r,
        createdAt: r.createdAt.getTime(),
        xp: r.xp ?? 0,
        sp: r.sp ?? 0,
        stonkz: r.stonkz ?? 0,
        chatBanned: r.chatBanned ?? false,
        launchBanned: r.launchBanned ?? false,
        tradeBanned: r.tradeBanned ?? false,
        commentsBanned: r.commentsBanned ?? false,
        shadowMuted: r.shadowMuted ?? false,
      })),
    });
  });

  app.get('/admin/users/:net/:wallet', requireAdmin('viewer'), async (c) => {
    const deps = c.get('deps');
    const net = netParam(c);
    const wallet = c.req.param('wallet');
    if (!net || !wallet) return bad(c, 'net and wallet are required');
    const key = and(eq(users.net, net), eq(users.wallet, wallet));
    const [profile] = await deps.db.select().from(users).where(key).limit(1);
    const [balance] = await deps.db
      .select()
      .from(balances)
      .where(and(eq(balances.net, net), eq(balances.wallet, wallet)))
      .limit(1);
    const ledger = await deps.db
      .select()
      .from(balanceLedger)
      .where(and(eq(balanceLedger.net, net), eq(balanceLedger.wallet, wallet)))
      .orderBy(desc(balanceLedger.id))
      .limit(50);
    const crates = await deps.db
      .select({ tier: crateInventory.tier, count: crateInventory.count })
      .from(crateInventory)
      .where(and(eq(crateInventory.net, net), eq(crateInventory.wallet, wallet)));
    const [code] = await deps.db
      .select()
      .from(referralCodes)
      .where(and(eq(referralCodes.net, net), eq(referralCodes.wallet, wallet)))
      .limit(1);
    const [referredBy] = await deps.db
      .select()
      .from(referrals)
      .where(and(eq(referrals.net, net), eq(referrals.referee, wallet)))
      .limit(1);
    const [refCount] = await deps.db
      .select({ n: sql<number>`count(*)::int` })
      .from(referrals)
      .where(and(eq(referrals.net, net), eq(referrals.referrer, wallet)));
    const liveSessions = await deps.db
      .select({
        id: sessions.id,
        issuedAt: sessions.issuedAt,
        expiresAt: sessions.expiresAt,
        userAgent: sessions.userAgent,
        ip: sessions.ip,
      })
      .from(sessions)
      .where(and(eq(sessions.net, net), eq(sessions.wallet, wallet), isNull(sessions.revokedAt)))
      .orderBy(desc(sessions.issuedAt))
      .limit(50);
    const [tradeAgg] = await deps.db
      .select({
        n: sql<number>`count(*)::int`,
        usd: sql<number>`coalesce(sum(${trades.usdValue}), 0)::float8`,
      })
      .from(trades)
      .where(and(eq(trades.net, net), eq(trades.trader, wallet)));
    const moderation = await deps.admin.gate.state(net, wallet);
    const spLevel = await deps.spLevels.sync(net, wallet, balance?.sp ?? 0).catch(() => null);

    return c.json({
      net,
      wallet,
      profile: profile
        ? {
            ...profile,
            createdAt: profile.createdAt.getTime(),
            updatedAt: profile.updatedAt.getTime(),
          }
        : null,
      balances: { xp: balance?.xp ?? 0, sp: balance?.sp ?? 0, stonkz: balance?.stonkz ?? 0 },
      spLevel: spLevel?.level ?? null,
      ledger: ledger.map((l) => ({ ...l, createdAt: l.createdAt.getTime() })),
      crates,
      referrals: {
        code: code?.code ?? null,
        referrer: referredBy?.referrer ?? null,
        referred: refCount?.n ?? 0,
      },
      trades: { count: tradeAgg?.n ?? 0, volumeUsd: Number(tradeAgg?.usd ?? 0) },
      sessions: liveSessions.map((s) => ({
        ...s,
        issuedAt: s.issuedAt.getTime(),
        expiresAt: s.expiresAt.getTime(),
      })),
      moderation,
    });
  });

  /* ------------------------------------------------------------ moderation */

  app.put('/admin/users/:net/:wallet/moderation', requireAdmin('moderator'), async (c) => {
    const deps = c.get('deps');
    const net = netParam(c);
    const wallet = c.req.param('wallet');
    if (!net || !wallet) return bad(c, 'net and wallet are required');
    const body = await readBody(c);
    const reason = str(body['reason'], 500);
    if (!reason) return bad(c, 'reason is required');
    const before = await deps.admin.gate.state(net, wallet);
    const untilMs = num(body['untilMs']);
    const patch = {
      chatBanned: bool(body['chatBanned']) ?? before.chatBanned,
      commentsBanned: bool(body['commentsBanned']) ?? before.commentsBanned,
      launchBanned: bool(body['launchBanned']) ?? before.launchBanned,
      tradeBanned: bool(body['tradeBanned']) ?? before.tradeBanned,
      shadowMuted: bool(body['shadowMuted']) ?? before.shadowMuted,
      reason,
      until: untilMs === undefined ? null : new Date(untilMs),
      updatedBy: c.get('admin').address,
      updatedAt: new Date(deps.now()),
    };
    await deps.db
      .insert(userModeration)
      .values({ net, wallet, ...patch })
      .onConflictDoUpdate({ target: [userModeration.net, userModeration.wallet], set: patch });
    await deps.admin.gate.invalidate(net, wallet);
    const after = await deps.admin.gate.state(net, wallet);
    await audited(c, 'user.moderation', `${net}:${wallet}`, before, after);
    return c.json({ ok: true, before, after });
  });

  app.post('/admin/users/:net/:wallet/reset-profile', requireAdmin('moderator'), async (c) => {
    const deps = c.get('deps');
    const net = netParam(c);
    const wallet = c.req.param('wallet');
    if (!net || !wallet) return bad(c, 'net and wallet are required');
    const body = await readBody(c);
    const reason = str(body['reason'], 500);
    if (!reason) return bad(c, 'reason is required');
    const resetUsername = bool(body['username']) === true;
    const resetAvatar = bool(body['avatar']) === true;
    const resetBio = bool(body['bio']) === true;
    if (!resetUsername && !resetAvatar && !resetBio) return bad(c, 'nothing to reset');
    const key = and(eq(users.net, net), eq(users.wallet, wallet));
    const [before] = await deps.db.select().from(users).where(key).limit(1);
    if (!before) return bad(c, 'no such user', 404);
    const patch: Partial<typeof users.$inferInsert> = { updatedAt: new Date(deps.now()) };
    if (resetUsername) patch.username = null;
    if (resetAvatar) patch.avatarUrl = null;
    if (resetBio) patch.bio = null;
    await deps.db.update(users).set(patch).where(key);
    const [after] = await deps.db.select().from(users).where(key).limit(1);
    await audited(
      c,
      'user.reset_profile',
      `${net}:${wallet}`,
      { username: before.username, avatarUrl: before.avatarUrl, bio: before.bio },
      {
        username: after?.username ?? null,
        avatarUrl: after?.avatarUrl ?? null,
        bio: after?.bio ?? null,
        reason,
      },
    );
    return c.json({ ok: true });
  });

  /* ---------------------------------------------------------------- grants */

  app.post('/admin/users/:net/:wallet/grant', requireAdmin('admin'), async (c) => {
    const deps = c.get('deps');
    const net = netParam(c);
    const wallet = c.req.param('wallet');
    if (!net || !wallet) return bad(c, 'net and wallet are required');
    const body = await readBody(c);
    const reason = str(body['reason'], 500);
    if (!reason) return bad(c, 'reason is required');
    const asset = str(body['asset'], 16);
    const delta = int(body['delta']);
    if (delta === undefined || delta === 0 || Math.abs(delta) > 10_000_000)
      return bad(c, 'delta must be a non-zero integer');
    const actor = c.get('admin').address;
    const now = deps.now();

    if (asset === 'SP') {
      const [row] = await deps.db
        .select()
        .from(balances)
        .where(and(eq(balances.net, net), eq(balances.wallet, wallet)))
        .limit(1);
      const before = row?.sp ?? 0;
      const after = Math.max(0, before + delta);
      await deps.db
        .insert(balances)
        .values({ net, wallet, sp: after, updatedAt: new Date(now) })
        .onConflictDoUpdate({
          target: [balances.wallet, balances.net],
          set: { sp: after, updatedAt: new Date(now) },
        });
      await deps.db.insert(balanceLedger).values({
        wallet,
        net,
        asset: 'SP',
        delta: after - before,
        balanceAfter: after,
        reason: delta > 0 ? 'admin:grant' : 'admin:revoke',
        refType: 'admin',
        // `balance_ledger_ref_uq` is unique per (wallet, net, asset, ref); each grant is its own ref.
        refId: `${actor}@${now}:${randomBytes(4).toString('hex')}`,
        dayUtc: utcDay(now),
        createdAt: new Date(now),
      });
      if (after > before) await deps.spLevels.sync(net, wallet, after).catch(() => null);
      await deps.publisher.user(net, wallet, {
        type: 'sp',
        net,
        wallet,
        delta: after - before,
        total: after,
      });
      await audited(c, 'user.grant_sp', `${net}:${wallet}`, { sp: before }, { sp: after, reason });
      return c.json({ ok: true, before, after });
    }

    if (asset === 'CRATE') {
      const tier = str(body['tier'], 16);
      if (!tier || !CRATE_TIERS.has(tier))
        return bad(c, `tier must be one of ${[...CRATE_TIERS].join(', ')}`);
      const [row] = await deps.db
        .select()
        .from(crateInventory)
        .where(
          and(
            eq(crateInventory.net, net),
            eq(crateInventory.wallet, wallet),
            eq(crateInventory.tier, tier),
          ),
        )
        .limit(1);
      const before = row?.count ?? 0;
      const after = Math.max(0, before + delta);
      await deps.db
        .insert(crateInventory)
        .values({ net, wallet, tier: tier as CrateTier, count: after, updatedAt: new Date(now) })
        .onConflictDoUpdate({
          target: [crateInventory.wallet, crateInventory.net, crateInventory.tier],
          set: { count: after, updatedAt: new Date(now) },
        });
      if (after > before) {
        await deps.publisher.user(net, wallet, { type: 'crate_ready', net, wallet, tier });
      }
      await audited(
        c,
        'user.grant_crate',
        `${net}:${wallet}`,
        { tier, count: before },
        { tier, count: after, reason },
      );
      return c.json({ ok: true, before, after });
    }

    return bad(c, 'asset must be SP or CRATE');
  });

  /* -------------------------------------------------------------- sessions */

  app.post('/admin/users/:net/:wallet/sessions/revoke', requireAdmin('moderator'), async (c) => {
    const deps = c.get('deps');
    const net = netParam(c);
    const wallet = c.req.param('wallet');
    if (!net || !wallet) return bad(c, 'net and wallet are required');
    const body = await readBody(c);
    if (!confirmed(body, `REVOKE ${wallet.slice(0, 6)}`))
      return bad(c, `confirm with "REVOKE ${wallet.slice(0, 6)}"`);
    const sessionId = str(body['sessionId'], 64);
    const where = sessionId
      ? and(
          eq(sessions.net, net),
          eq(sessions.wallet, wallet),
          eq(sessions.id, sessionId),
          isNull(sessions.revokedAt),
        )
      : and(eq(sessions.net, net), eq(sessions.wallet, wallet), isNull(sessions.revokedAt));
    const revoked = await deps.db
      .update(sessions)
      .set({ revokedAt: new Date(deps.now()) })
      .where(where)
      .returning({ id: sessions.id });
    await audited(
      c,
      'user.revoke_sessions',
      `${net}:${wallet}`,
      { live: revoked.length },
      { revoked: revoked.map((r) => r.id) },
    );
    return c.json({
      ok: true,
      revoked: revoked.length,
      note: 'access tokens already issued expire within their TTL (15 min)',
    });
  });

  return app;
}

export type { Net };
