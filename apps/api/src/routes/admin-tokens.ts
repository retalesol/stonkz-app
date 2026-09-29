import { randomBytes } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { and, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { requireAdmin, audited, type AdminEnv } from '../admin/middleware.js';
import { bad, bool, confirmed, int, netParam, netQuery, readBody, str } from '../admin/http.js';
import {
  enqueueIndexerCommand,
  pendingIndexerCommands,
  type IndexerCommand,
} from '../admin/indexer-control.js';
import { tokenEconomics } from '../admin/stats.js';
import {
  adminJobs,
  creatorVaults,
  indexerCursors,
  indexerDeadLetters,
  stakePositions,
  tokenModeration,
  tokens,
  treasuries,
} from '../db/schema.js';
import { checkWebsite } from './launch-validate.js';

/**
 * `/admin/tokens` and `/admin/indexer` — token search, feature/pin/hide/scam
 * flags, metadata edits with a reason, fee/treasury/staker views, forced
 * reindexes (handed to the indexer over Redis) and the dead-letter queue.
 */
const EDITABLE = ['name', 'descr', 'imageUrl', 'xHandle', 'website', 'telegram'] as const;

async function enqueue(
  c: Context<AdminEnv>,
  command: IndexerCommand,
): Promise<{ id: string; receivers: number; jobId: number }> {
  const deps = c.get('deps');
  const id = randomBytes(8).toString('hex');
  const actor = c.get('admin').address;
  const entry = await enqueueIndexerCommand(deps.redis, command, actor, deps.now(), id);
  const [job] = await deps.db
    .insert(adminJobs)
    .values({
      kind: command.type,
      net: command.net,
      payload: { ...command, commandId: id, receivers: entry.receivers },
      status: entry.receivers > 0 ? 'sent' : 'queued',
      createdBy: actor,
      createdAt: new Date(deps.now()),
      updatedAt: new Date(deps.now()),
    })
    .returning({ id: adminJobs.id });
  return { id, receivers: entry.receivers, jobId: job?.id ?? 0 };
}

export function adminTokenRoutes(): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();

  app.get('/admin/tokens', requireAdmin('viewer'), async (c) => {
    const deps = c.get('deps');
    const q = (c.req.query('q') ?? '').trim();
    const net = netQuery(c);
    const max = Math.min(Math.max(int(c.req.query('limit')) ?? 50, 1), 200);
    const filters = [];
    if (net) filters.push(eq(tokens.net, net));
    if (q)
      filters.push(
        or(ilike(tokens.sym, `${q}%`), ilike(tokens.name, `%${q}%`), eq(tokens.mint, q)),
      );
    const rows = await deps.db
      .select({
        net: tokens.net,
        sym: tokens.sym,
        name: tokens.name,
        mint: tokens.mint,
        creator: tokens.creator,
        mc: tokens.mc,
        lane: tokens.lane,
        holders: tokens.holders,
        launchedAt: tokens.launchedAt,
        imageUrl: tokens.imageUrl,
        featured: tokenModeration.featured,
        kothOverride: tokenModeration.kothOverride,
        hidden: tokenModeration.hidden,
        scamWarning: tokenModeration.scamWarning,
      })
      .from(tokens)
      .leftJoin(
        tokenModeration,
        and(eq(tokenModeration.net, tokens.net), eq(tokenModeration.mint, tokens.mint)),
      )
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(tokens.launchedAt))
      .limit(max);
    return c.json({
      tokens: rows.map((r) => ({
        ...r,
        launchedAt: r.launchedAt.getTime(),
        featured: r.featured ?? false,
        kothOverride: r.kothOverride ?? false,
        hidden: r.hidden ?? false,
      })),
    });
  });

  app.get('/admin/tokens/:net/:mint', requireAdmin('viewer'), async (c) => {
    const deps = c.get('deps');
    const net = netParam(c);
    const mint = c.req.param('mint');
    if (!net || !mint) return bad(c, 'net and mint are required');
    const key = and(eq(tokens.net, net), eq(tokens.mint, mint));
    const [token] = await deps.db.select().from(tokens).where(key).limit(1);
    if (!token) return bad(c, 'no such token', 404);
    const [moderation] = await deps.db
      .select()
      .from(tokenModeration)
      .where(and(eq(tokenModeration.net, net), eq(tokenModeration.mint, mint)))
      .limit(1);
    const [vault] = await deps.db
      .select()
      .from(creatorVaults)
      .where(and(eq(creatorVaults.net, net), eq(creatorVaults.mint, mint)))
      .limit(1);
    const [stakers] = await deps.db
      .select({
        n: sql<number>`count(*) filter (where ${stakePositions.amount} > 0)::int`,
        staked: sql<number>`coalesce(sum(${stakePositions.amount}), 0)::float8`,
      })
      .from(stakePositions)
      .where(and(eq(stakePositions.net, net), eq(stakePositions.mint, mint)));
    const topStakers = await deps.db
      .select({
        wallet: stakePositions.wallet,
        amount: stakePositions.amount,
        lockDays: stakePositions.lockDays,
      })
      .from(stakePositions)
      .where(and(eq(stakePositions.net, net), eq(stakePositions.mint, mint)))
      .orderBy(desc(stakePositions.amount))
      .limit(10);
    const treasuryRows = await deps.db.select().from(treasuries).where(eq(treasuries.net, net));
    const economics = await tokenEconomics(deps.db, net, mint);
    return c.json({
      token: {
        ...token,
        launchedAt: token.launchedAt.getTime(),
        updatedAt: token.updatedAt.getTime(),
        graduatedAt: token.graduatedAt?.getTime() ?? null,
      },
      moderation: moderation
        ? { ...moderation, updatedAt: moderation.updatedAt.getTime() }
        : { featured: false, kothOverride: false, hidden: false, scamWarning: null, reason: null },
      creatorVault: vault ? { ...vault, updatedAt: vault.updatedAt.getTime() } : null,
      stakers: { count: stakers?.n ?? 0, staked: Number(stakers?.staked ?? 0), top: topStakers },
      treasuries: treasuryRows.map((t) => ({
        kind: t.kind,
        nativeBalance: t.nativeBalance,
        lifetimeCredited: t.lifetimeCredited,
      })),
      economics,
    });
  });

  app.put('/admin/tokens/:net/:mint/moderation', requireAdmin('moderator'), async (c) => {
    const deps = c.get('deps');
    const net = netParam(c);
    const mint = c.req.param('mint');
    if (!net || !mint) return bad(c, 'net and mint are required');
    const [token] = await deps.db
      .select({ sym: tokens.sym })
      .from(tokens)
      .where(and(eq(tokens.net, net), eq(tokens.mint, mint)))
      .limit(1);
    if (!token) return bad(c, 'no such token', 404);
    const body = await readBody(c);
    const reason = str(body['reason'], 500);
    if (!reason) return bad(c, 'reason is required');
    const [before] = await deps.db
      .select()
      .from(tokenModeration)
      .where(and(eq(tokenModeration.net, net), eq(tokenModeration.mint, mint)))
      .limit(1);
    const hidden = bool(body['hidden']) ?? before?.hidden ?? false;
    if (hidden && !before?.hidden && !confirmed(body, `HIDE ${token.sym}`)) {
      return bad(c, `hiding a token requires confirm "HIDE ${token.sym}"`);
    }
    const patch = {
      featured: bool(body['featured']) ?? before?.featured ?? false,
      kothOverride: bool(body['kothOverride']) ?? before?.kothOverride ?? false,
      hidden,
      scamWarning:
        'scamWarning' in body
          ? (str(body['scamWarning'], 280) ?? null)
          : (before?.scamWarning ?? null),
      reason,
      updatedBy: c.get('admin').address,
      updatedAt: new Date(deps.now()),
    };
    if (patch.kothOverride && !before?.kothOverride) {
      // One crown per net: pinning this token unpins any other.
      await deps.db
        .update(tokenModeration)
        .set({ kothOverride: false, updatedAt: new Date(deps.now()) })
        .where(and(eq(tokenModeration.net, net), eq(tokenModeration.kothOverride, true)));
    }
    await deps.db
      .insert(tokenModeration)
      .values({ net, mint, ...patch })
      .onConflictDoUpdate({ target: [tokenModeration.net, tokenModeration.mint], set: patch });
    const [after] = await deps.db
      .select()
      .from(tokenModeration)
      .where(and(eq(tokenModeration.net, net), eq(tokenModeration.mint, mint)))
      .limit(1);
    await audited(c, 'token.moderation', `${net}:${mint}`, before ?? null, after ?? null);
    return c.json({ ok: true, before: before ?? null, after: after ?? null });
  });

  app.patch('/admin/tokens/:net/:mint/metadata', requireAdmin('admin'), async (c) => {
    const deps = c.get('deps');
    const net = netParam(c);
    const mint = c.req.param('mint');
    if (!net || !mint) return bad(c, 'net and mint are required');
    const body = await readBody(c);
    const reason = str(body['reason'], 500);
    if (!reason) return bad(c, 'reason is required');
    const key = and(eq(tokens.net, net), eq(tokens.mint, mint));
    const [before] = await deps.db.select().from(tokens).where(key).limit(1);
    if (!before) return bad(c, 'no such token', 404);
    const patch: Partial<typeof tokens.$inferInsert> = {};
    for (const field of EDITABLE) {
      if (!(field in body)) continue;
      const raw = body[field];
      const value = raw === null || raw === '' ? null : str(raw, field === 'descr' ? 2000 : 512);
      if (raw !== null && raw !== '' && value === undefined) return bad(c, `${field} is invalid`);
      if (field === 'name') {
        if (!value) return bad(c, 'name cannot be empty');
        patch.name = value;
      } else if (field === 'descr') patch.descr = value ?? '';
      else if (field === 'imageUrl' || field === 'website') {
        if (value) {
          const checked = checkWebsite(value, 2048);
          if (!checked.ok) return bad(c, `${field}: ${checked.detail}`);
          if (field === 'imageUrl' && !/^https:\/\//i.test(value))
            return bad(c, 'imageUrl must be https');
        }
        patch[field] = value;
      } else patch[field] = value ? value.replace(/^@/, '').slice(0, 64) : null;
    }
    if (Object.keys(patch).length === 0) return bad(c, 'nothing to change');
    patch.updatedAt = new Date(deps.now());
    await deps.db.update(tokens).set(patch).where(key);
    const [after] = await deps.db.select().from(tokens).where(key).limit(1);
    const pick = (row: typeof before | undefined): Record<string, unknown> =>
      Object.fromEntries(EDITABLE.filter((f) => f in patch).map((f) => [f, row?.[f] ?? null]));
    await audited(c, 'token.metadata', `${net}:${mint}`, pick(before), { ...pick(after), reason });
    await deps.publisher.board({
      type: 'token_update',
      net,
      sym: before.sym,
      payload: pick(after),
    });
    return c.json({ ok: true, before: pick(before), after: pick(after) });
  });

  /* ---------------------------------------------------------------- indexer */

  app.post('/admin/tokens/:net/:mint/reindex', requireAdmin('admin'), async (c) => {
    const net = netParam(c);
    const mint = c.req.param('mint');
    if (!net || !mint) return bad(c, 'net and mint are required');
    const out = await enqueue(c, { type: 'reindex_token', net, mint });
    await audited(c, 'indexer.reindex_token', `${net}:${mint}`, null, out);
    return c.json({ ok: true, ...out });
  });

  app.post('/admin/indexer/reindex', requireAdmin('admin'), async (c) => {
    const body = await readBody(c);
    const net = netQuery(c) ?? (typeof body['net'] === 'string' ? netParamFrom(body['net']) : null);
    const from = int(body['from']);
    const to = int(body['to']);
    if (!net || from === undefined || to === undefined || from < 0 || to <= from) {
      return bad(c, 'net, from and to (> from) are required');
    }
    if (to - from > 5_000_000) return bad(c, 'range too large (max 5,000,000 positions)');
    if (!confirmed(body, `REINDEX ${net}`)) return bad(c, `confirm with "REINDEX ${net}"`);
    const out = await enqueue(c, { type: 'reindex_range', net, from, to });
    await audited(c, 'indexer.reindex_range', net, null, { from, to, ...out });
    return c.json({ ok: true, ...out });
  });

  app.get('/admin/indexer/commands', requireAdmin('viewer'), async (c) => {
    const deps = c.get('deps');
    const jobs = await deps.db.select().from(adminJobs).orderBy(desc(adminJobs.id)).limit(50);
    return c.json({
      pending: await pendingIndexerCommands(deps.redis),
      jobs: jobs.map((j) => ({
        ...j,
        createdAt: j.createdAt.getTime(),
        updatedAt: j.updatedAt.getTime(),
      })),
    });
  });

  app.get('/admin/indexer/cursors', requireAdmin('viewer'), async (c) => {
    const deps = c.get('deps');
    const rows = await deps.db.select().from(indexerCursors);
    return c.json({
      cursors: rows.map((r) => ({
        ...r,
        lastReorgAt: r.lastReorgAt?.getTime() ?? null,
        lastErrorAt: r.lastErrorAt?.getTime() ?? null,
        lastEventAt: r.lastEventAt?.getTime() ?? null,
        updatedAt: r.updatedAt.getTime(),
      })),
    });
  });

  /** Owner-only: rewinds (or advances) the live cursor. The indexer re-reads from there. */
  app.post('/admin/indexer/cursors/:net', requireAdmin('owner'), async (c) => {
    const deps = c.get('deps');
    const net = netParam(c);
    if (!net) return bad(c, 'net is required');
    const body = await readBody(c);
    const position = int(body['position']);
    if (position === undefined || position < 0)
      return bad(c, 'position must be a non-negative integer');
    if (!confirmed(body, `SET CURSOR ${net}`)) return bad(c, `confirm with "SET CURSOR ${net}"`);
    const [before] = await deps.db
      .select()
      .from(indexerCursors)
      .where(eq(indexerCursors.net, net))
      .limit(1);
    if (!before) return bad(c, 'no cursor row', 404);
    await deps.db
      .update(indexerCursors)
      .set({
        position,
        positionHash: null,
        positionSignature: null,
        failedAttempts: 0,
        updatedAt: new Date(deps.now()),
      })
      .where(eq(indexerCursors.net, net));
    const out = await enqueue(c, { type: 'set_cursor', net, position });
    await audited(
      c,
      'indexer.set_cursor',
      net,
      { position: before.position },
      { position, ...out },
    );
    return c.json({ ok: true, before: before.position, after: position, ...out });
  });

  app.get('/admin/indexer/dead-letters', requireAdmin('viewer'), async (c) => {
    const deps = c.get('deps');
    const net = netQuery(c);
    const open = c.req.query('open') !== '0';
    const filters = [];
    if (net) filters.push(eq(indexerDeadLetters.net, net));
    if (open) filters.push(isNull(indexerDeadLetters.resolvedAt));
    const rows = await deps.db
      .select()
      .from(indexerDeadLetters)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(indexerDeadLetters.id))
      .limit(200);
    return c.json({
      deadLetters: rows.map((r) => ({
        ...r,
        firstSeenAt: r.firstSeenAt.getTime(),
        lastSeenAt: r.lastSeenAt.getTime(),
        resolvedAt: r.resolvedAt?.getTime() ?? null,
      })),
    });
  });

  app.post('/admin/indexer/dead-letters/:id/retry', requireAdmin('admin'), async (c) => {
    const deps = c.get('deps');
    const id = int(c.req.param('id'));
    if (id === undefined) return bad(c, 'bad id');
    const [row] = await deps.db
      .select()
      .from(indexerDeadLetters)
      .where(eq(indexerDeadLetters.id, id))
      .limit(1);
    if (!row) return bad(c, 'no such dead letter', 404);
    const from = row.scope === 'batch' ? row.fromPosition : Math.max(0, row.chainPosition - 1);
    const to = row.scope === 'batch' ? row.toPosition : row.chainPosition;
    const out = await enqueue(c, {
      type: 'retry_dead_letter',
      net: row.net as IndexerCommand['net'],
      id,
      from,
      to,
    });
    await audited(
      c,
      'indexer.dead_letter_retry',
      String(id),
      { resolvedAt: row.resolvedAt },
      { from, to, ...out },
    );
    return c.json({ ok: true, from, to, ...out });
  });

  app.post('/admin/indexer/dead-letters/:id/discard', requireAdmin('admin'), async (c) => {
    const deps = c.get('deps');
    const id = int(c.req.param('id'));
    if (id === undefined) return bad(c, 'bad id');
    const body = await readBody(c);
    if (!confirmed(body, `DISCARD ${id}`)) return bad(c, `confirm with "DISCARD ${id}"`);
    const [row] = await deps.db
      .select()
      .from(indexerDeadLetters)
      .where(eq(indexerDeadLetters.id, id))
      .limit(1);
    if (!row) return bad(c, 'no such dead letter', 404);
    await deps.db
      .update(indexerDeadLetters)
      .set({ resolvedAt: new Date(deps.now()) })
      .where(eq(indexerDeadLetters.id, id));
    await audited(
      c,
      'indexer.dead_letter_discard',
      String(id),
      { resolvedAt: row.resolvedAt },
      { resolvedAt: deps.now() },
    );
    return c.json({ ok: true });
  });

  return app;
}

function netParamFrom(v: string): IndexerCommand['net'] | null {
  return v === 'SOL' || v === 'RH' || v === 'BASE' || v === 'ARC' ? v : null;
}
