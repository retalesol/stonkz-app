import { Hono } from 'hono';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import type { Net } from '@stonkz/shared';
import { follows, tape, tokens, users, wallPosts } from '../db/schema.js';
import { isUniqueViolation } from '../db/errors.js';
import { optionalAuth, requireAuth, limit } from '../app/middleware.js';
import { RATE_LIMITS } from '../redis/ratelimit.js';
import type { AppDeps, AppEnv } from '../app/context.js';
import { minTipFor, verifyTip } from '../social/tips.js';
import { SolanaRpc } from '../chain/solana.js';
import { asErc20BalanceSource } from '../chain/types.js';
import { serialiseToken } from './serialise.js';

/**
 * Phase 5.A — plan steps 143-150.
 *
 * `users`, `follows` and `wall_posts` back every route here. Nothing about a
 * profile that another wallet can see is ever taken from the request body —
 * `PATCH /me` is the only writer of `users`, and a tip has to clear
 * `verifyTip()` before `POST /wall/:net/:addr` inserts anything.
 *
 * `GET /users/:net/:key` accepts a wallet **or** a username and returns
 * on-chain native balance + Stonkz-token holdings when the RPC can answer,
 * with indexed `tokens` / `tape` as the fallback — never simulated flavour.
 */

const USERNAME_MAX = 22;
const BIO_MAX = 160;

function parseNet(raw: string | undefined): Net | null {
  return raw === 'SOL' || raw === 'RH' ? raw : null;
}

function isValidUsername(v: string): boolean {
  return /^[A-Za-z0-9_]{1,22}$/.test(v);
}

/** Wallet-shaped keys are looked up by address; otherwise treat as username. */
function looksLikeWallet(key: string, net: Net): boolean {
  if (net === 'SOL') return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(key);
  return /^0x[a-fA-F0-9]{40}$/.test(key);
}

async function resolveWallet(
  deps: AppDeps,
  net: Net,
  key: string,
): Promise<{ wallet: string; profileRow: typeof users.$inferSelect | null }> {
  if (looksLikeWallet(key, net)) {
    const [byWallet] = await deps.db
      .select()
      .from(users)
      .where(and(eq(users.net, net), eq(users.wallet, key)))
      .limit(1);
    return { wallet: key, profileRow: byWallet ?? null };
  }
  const [byName] = await deps.db
    .select()
    .from(users)
    .where(and(eq(users.net, net), sql`lower(${users.username}) = lower(${key})`))
    .limit(1);
  if (byName) return { wallet: byName.wallet, profileRow: byName };
  // Username is globally unique — fall back across nets so `/u/Mememan` works
  // even if the client defaulted to the wrong net.
  const [anyNet] = await deps.db
    .select()
    .from(users)
    .where(sql`lower(${users.username}) = lower(${key})`)
    .limit(1);
  if (anyNet) return { wallet: anyNet.wallet, profileRow: anyNet };
  return { wallet: key, profileRow: null };
}

/** Net token position from indexed tape (buys − sells). DB fallback only. */
async function holdingsFromTape(
  deps: AppDeps,
  net: Net,
  wallet: string,
): Promise<Array<{ sym: string; tok: number; cost: number; value: number }>> {
  const rows = await deps.db
    .select({
      sym: tape.sym,
      tok: sql<number>`coalesce(sum(case when ${tape.side} = 'buy' then ${tape.tokenAmount} else -${tape.tokenAmount} end), 0)`,
      cost: sql<number>`coalesce(sum(case when ${tape.side} = 'buy' then ${tape.usdValue} else 0 end), 0)`,
    })
    .from(tape)
    .where(and(eq(tape.net, net), eq(tape.trader, wallet)))
    .groupBy(tape.sym);

  const out: Array<{ sym: string; tok: number; cost: number; value: number }> = [];
  for (const r of rows) {
    if (Math.abs(Number(r.tok)) < 1e-6) continue;
    const [tokRow] = await deps.db
      .select()
      .from(tokens)
      .where(and(eq(tokens.net, net), eq(tokens.sym, r.sym)))
      .orderBy(desc(tokens.launchedAt))
      .limit(1);
    const priceUsd = tokRow ? tokRow.mc / tokRow.supply : 0;
    const tok = Number(r.tok);
    out.push({
      sym: r.sym,
      tok,
      cost: Number(r.cost),
      value: tok * priceUsd,
    });
  }
  return out;
}

/**
 * On-chain token balances for mints we know about (launchpad tokens).
 * SOL: SPL token accounts. RH: ERC-20 `balanceOf`. Falls back to null when
 * the RPC cannot answer so the caller can use tape-derived holdings.
 */
