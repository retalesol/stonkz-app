import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { and, count, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { isEvm, nativeUnit, parseNet, type Net } from '@stonkz/shared';
import { follows, tokens, users, wallLikes, wallPosts } from '../db/schema.js';
import { isUniqueViolation } from '../db/errors.js';
import { optionalAuth, requireAuth, limit } from '../app/middleware.js';
import { RATE_LIMITS } from '../redis/ratelimit.js';
import { gate } from '../admin/index.js';
import type { AppDeps, AppEnv } from '../app/context.js';
import { minTipFor, verifyTip } from '../social/tips.js';
import { isFlagged } from '../social/chat.js';
import {
  ACTIVITY_MAX,
  FOLLOW_PAGE_MAX,
  IDENTITY_BATCH_MAX,
  canSeePrivate,
  checkProfilePatch,
  costBasisFor,
  followList,
  friendsOf,
  holdingsFromTrades,
  identitiesFor,
  PRICED_TOKEN_COLS,
  recentActivity,
  sameWallet,
  serialiseUser,
  stakedSummary,
  tokenPriceUsd,
  withCostBasis,
  type RawHolding,
} from '../social/profile.js';
import { SolanaRpc } from '../chain/solana.js';
import { asErc20BalanceSource } from '../chain/types.js';
import { serialiseToken } from './serialise.js';
import { LiveBaseUsd } from './live-base-usd.js';
import { MAX_IMAGE_BYTES, PinataError, uploadToPinata } from '../social/pinata.js';
import { sanitizeName } from './launch-validate.js';

/**
 * Multipart ceiling for image uploads: the image itself plus form overhead.
 * Enforced on the stream, so an oversized body is refused before it is
 * buffered into memory rather than after.
 */
const imageBodyLimit = bodyLimit({
  maxSize: MAX_IMAGE_BYTES + 64 * 1024,
  onError: (c) =>
    c.json(
      { error: 'too_large', detail: `image must be at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB` },
      413,
    ),
});

/** Reads the multipart `file` field and uploads it; a response on refusal. */
async function uploadImageField(
  c: Context<AppEnv>,
  name: string,
  fallbackFilename: string,
): Promise<
  { ok: true; uploaded: Awaited<ReturnType<typeof uploadToPinata>> } | { ok: false; res: Response }
> {
  const deps = c.get('deps');
  const body = await c.req.parseBody().catch(() => null);
  const file = body?.['file'];
  if (!file || typeof file === 'string') {
    return {
      ok: false,
      res: c.json({ error: 'bad_request', detail: 'multipart file field is required' }, 400),
    };
  }
  const blob = file as File;
  try {
    const uploaded = await uploadToPinata({
      jwt: deps.env.pinataJwt,
      gateway: deps.env.pinataGateway,
      bytes: new Uint8Array(await blob.arrayBuffer()),
      mimeType: blob.type || 'application/octet-stream',
      filename: blob.name || fallbackFilename,
      name,
    });
    return { ok: true, uploaded };
  } catch (err) {
    if (err instanceof PinataError) {
      if (err.upstream) deps.logger.warn('pinata upload failed', { upstream: err.upstream });
      const status =
        err.code === 'not_configured'
          ? 503
          : err.code === 'upload_failed'
            ? 502
            : err.code === 'too_large'
              ? 413
              : 415;
      return { ok: false, res: c.json({ error: err.code, detail: err.message }, status) };
    }
    throw err;
  }
}

/**
 * Phase 5.A — plan steps 143-150.
 *
 * `users`, `follows` and `wall_posts` back every route here. Nothing about a
 * profile that another wallet can see is ever taken from the request body —
 * `PATCH /me` is the only writer of `users`, and a tip has to clear
 * `verifyTip()` before `POST /wall/:net/:addr` inserts anything.
 *
 * Privacy (0023): `users.private` hides portfolio, PnL, recent actions, wall
 * and follow lists from everyone but the owner. The decision is
 * `social/profile.ts`'s `canSeePrivate`, applied on every read route below;
 * identity fields and created tokens (on-chain attribution) stay public.
 *
 * `GET /users/:net/:key` accepts a wallet **or** a username and returns
 * on-chain native balance + Stonkz-token holdings when the RPC can answer,
 * with the indexer's `trades` as the fallback — never simulated flavour.
 */

const WALL_TEXT_MAX = 140;

/** Wallet-shaped keys are looked up by address; otherwise treat as username. */
function looksLikeWallet(key: string, net: Net): boolean {
  if (net === 'SOL') return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(key);
  return /^0x[a-fA-F0-9]{40}$/.test(key);
}

interface Resolved {
  wallet: string;
  profileRow: typeof users.$inferSelect | null;
  /** False when a non-wallet key matched no username anywhere. */
  found: boolean;
}

async function resolveWallet(deps: AppDeps, net: Net, key: string): Promise<Resolved> {
  if (looksLikeWallet(key, net)) {
    const [byWallet] = await deps.db
      .select()
      .from(users)
      .where(
        and(
          eq(users.net, net),
          isEvm(net) ? sql`lower(${users.wallet}) = ${key.toLowerCase()}` : eq(users.wallet, key),
        ),
      )
      .limit(1);
    // The stored spelling wins (sessions store checksummed EVM wallets).
    return { wallet: byWallet?.wallet ?? key, profileRow: byWallet ?? null, found: true };
  }
  const [byName] = await deps.db
    .select()
    .from(users)
    .where(and(eq(users.net, net), sql`lower(${users.username}) = lower(${key})`))
    .limit(1);
  if (byName) return { wallet: byName.wallet, profileRow: byName, found: true };
  // Username is globally unique — fall back across nets so `/u/Mememan` works
  // even if the client defaulted to the wrong net.
  const [anyNet] = await deps.db
    .select()
    .from(users)
    .where(sql`lower(${users.username}) = lower(${key})`)
    .limit(1);
  if (anyNet) return { wallet: anyNet.wallet, profileRow: anyNet, found: true };
  return { wallet: key, profileRow: null, found: false };
}

/** The member a public route is about, or the 400/404 that stops it. */
async function resolveMember(
  c: Context<AppEnv>,
): Promise<
  | { ok: true; net: Net; wallet: string; profileRow: Resolved['profileRow']; key: string }
  | { ok: false; res: Response }
> {
  const deps = c.get('deps');
  const net = parseNet(c.req.param('net'));
  const key = c.req.param('addr');
  if (!net || !key) return { ok: false, res: c.json({ error: 'bad_request' }, 400) };
  const resolved = await resolveWallet(deps, net, key);
  if (!resolved.found) return { ok: false, res: c.json({ error: 'user_not_found' }, 404) };
  const memberNet = (resolved.profileRow?.net as Net | undefined) ?? net;
  return {
    ok: true,
    net: memberNet,
    wallet: resolved.wallet,
    profileRow: resolved.profileRow,
    key,
  };
}

function pageOpts(c: Context<AppEnv>, max: number): { before: number | null; limit: number } {
  const beforeRaw = Number(c.req.query('before'));
  const limitRaw = Number(c.req.query('limit'));
  return {
    before: Number.isFinite(beforeRaw) && beforeRaw > 0 ? beforeRaw : null,
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(max, Math.floor(limitRaw)) : 30,
  };
}

/**
 * On-chain token balances for mints we know about (launchpad tokens).
 * SOL: SPL token accounts. EVM: ERC-20 `balanceOf` on *that* net's RPC.
 * `null` when the RPC cannot answer so the caller can fall back to trades.
 */
async function holdingsOnChain(
  deps: AppDeps,
  net: Net,
  wallet: string,
): Promise<RawHolding[] | null> {
  const known = await deps.db
    .select({
      sym: tokens.sym,
      mint: tokens.mint,
      tokenDecimals: tokens.tokenDecimals,
      ...PRICED_TOKEN_COLS,
    })
    .from(tokens)
    .where(eq(tokens.net, net));
  if (!known.length) return [];
  const prices = new LiveBaseUsd(deps);

  if (net === 'SOL') {
    const rpc = deps.rpcs.SOL;
    if (!(rpc instanceof SolanaRpc)) return null;
    try {
      const byMint = await rpc.splTokenBalances(wallet);
      const out: RawHolding[] = [];
      for (const t of known) {
        if (!t.mint) continue;
        const bal = byMint.get(t.mint) ?? 0;
        if (bal <= 0) continue;
        out.push({
          sym: t.sym,
          mint: t.mint,
          tok: bal,
          priceUsd: await tokenPriceUsd(prices, t),
        });
      }
      return out;
    } catch {
      return null;
    }
  }

  const erc20 = asErc20BalanceSource(deps.rpcs[net]);
  if (!erc20) return null;
  try {
    const out: RawHolding[] = [];
    for (const t of known) {
      if (!t.mint || !t.mint.startsWith('0x')) continue;
      const atoms = await erc20.erc20BalanceAtoms(t.mint, wallet);
      if (atoms <= 0n) continue;
      const tok = Number(atoms) / 10 ** t.tokenDecimals;
      if (!Number.isFinite(tok) || tok <= 0) continue;
      out.push({ sym: t.sym, mint: t.mint, tok, priceUsd: await tokenPriceUsd(prices, t) });
    }
    return out;
  } catch {
    return null;
  }
}

function privateRefusal(c: Context<AppEnv>): Response {
  return c.json({ error: 'private_profile', detail: 'this profile is private' }, 403);
}

export function socialRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  /**
   * Plan step 144 — profile edits. Extends `GET /me` (routes/me.ts) with the
   * write side. Field-level validation lives in `social/profile.ts`; a
   * refusal names the field so the dialog can show it inline.
   */
  app.patch('/me', requireAuth(), limit(RATE_LIMITS.social), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const { net, wallet } = user;

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return c.json({ error: 'bad_request', detail: 'json object expected' }, 400);
    const checked = checkProfilePatch(body);
    if (!checked.ok)
      return c.json({ error: 'bad_request', field: checked.field, detail: checked.detail }, 400);
    const patch = checked.patch;
    if (Object.keys(patch).length === 0)
      return c.json({ error: 'bad_request', detail: 'no fields to update' }, 400);

    try {
      await deps.db
        .insert(users)
        .values({ net, wallet, ...patch, updatedAt: new Date(deps.now()) })
        .onConflictDoUpdate({
          target: [users.net, users.wallet],
          set: { ...patch, updatedAt: new Date(deps.now()) },
        });
    } catch (err) {
      if (isUniqueViolation(err))
        return c.json(
          { error: 'username_taken', field: 'username', detail: 'that username is taken' },
          409,
        );
      throw err;
    }

    const [row] = await deps.db
      .select()
      .from(users)
      .where(and(eq(users.net, net), eq(users.wallet, wallet)))
      .limit(1);
    return c.json({ net, wallet, profile: row ? serialiseUser(row) : null });
  });

  /**
   * Upload a profile picture to Pinata and persist the gateway URL on `users`.
   * Multipart field name: `file`. JWT never leaves the API.
   */
  app.post('/me/avatar', requireAuth(), limit(RATE_LIMITS.avatar), imageBodyLimit, async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const { net, wallet } = user;

    const result = await uploadImageField(c, 'stonkz-avatar', 'avatar.png');
    if (!result.ok) return result.res;
    const { uploaded } = result;
    await deps.db
      .insert(users)
      .values({ net, wallet, avatarUrl: uploaded.url, updatedAt: new Date(deps.now()) })
      .onConflictDoUpdate({
        target: [users.net, users.wallet],
        set: { avatarUrl: uploaded.url, updatedAt: new Date(deps.now()) },
      });
    const [row] = await deps.db
      .select()
      .from(users)
      .where(and(eq(users.net, net), eq(users.wallet, wallet)))
      .limit(1);
    return c.json({
      net,
      wallet,
      avatarUrl: uploaded.url,
      cid: uploaded.cid,
      profile: row ? serialiseUser(row) : null,
    });
  });

  /**
   * Upload a launch / generic image to Pinata. Returns the gateway URL only —
   * does not touch the user profile. Multipart field: `file`.
   */
  app.post(
    '/uploads/image',
    requireAuth(),
    limit(RATE_LIMITS.avatar),
    imageBodyLimit,
    async (c) => {
      const user = c.get('user');
      if (!user) return c.json({ error: 'unauthorized' }, 401);
      const result = await uploadImageField(c, 'stonkz-token', 'token.png');
      if (!result.ok) return result.res;
      const { uploaded } = result;
      return c.json({
        url: uploaded.url,
        cid: uploaded.cid,
        mimeType: uploaded.mimeType,
        size: uploaded.size,
      });
    },
  );

  /**
   * Public identity for a batch of wallets — what a holders table, a board
   * card's creator label or a chat backscroll needs to swap addresses for
   * usernames. `?wallets=a,b,c`, at most 100. Never returns private data.
   */
  app.get('/identities/:net', limit(RATE_LIMITS.read), async (c) => {
    const deps = c.get('deps');
    const net = parseNet(c.req.param('net'));
    if (!net) return c.json({ error: 'bad_request' }, 400);
    const wallets = (c.req.query('wallets') ?? '')
      .split(',')
      .map((w) => w.trim())
      .filter((w) => w.length > 0 && w.length <= 64);
    if (wallets.length > IDENTITY_BATCH_MAX)
      return c.json({ error: 'bad_request', detail: `at most ${IDENTITY_BATCH_MAX} wallets` }, 400);
    return c.json({ net, identities: await identitiesFor(deps, net, wallets) });
  });

  /** Public member card — wallet or username. On-chain balance + holdings when possible. */
  app.get('/users/:net/:addr', optionalAuth(), limit(RATE_LIMITS.read), async (c) => {
    const deps = c.get('deps');
    const netParam = parseNet(c.req.param('net'));
    const key = c.req.param('addr');
    if (!netParam || !key) return c.json({ error: 'bad_request' }, 400);

    const resolved = await resolveWallet(deps, netParam, key);
    if (!resolved.found) return c.json({ error: 'user_not_found' }, 404);
    const { wallet, profileRow } = resolved;
    const memberNet = (profileRow?.net as Net | undefined) ?? netParam;
    const caller = c.get('user');
    const own =
      !!caller && caller.net === memberNet && sameWallet(memberNet, caller.wallet, wallet);
    const visible = canSeePrivate(caller, memberNet, wallet, profileRow);

    const [followerCountRow, followingCountRow, snapshot, launchedRows] = await Promise.all([
      deps.db
        .select({ n: count() })
        .from(follows)
        .where(and(eq(follows.net, memberNet), eq(follows.followee, wallet))),
      deps.db
        .select({ n: count() })
        .from(follows)
        .where(and(eq(follows.net, memberNet), eq(follows.follower, wallet))),
      deps.ledger.snapshot(memberNet, wallet),
      deps.db
        .select()
        .from(tokens)
        .where(and(eq(tokens.net, memberNet), eq(tokens.creator, wallet)))
        .orderBy(sql`${tokens.launchedAt} desc`)
        .limit(40),
    ]);

    let isFollowing = false;
    let followsYou = false;
    if (caller && caller.net === memberNet && !own) {
      const [out, back] = await Promise.all([
        deps.db
          .select({ n: count() })
          .from(follows)
          .where(
            and(
              eq(follows.net, memberNet),
              eq(follows.follower, caller.wallet),
              eq(follows.followee, wallet),
            ),
          ),
        deps.db
          .select({ n: count() })
          .from(follows)
          .where(
            and(
              eq(follows.net, memberNet),
              eq(follows.follower, wallet),
              eq(follows.followee, caller.wallet),
            ),
          ),
      ]);
      isFollowing = (out[0]?.n ?? 0) > 0;
      followsYou = (back[0]?.n ?? 0) > 0;
    }

    const now = deps.now();
    const prices = new LiveBaseUsd(deps);
    const curveParams = await deps.params.all();
    const launched = await Promise.all(
      launchedRows.map(async (r) =>
        serialiseToken(r, now, { baseUsd: await prices.liveForRow(r) }, curveParams[r.net as Net]),
      ),
    );
    const base = {
      net: memberNet,
      addr: wallet,
      resolvedFrom: key === wallet ? 'wallet' : 'username',
      profile: profileRow ? serialiseUser(profileRow) : null,
      private: !!profileRow?.private,
      own,
      isFollowing,
      followsYou,
      xp: snapshot.xp,
      rank: snapshot.rank,
      launched,
    };

    if (!visible) {
      // Redacted card: identity + created tokens only. Counts, balances,
      // holdings, staking and follow lists are the owner's.
      return c.json({
        ...base,
        followers: null,
        following: null,
        followingWallets: [],
        native: { unit: nativeUnit(memberNet), balance: null },
        portfolioUsd: null,
        holdings: [],
        holdingsSource: 'private',
        staked: [],
      });
    }

    const [followingRows, nativeBalance, onChainHoldings, basis, staked] = await Promise.all([
      deps.db
        .select({ followee: follows.followee })
        .from(follows)
        .where(and(eq(follows.net, memberNet), eq(follows.follower, wallet)))
        .orderBy(desc(follows.createdAt))
        .limit(24),
      deps.rpcs[memberNet]
        .nativeBalance(wallet)
        .then((v) => {
          deps.metrics.rpcCall(memberNet, true);
          return v;
        })
        .catch(() => {
          deps.metrics.rpcCall(memberNet, false);
          return null as number | null;
        }),
      holdingsOnChain(deps, memberNet, wallet),
      costBasisFor(deps, memberNet, wallet).catch(() => new Map()),
      stakedSummary(deps, memberNet, wallet).catch(() => []),
    ]);

    const raw =
      onChainHoldings ??
      (await holdingsFromTrades(deps, memberNet, basis).catch(() => [] as RawHolding[]));
    const holdings = withCostBasis(raw, basis);
    const holdingsSource = onChainHoldings ? 'chain' : 'index';
    const portfolioUsd = holdings.reduce((s, h) => s + h.value, 0);
    const realisedUsd = [...basis.values()].reduce((s, b) => s + b.realisedUsd, 0);
    const unrealisedUsd = holdings.reduce((s, h) => s + (h.pnlUsd ?? 0), 0);

    return c.json({
      ...base,
      followers: followerCountRow[0]?.n ?? 0,
      following: followingCountRow[0]?.n ?? 0,
      followingWallets: followingRows.map((r) => r.followee),
      native: { unit: nativeUnit(memberNet), balance: nativeBalance },
      portfolioUsd,
      pnl: { unrealisedUsd, realisedUsd },
      holdings,
      holdingsSource,
      staked,
    });
  });

  /** Recent actions — newest first, `?before=<ms>&limit=`. Owner-only on a private profile. */
  app.get('/users/:net/:addr/activity', optionalAuth(), limit(RATE_LIMITS.read), async (c) => {
    const deps = c.get('deps');
    const m = await resolveMember(c);
    if (!m.ok) return m.res;
    if (!canSeePrivate(c.get('user'), m.net, m.wallet, m.profileRow)) return privateRefusal(c);
    const page = await recentActivity(deps, m.net, m.wallet, pageOpts(c, ACTIVITY_MAX));
    return c.json({ net: m.net, addr: m.wallet, ...page });
  });

  for (const direction of ['followers', 'following'] as const) {
    app.get(
      `/users/:net/:addr/${direction}`,
      optionalAuth(),
      limit(RATE_LIMITS.read),
      async (c) => {
        const deps = c.get('deps');
        const m = await resolveMember(c);
        if (!m.ok) return m.res;
        if (!canSeePrivate(c.get('user'), m.net, m.wallet, m.profileRow)) return privateRefusal(c);
        const page = await followList(
          deps,
          m.net,
          m.wallet,
          direction,
          pageOpts(c, FOLLOW_PAGE_MAX),
        );
        return c.json({ net: m.net, addr: m.wallet, direction, ...page });
      },
    );
  }

  /** Mutual follows. Owner-only on a private profile. */
  app.get('/users/:net/:addr/friends', optionalAuth(), limit(RATE_LIMITS.read), async (c) => {
    const deps = c.get('deps');
    const m = await resolveMember(c);
    if (!m.ok) return m.res;
    if (!canSeePrivate(c.get('user'), m.net, m.wallet, m.profileRow)) return privateRefusal(c);
    const entries = await friendsOf(deps, m.net, m.wallet, pageOpts(c, FOLLOW_PAGE_MAX).limit);
    return c.json({ net: m.net, addr: m.wallet, entries });
  });

  /** Plan steps 144/149 — `toggleFollow`. XP and the `social` achievement land through `GameAwards.follow`. */
  app.post('/follow/:net/:addr', requireAuth(), limit(RATE_LIMITS.social), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const net = parseNet(c.req.param('net'));
    const key = c.req.param('addr');
    if (!net || !key) return c.json({ error: 'bad_request' }, 400);
    if (net !== user.net) return c.json({ error: 'net_mismatch' }, 400);

    const resolved = await resolveWallet(deps, net, key);
    const target = resolved.wallet;
    if (sameWallet(net, target, user.wallet)) return c.json({ error: 'cannot_follow_self' }, 400);
    // Username that never resolved would round-trip as the raw key — refuse
    // so we never store a non-wallet followee that counts queries cannot see.
    if (!resolved.found || !looksLikeWallet(target, net))
      return c.json({ error: 'user_not_found' }, 404);

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
    const key = c.req.param('addr');
    if (!net || !key) return c.json({ error: 'bad_request' }, 400);
    if (net !== user.net) return c.json({ error: 'net_mismatch' }, 400);

    const resolved = await resolveWallet(deps, net, key);
    const target = resolved.wallet;
    if (!resolved.found || !looksLikeWallet(target, net))
      return c.json({ error: 'user_not_found' }, 404);

    await deps.db
      .delete(follows)
      .where(
        and(eq(follows.net, net), eq(follows.follower, user.wallet), eq(follows.followee, target)),
      );

    return c.json({ net, addr: target, following: false });
  });

  /**
   * Plan step 147 — the wall's backscroll. Resolves username → wallet.
   * Newest first, `?before=<postId>&limit=`; flagged posts are never replayed;
   * a private wall is the owner's alone.
   */
  app.get('/wall/:net/:addr', optionalAuth(), limit(RATE_LIMITS.read), async (c) => {
    const deps = c.get('deps');
    const m = await resolveMember(c);
    if (!m.ok) return m.res;
    const { net: memberNet, wallet } = m;
    if (!canSeePrivate(c.get('user'), memberNet, wallet, m.profileRow)) return privateRefusal(c);
    const { before, limit: max } = pageOpts(c, 100);

    const rows = await deps.db
      .select()
      .from(wallPosts)
      .where(
        and(
          eq(wallPosts.net, memberNet),
          eq(wallPosts.toWallet, wallet),
          eq(wallPosts.flagged, false),
          ...(before ? [lt(wallPosts.id, before)] : []),
        ),
      )
      .orderBy(desc(wallPosts.id))
      .limit(max + 1);
    const page = rows.slice(0, max);
    const ids = page.map((r) => r.id);

    const [likeCounts, identities] = await Promise.all([
      ids.length
        ? deps.db
            .select({ postId: wallLikes.postId, n: sql<number>`count(*)::int` })
            .from(wallLikes)
            .where(and(eq(wallLikes.net, memberNet), inArray(wallLikes.postId, ids)))
            .groupBy(wallLikes.postId)
        : Promise.resolve([] as { postId: number; n: number }[]),
      identitiesFor(
        deps,
        memberNet,
        page.map((r) => r.fromWallet),
      ),
    ]);
    const likeMap = new Map(likeCounts.map((r) => [r.postId, r.n]));
    const idMap = new Map(identities.map((i) => [i.wallet, i]));
    const last = page[page.length - 1];

    return c.json({
      net: memberNet,
      addr: wallet,
      minTip: minTipFor(memberNet),
      posts: page.map((r) => ({
        id: r.id,
        from: r.fromWallet,
        fromUsername: idMap.get(r.fromWallet)?.username ?? null,
        fromAvatarUrl: idMap.get(r.fromWallet)?.avatarUrl ?? null,
        text: r.text,
        tip: r.tipNative,
        sig: r.tipTxSig,
        likes: likeMap.get(r.id) ?? 0,
        createdAtMs: r.createdAt.getTime(),
      })),
      nextBefore: rows.length > max && last ? last.id : null,
    });
  });

  /** Like a wall post — 1 XP for the first 5 likes per UTC day. */
  app.post('/wall/:net/posts/:id/like', requireAuth(), limit(RATE_LIMITS.social), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const net = parseNet(c.req.param('net'));
    const postId = Number.parseInt(c.req.param('id') ?? '', 10);
    if (!net || !Number.isFinite(postId)) return c.json({ error: 'bad_request' }, 400);
    if (net !== user.net) return c.json({ error: 'net_mismatch' }, 400);

    const [post] = await deps.db
      .select()
      .from(wallPosts)
      .where(and(eq(wallPosts.net, net), eq(wallPosts.id, postId)))
      .limit(1);
    if (!post || post.flagged) return c.json({ error: 'not_found' }, 404);

    // A private wall cannot be read by anyone but its owner, so nobody else
    // may like a post on it either.
    const [owner] = await deps.db
      .select({ private: users.private })
      .from(users)
      .where(and(eq(users.net, net), eq(users.wallet, post.toWallet)))
      .limit(1);
    if (!canSeePrivate(user, net, post.toWallet, owner ?? null)) return privateRefusal(c);

    const inserted = await deps.db
      .insert(wallLikes)
      .values({ net, postId, wallet: user.wallet })
      .onConflictDoNothing()
      .returning({ postId: wallLikes.postId });
    if (inserted.length === 0)
      return c.json({ ok: true, liked: true, xpAwarded: 0, already: true });

    const { xp } = await deps.awards.like({ net, wallet: user.wallet, postId });
    return c.json({ ok: true, liked: true, xpAwarded: xp });
  });

  /**
   * Plan step 147-150 — tip verified against the chain, then the post lands.
   * Target may be a username; resolved to wallet before verify + insert.
   * Text is cleaned of control/format characters and checked against the
   * chat blocklist: a flagged post is stored (the tip already settled) but
   * hidden from readers and pays no XP.
   */
  const wallGate = gate({ ban: 'comments' });
  app.post('/wall/:net/:addr', requireAuth(), wallGate, limit(RATE_LIMITS.wall), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const net = parseNet(c.req.param('net'));
    const key = c.req.param('addr');
    if (!net || !key) return c.json({ error: 'bad_request' }, 400);
    if (net !== user.net) return c.json({ error: 'net_mismatch' }, 400);
    const resolved = await resolveWallet(deps, net, key);
    const target = resolved.wallet;
    if (!resolved.found || !looksLikeWallet(target, net))
      return c.json({ error: 'user_not_found' }, 404);
    // Nobody can read a private wall but its owner, so nobody else may post
    // to it — refused before the body is even parsed, so a client that checks
    // first never sends a tip it cannot show.
    if (!canSeePrivate(user, net, target, resolved.profileRow)) return privateRefusal(c);

    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown; tipTxSig?: unknown };
    const text = sanitizeName(String(body.text ?? ''));
    const tipTxSig = String(body.tipTxSig ?? '').trim();
    if (!text || text.length > WALL_TEXT_MAX)
      return c.json({ error: 'bad_request', detail: `text must be 1-${WALL_TEXT_MAX} chars` }, 400);
    if (!tipTxSig || tipTxSig.length > 128 || /[\s\p{Cc}]/u.test(tipTxSig))
      return c.json({ error: 'bad_request', detail: 'tipTxSig is required' }, 400);

    const verification = await verifyTip({
      rpc: deps.rpcs[net],
      net,
      signature: tipTxSig,
      fromWallet: user.wallet,
      toWallet: target,
      nowMs: deps.now(),
      maxAgeMs: deps.env.tipMaxAgeSeconds * 1000,
    });
    if (!verification.ok)
      return c.json({ error: 'tip_rejected', reason: verification.reason }, 422);

    const flagged = isFlagged(text);
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
          flagged,
        })
        .returning({ id: wallPosts.id, createdAt: wallPosts.createdAt });
    } catch (err) {
      if (isUniqueViolation(err)) return c.json({ error: 'signature_already_used' }, 409);
      throw err;
    }
    if (!inserted) throw new Error('wall_posts insert returned no row');

    const award = flagged
      ? { xp: 0 }
      : await deps.awards.wallPost({
          net,
          wallet: user.wallet,
          target,
          tipSig: tipTxSig,
        });

    return c.json({
      net,
      addr: target,
      post: {
        id: inserted.id,
        from: user.wallet,
        text,
        tip: verification.amountNative ?? 0,
        sig: tipTxSig,
        likes: 0,
        createdAtMs: inserted.createdAt.getTime(),
      },
      flagged,
      xpAwarded: award.xp,
    });
  });

  return app;
}
