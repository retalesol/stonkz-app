import { Hono } from 'hono';
import { and, count, eq } from 'drizzle-orm';
import type { Net } from '@stonkz/shared';
import { follows, users, wallPosts } from '../db/schema.js';
import { isUniqueViolation } from '../db/errors.js';
import { optionalAuth, requireAuth, limit } from '../app/middleware.js';
import { RATE_LIMITS } from '../redis/ratelimit.js';
import type { AppEnv } from '../app/context.js';
import { minTipFor, verifyTip } from '../social/tips.js';

/**
 * Phase 5.A — plan steps 143-150.
 *
 * `users`, `follows` and `wall_posts` back every route here. Nothing about a
 * profile that another wallet can see is ever taken from the request body —
 * `PATCH /me` is the only writer of `users`, and a tip has to clear
 * `verifyTip()` before `POST /wall/:net/:addr` inserts anything.
 */

const USERNAME_MAX = 22;
const BIO_MAX = 160;

function parseNet(raw: string | undefined): Net | null {
  return raw === 'SOL' || raw === 'RH' ? raw : null;
}

function isValidUsername(v: string): boolean {
  return /^[A-Za-z0-9_]{1,22}$/.test(v);
}

export function socialRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  /** Plan step 144 — profile edits. Extends `GET /me` (routes/me.ts) with the write side. */
  app.patch('/me', requireAuth(), limit(RATE_LIMITS.social), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const { net, wallet } = user;

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: Partial<typeof users.$inferInsert> = {};

    if ('username' in body) {
      const v = String(body['username'] ?? '').trim();
      if (v.length === 0) {
        patch.username = null;
      } else {
        if (v.length > USERNAME_MAX || !isValidUsername(v)) {
          return c.json({ error: 'bad_request', detail: `username must be 1-${USERNAME_MAX} letters, numbers or _` }, 400);
        }
        patch.username = v;
      }
    }
    if ('bio' in body) {
      const v = String(body['bio'] ?? '');
      if (v.length > BIO_MAX) return c.json({ error: 'bad_request', detail: `bio must be at most ${BIO_MAX} chars` }, 400);
      patch.bio = v;
    }
    if ('avatarUrl' in body) patch.avatarUrl = body['avatarUrl'] ? String(body['avatarUrl']).slice(0, 2048) : null;
    if ('xHandle' in body) patch.xHandle = body['xHandle'] ? String(body['xHandle']).replace(/^@/, '').slice(0, 64) : null;
    if ('website' in body) patch.website = body['website'] ? String(body['website']).slice(0, 2048) : null;
    if ('telegram' in body) patch.telegram = body['telegram'] ? String(body['telegram']).slice(0, 64) : null;

    if (Object.keys(patch).length === 0) return c.json({ error: 'bad_request', detail: 'no fields to update' }, 400);

    try {
      await deps.db
        .insert(users)
        .values({ net, wallet, ...patch, updatedAt: new Date(deps.now()) })
        .onConflictDoUpdate({ target: [users.net, users.wallet], set: { ...patch, updatedAt: new Date(deps.now()) } });
    } catch (err) {
      if (isUniqueViolation(err)) return c.json({ error: 'username_taken' }, 409);
      throw err;
    }

    const [row] = await deps.db.select().from(users).where(and(eq(users.net, net), eq(users.wallet, wallet))).limit(1);
    return c.json({ net, wallet, profile: row ? serialiseUser(row) : null });
  });

  /** Plan step 144 — resolve any address to a public member. */
  app.get('/users/:net/:addr', optionalAuth(), limit(RATE_LIMITS.read), async (c) => {
    const deps = c.get('deps');
    const net = parseNet(c.req.param('net'));
    const addr = c.req.param('addr');
    if (!net || !addr) return c.json({ error: 'bad_request' }, 400);

    const [profileRow, followerCountRow, followingCountRow, snapshot] = await Promise.all([
      deps.db.select().from(users).where(and(eq(users.net, net), eq(users.wallet, addr))).limit(1),
      deps.db.select({ n: count() }).from(follows).where(and(eq(follows.net, net), eq(follows.followee, addr))),
      deps.db.select({ n: count() }).from(follows).where(and(eq(follows.net, net), eq(follows.follower, addr))),
      deps.ledger.snapshot(net, addr),
    ]);

    const caller = c.get('user');
    let isFollowing = false;
    if (caller && caller.net === net) {
      const [row] = await deps.db
        .select({ n: count() })
        .from(follows)
        .where(and(eq(follows.net, net), eq(follows.follower, caller.wallet), eq(follows.followee, addr)));
      isFollowing = (row?.n ?? 0) > 0;
    }

    return c.json({
      net,
      addr,
      profile: profileRow[0] ? serialiseUser(profileRow[0]) : null,
      followers: followerCountRow[0]?.n ?? 0,
      following: followingCountRow[0]?.n ?? 0,
      isFollowing,
      xp: snapshot.xp,
      rank: snapshot.rank,
    });
  });

  /** Plan steps 144/149 — `toggleFollow`. XP and the `social` achievement land through `GameAwards.follow`. */
  app.post('/follow/:net/:addr', requireAuth(), limit(RATE_LIMITS.social), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const net = parseNet(c.req.param('net'));
    const target = c.req.param('addr');
    if (!net || !target) return c.json({ error: 'bad_request' }, 400);
    if (net !== user.net) return c.json({ error: 'net_mismatch' }, 400);
    if (target === user.wallet) return c.json({ error: 'cannot_follow_self' }, 400);

    const inserted = await deps.db
      .insert(follows)
      .values({ net, follower: user.wallet, followee: target })
      .onConflictDoNothing()
      .returning({ net: follows.net });

    if (inserted.length > 0) await deps.awards.follow({ net, wallet: user.wallet, target });

    return c.json({ net, addr: target, following: true });
  });

  app.delete('/follow/:net/:addr', requireAuth(), limit(RATE_LIMITS.social), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const net = parseNet(c.req.param('net'));
    const target = c.req.param('addr');
    if (!net || !target) return c.json({ error: 'bad_request' }, 400);
    if (net !== user.net) return c.json({ error: 'net_mismatch' }, 400);

    await deps.db
      .delete(follows)
      .where(and(eq(follows.net, net), eq(follows.follower, user.wallet), eq(follows.followee, target)));

    return c.json({ net, addr: target, following: false });
  });

  /** Plan step 147 — the wall's backscroll. */
  app.get('/wall/:net/:addr', limit(RATE_LIMITS.read), async (c) => {
    const deps = c.get('deps');
    const net = parseNet(c.req.param('net'));
    const addr = c.req.param('addr');
    if (!net || !addr) return c.json({ error: 'bad_request' }, 400);

    const rows = await deps.db
      .select()
      .from(wallPosts)
      .where(and(eq(wallPosts.net, net), eq(wallPosts.toWallet, addr)))
      .orderBy(wallPosts.id);

    return c.json({
      net,
      addr,
      minTip: minTipFor(net),
      posts: rows.map((r) => ({
        from: r.fromWallet,
        text: r.text,
        tip: r.tipNative,
        sig: r.tipTxSig,
        createdAtMs: r.createdAt.getTime(),
      })),
    });
  });

  /**
   * Plan step 147-150 — tip verified against the chain, then the post lands.
   * `verifyTip` is the whole point: the request body's claimed amount is
   * never trusted, only what `getNativeTransfer` reads back from the RPC.
   */
  app.post('/wall/:net/:addr', requireAuth(), limit(RATE_LIMITS.wall), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const net = parseNet(c.req.param('net'));
    const target = c.req.param('addr');
    if (!net || !target) return c.json({ error: 'bad_request' }, 400);
    if (net !== user.net) return c.json({ error: 'net_mismatch' }, 400);

    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown; tipTxSig?: unknown };
    const text = String(body.text ?? '').trim();
    const tipTxSig = String(body.tipTxSig ?? '').trim();
    if (!text || text.length > 140) return c.json({ error: 'bad_request', detail: 'text must be 1-140 chars' }, 400);
    if (!tipTxSig) return c.json({ error: 'bad_request', detail: 'tipTxSig is required' }, 400);

    const verification = await verifyTip({
      rpc: deps.rpcs[net],
      net,
      signature: tipTxSig,
      fromWallet: user.wallet,
      toWallet: target,
      nowMs: deps.now(),
      maxAgeMs: deps.env.tipMaxAgeSeconds * 1000,
    });
    if (!verification.ok) return c.json({ error: 'tip_rejected', reason: verification.reason }, 422);

    let inserted: { id: number; createdAt: Date } | undefined;
    try {
      [inserted] = await deps.db
        .insert(wallPosts)
        .values({
          net,
          toWallet: target,
          fromWallet: user.wallet,
          text,
          tipNative: verification.amountNative ?? 0,
          tipTxSig,
        })
        .returning({ id: wallPosts.id, createdAt: wallPosts.createdAt });
    } catch (err) {
      if (isUniqueViolation(err)) return c.json({ error: 'signature_already_used' }, 409);
      throw err;
    }
    if (!inserted) throw new Error('wall_posts insert returned no row');

    const award = await deps.awards.wallPost({ net, wallet: user.wallet, target, tipSig: tipTxSig });

    return c.json({
      net,
      addr: target,
      post: {
        from: user.wallet,
        text,
        tip: verification.amountNative ?? 0,
        sig: tipTxSig,
        createdAtMs: inserted.createdAt.getTime(),
      },
      xpAwarded: award.xp,
    });
  });

  return app;
}

function serialiseUser(row: typeof users.$inferSelect): {
  username: string | null;
  bio: string | null;
  avatarUrl: string | null;
  xHandle: string | null;
  website: string | null;
  telegram: string | null;
  createdAtMs: number;
} {
  return {
    username: row.username,
    bio: row.bio,
    avatarUrl: row.avatarUrl,
    xHandle: row.xHandle,
    website: row.website,
    telegram: row.telegram,
    createdAtMs: row.createdAt.getTime(),
  };
}