async function holdingsOnChain(
  deps: AppDeps,
  net: Net,
  wallet: string,
): Promise<Array<{ sym: string; tok: number; cost: number; value: number }> | null> {
  const known = await deps.db
    .select({
      sym: tokens.sym,
      mint: tokens.mint,
      mc: tokens.mc,
      supply: tokens.supply,
      tokenDecimals: tokens.tokenDecimals,
    })
    .from(tokens)
    .where(eq(tokens.net, net));
  if (!known.length) return [];

  if (net === 'SOL') {
    const rpc = deps.rpcs.SOL;
    if (!(rpc instanceof SolanaRpc)) return null;
    try {
      const byMint = await rpc.splTokenBalances(wallet);
      const out: Array<{ sym: string; tok: number; cost: number; value: number }> = [];
      for (const t of known) {
        if (!t.mint) continue;
        const bal = byMint.get(t.mint) ?? 0;
        if (bal <= 0) continue;
        const priceUsd = t.supply > 0 ? t.mc / t.supply : 0;
        out.push({ sym: t.sym, tok: bal, cost: 0, value: bal * priceUsd });
      }
      return out;
    } catch {
      return null;
    }
  }

  const erc20 = asErc20BalanceSource(deps.rpcs.RH);
  if (!erc20) return null;
  try {
    const out: Array<{ sym: string; tok: number; cost: number; value: number }> = [];
    for (const t of known) {
      if (!t.mint || !t.mint.startsWith('0x')) continue;
      const atoms = await erc20.erc20BalanceAtoms(t.mint, wallet);
      if (atoms <= 0n) continue;
      const tok = Number(atoms) / 10 ** t.tokenDecimals;
      if (!Number.isFinite(tok) || tok <= 0) continue;
      const priceUsd = t.supply > 0 ? t.mc / t.supply : 0;
      out.push({ sym: t.sym, tok, cost: 0, value: tok * priceUsd });
    }
    return out;
  } catch {
    return null;
  }
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

  /**
   * Upload a profile picture to Pinata and persist the gateway URL on `users`.
   * Multipart field name: `file`. JWT never leaves the API.
   */
  app.post('/me/avatar', requireAuth(), limit(RATE_LIMITS.avatar), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const { net, wallet } = user;

    const body = await c.req.parseBody();
    const file = body['file'];
    if (!file || typeof file === 'string') {
      return c.json({ error: 'bad_request', detail: 'multipart file field is required' }, 400);
    }
    const blob = file as File;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const mimeType = blob.type || 'application/octet-stream';
    const filename = blob.name || 'avatar.png';

    try {
      const { uploadToPinata } = await import('../social/pinata.js');
      const uploaded = await uploadToPinata({
        jwt: deps.env.pinataJwt,
        gateway: deps.env.pinataGateway,
        bytes,
        mimeType,
        filename,
        name: 'stonkz-avatar',
      });
      await deps.db
        .insert(users)
        .values({ net, wallet, avatarUrl: uploaded.url, updatedAt: new Date(deps.now()) })
        .onConflictDoUpdate({
          target: [users.net, users.wallet],
          set: { avatarUrl: uploaded.url, updatedAt: new Date(deps.now()) },
        });
      const [row] = await deps.db.select().from(users).where(and(eq(users.net, net), eq(users.wallet, wallet))).limit(1);
      return c.json({
        net,
        wallet,
        avatarUrl: uploaded.url,
        cid: uploaded.cid,
        profile: row ? serialiseUser(row) : null,
      });
    } catch (err) {
      const { PinataError } = await import('../social/pinata.js');
      if (err instanceof PinataError) {
        const status = err.code === 'not_configured' ? 503 : err.code === 'upload_failed' ? 502 : 400;
        return c.json({ error: err.code, detail: err.message }, status);
      }
      throw err;
    }
  });

  /**
   * Upload a launch / generic image to Pinata. Returns the gateway URL only —
   * does not touch the user profile. Multipart field: `file`.
   */
  app.post('/uploads/image', requireAuth(), limit(RATE_LIMITS.avatar), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);

    const body = await c.req.parseBody();
    const file = body['file'];
    if (!file || typeof file === 'string') {
      return c.json({ error: 'bad_request', detail: 'multipart file field is required' }, 400);
    }
    const blob = file as File;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const mimeType = blob.type || 'application/octet-stream';
    const filename = blob.name || 'token.png';

    try {
      const { uploadToPinata } = await import('../social/pinata.js');
      const uploaded = await uploadToPinata({
        jwt: deps.env.pinataJwt,
        gateway: deps.env.pinataGateway,
        bytes,
        mimeType,
        filename,
        name: 'stonkz-token',
      });
      return c.json({ url: uploaded.url, cid: uploaded.cid, mimeType: uploaded.mimeType, size: uploaded.size });
    } catch (err) {
      const { PinataError } = await import('../social/pinata.js');
      if (err instanceof PinataError) {
        const status = err.code === 'not_configured' ? 503 : err.code === 'upload_failed' ? 502 : 400;
        return c.json({ error: err.code, detail: err.message }, status);
      }
      throw err;
    }
  });

  /** Public member card — wallet or username. On-chain balance + holdings when possible. */
  app.get('/users/:net/:addr', optionalAuth(), limit(RATE_LIMITS.read), async (c) => {
    const deps = c.get('deps');
    const net = parseNet(c.req.param('net'));
    const key = c.req.param('addr');
    if (!net || !key) return c.json({ error: 'bad_request' }, 400);

    const { wallet, profileRow } = await resolveWallet(deps, net, key);
    const memberNet = (profileRow?.net as Net | undefined) ?? net;

    const [followerCountRow, followingCountRow, followingRows, snapshot, launchedRows] = await Promise.all([
      deps.db
        .select({ n: count() })
        .from(follows)
        .where(and(eq(follows.net, memberNet), eq(follows.followee, wallet))),
      deps.db
        .select({ n: count() })
        .from(follows)
        .where(and(eq(follows.net, memberNet), eq(follows.follower, wallet))),
      deps.db
        .select({ followee: follows.followee })
        .from(follows)
        .where(and(eq(follows.net, memberNet), eq(follows.follower, wallet)))
        .limit(24),
      deps.ledger.snapshot(memberNet, wallet),
      deps.db
        .select()
        .from(tokens)
        .where(and(eq(tokens.net, memberNet), eq(tokens.creator, wallet)))
        .orderBy(sql`${tokens.launchedAt} desc`)
        .limit(40),
    ]);

    const caller = c.get('user');
    let isFollowing = false;
    if (caller && caller.net === memberNet) {
      const [row] = await deps.db
        .select({ n: count() })
        .from(follows)
        .where(
          and(eq(follows.net, memberNet), eq(follows.follower, caller.wallet), eq(follows.followee, wallet)),
        );
      isFollowing = (row?.n ?? 0) > 0;
    }

    const [nativeBalance, onChainHoldings] = await Promise.all([
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
    ]);

    const holdings =
      onChainHoldings ??
      (await holdingsFromTape(deps, memberNet, wallet).catch(() => [] as Awaited<ReturnType<typeof holdingsFromTape>>));
    const holdingsSource = onChainHoldings ? 'chain' : 'index';
    const now = deps.now();
    const portfolioUsd = holdings.reduce((s, h) => s + h.value, 0);

    return c.json({
      net: memberNet,
      addr: wallet,
      resolvedFrom: key === wallet ? 'wallet' : 'username',
      profile: profileRow ? serialiseUser(profileRow) : null,
      followers: followerCountRow[0]?.n ?? 0,
      following: followingCountRow[0]?.n ?? 0,
      followingWallets: followingRows.map((r) => r.followee),
      isFollowing,
      xp: snapshot.xp,
      rank: snapshot.rank,
      native: {
        unit: memberNet === 'SOL' ? 'SOL' : 'ETH',
        balance: nativeBalance,
      },
      portfolioUsd,
      holdings,
      holdingsSource,
      launched: launchedRows.map((r) => serialiseToken(r, now)),
    });
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

    const { wallet: target } = await resolveWallet(deps, net, key);
    if (target === user.wallet) return c.json({ error: 'cannot_follow_self' }, 400);
    // Username that never resolved would round-trip as the raw key — refuse
    // so we never store a non-wallet followee that counts queries cannot see.
    if (!looksLikeWallet(target, net)) return c.json({ error: 'user_not_found' }, 404);

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

    const { wallet: target } = await resolveWallet(deps, net, key);
    if (!looksLikeWallet(target, net)) return c.json({ error: 'user_not_found' }, 404);

    await deps.db
      .delete(follows)
      .where(and(eq(follows.net, net), eq(follows.follower, user.wallet), eq(follows.followee, target)));

    return c.json({ net, addr: target, following: false });
  });

  /** Plan step 147 — the wall's backscroll. Resolves username → wallet. */
  app.get('/wall/:net/:addr', limit(RATE_LIMITS.read), async (c) => {
    const deps = c.get('deps');
    const net = parseNet(c.req.param('net'));
    const key = c.req.param('addr');
    if (!net || !key) return c.json({ error: 'bad_request' }, 400);
    const resolved = await resolveWallet(deps, net, key);
    const memberNet = (resolved.profileRow?.net as Net | undefined) ?? net;
    const wallet = resolved.wallet;

    const rows = await deps.db
      .select()
      .from(wallPosts)
      .where(and(eq(wallPosts.net, memberNet), eq(wallPosts.toWallet, wallet)))
      .orderBy(wallPosts.id);

    return c.json({
      net: memberNet,
      addr: wallet,
      minTip: minTipFor(memberNet),
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
   * Target may be a username; resolved to wallet before verify + insert.
   */
  app.post('/wall/:net/:addr', requireAuth(), limit(RATE_LIMITS.wall), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const net = parseNet(c.req.param('net'));
    const key = c.req.param('addr');
    if (!net || !key) return c.json({ error: 'bad_request' }, 400);
    if (net !== user.net) return c.json({ error: 'net_mismatch' }, 400);
    const { wallet: target } = await resolveWallet(deps, net, key);

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
