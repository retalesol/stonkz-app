import { Hono } from 'hono';
import { desc, eq } from 'drizzle-orm';
import { ALL_NETS, parseNet, type Net } from '@stonkz/shared';
import { requireAdmin, audited, type AdminEnv } from '../admin/middleware.js';
import { bad, bool, confirmed, int, num, readBody, str } from '../admin/http.js';
import { adminNotices, chatMessages } from '../db/schema.js';

/**
 * `/admin/comms` and `/admin/notices` — the global banner (a platform
 * setting), per-net notices and scheduled maintenance windows
 * (`admin_notices`, read publicly via `GET /platform/status`), and Mememan
 * announcements pushed into every net's GLOBAL chat room as a system message.
 */
export const MEMEMAN_WALLET = 'MEMEMAN';
const KINDS = new Set(['banner', 'notice', 'maintenance']);
const SEVERITIES = new Set(['info', 'warn', 'critical']);

function serialise(r: typeof adminNotices.$inferSelect): Record<string, unknown> {
  return {
    ...r,
    startsAt: r.startsAt?.getTime() ?? null,
    endsAt: r.endsAt?.getTime() ?? null,
    createdAt: r.createdAt.getTime(),
    updatedAt: r.updatedAt.getTime(),
  };
}

export function adminCommsRoutes(): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();

  app.get('/admin/notices', requireAdmin('viewer'), async (c) => {
    const deps = c.get('deps');
    const rows = await deps.db
      .select()
      .from(adminNotices)
      .orderBy(desc(adminNotices.id))
      .limit(200);
    return c.json({ banner: deps.admin.settings.banner(), notices: rows.map(serialise) });
  });

  app.put('/admin/comms/banner', requireAdmin('moderator'), async (c) => {
    const deps = c.get('deps');
    const body = await readBody(c);
    const text = typeof body['text'] === 'string' ? body['text'].trim().slice(0, 280) : '';
    const severity = str(body['severity'], 16) ?? 'info';
    if (!SEVERITIES.has(severity)) return bad(c, 'severity must be info | warn | critical');
    const before = deps.admin.settings.banner();
    await deps.admin.settings.set('banner.text', text, c.get('admin').address);
    await deps.admin.settings.set('banner.severity', severity, c.get('admin').address);
    const after = deps.admin.settings.banner();
    await audited(c, 'comms.banner', null, before, after);
    return c.json({ ok: true, before, after });
  });

  app.post('/admin/notices', requireAdmin('moderator'), async (c) => {
    const deps = c.get('deps');
    const body = await readBody(c);
    const kind = str(body['kind'], 16);
    const text = str(body['text'], 500);
    if (!kind || !KINDS.has(kind)) return bad(c, 'kind must be banner | notice | maintenance');
    if (!text) return bad(c, 'text is required');
    const netRaw = body['net'];
    const net =
      netRaw === null || netRaw === undefined || netRaw === 'ALL' ? null : parseNet(String(netRaw));
    if (netRaw && netRaw !== 'ALL' && !net) return bad(c, 'net must be a known net or ALL');
    const severity = str(body['severity'], 16) ?? 'info';
    if (!SEVERITIES.has(severity)) return bad(c, 'severity must be info | warn | critical');
    const startsAt = num(body['startsAtMs']);
    const endsAt = num(body['endsAtMs']);
    if (startsAt !== undefined && endsAt !== undefined && endsAt <= startsAt)
      return bad(c, 'endsAt must be after startsAt');
    if (kind === 'maintenance' && startsAt === undefined)
      return bad(c, 'a maintenance window needs startsAtMs');
    const now = new Date(deps.now());
    const [row] = await deps.db
      .insert(adminNotices)
      .values({
        kind,
        net,
        text,
        severity,
        startsAt: startsAt === undefined ? null : new Date(startsAt),
        endsAt: endsAt === undefined ? null : new Date(endsAt),
        active: bool(body['active']) ?? true,
        createdBy: c.get('admin').address,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) throw new Error('notice insert returned no row');
    await audited(c, 'comms.notice_create', String(row.id), null, serialise(row));
    return c.json({ ok: true, notice: serialise(row) });
  });

  app.patch('/admin/notices/:id', requireAdmin('moderator'), async (c) => {
    const deps = c.get('deps');
    const id = int(c.req.param('id'));
    if (id === undefined) return bad(c, 'bad id');
    const [before] = await deps.db
      .select()
      .from(adminNotices)
      .where(eq(adminNotices.id, id))
      .limit(1);
    if (!before) return bad(c, 'no such notice', 404);
    const body = await readBody(c);
    const patch: Partial<typeof adminNotices.$inferInsert> = { updatedAt: new Date(deps.now()) };
    if ('text' in body) {
      const text = str(body['text'], 500);
      if (!text) return bad(c, 'text cannot be empty');
      patch.text = text;
    }
    if ('active' in body) {
      const active = bool(body['active']);
      if (active === undefined) return bad(c, 'active must be a boolean');
      patch.active = active;
    }
    if ('severity' in body) {
      const severity = str(body['severity'], 16);
      if (!severity || !SEVERITIES.has(severity))
        return bad(c, 'severity must be info | warn | critical');
      patch.severity = severity;
    }
    if ('startsAtMs' in body)
      patch.startsAt =
        body['startsAtMs'] === null ? null : new Date(num(body['startsAtMs']) ?? NaN);
    if ('endsAtMs' in body)
      patch.endsAt = body['endsAtMs'] === null ? null : new Date(num(body['endsAtMs']) ?? NaN);
    if (
      (patch.startsAt && Number.isNaN(patch.startsAt.getTime())) ||
      (patch.endsAt && Number.isNaN(patch.endsAt.getTime()))
    ) {
      return bad(c, 'startsAtMs / endsAtMs must be epoch ms or null');
    }
    await deps.db.update(adminNotices).set(patch).where(eq(adminNotices.id, id));
    const [after] = await deps.db
      .select()
      .from(adminNotices)
      .where(eq(adminNotices.id, id))
      .limit(1);
    await audited(
      c,
      'comms.notice_update',
      String(id),
      serialise(before),
      after ? serialise(after) : null,
    );
    return c.json({ ok: true, notice: after ? serialise(after) : null });
  });

  app.delete('/admin/notices/:id', requireAdmin('moderator'), async (c) => {
    const deps = c.get('deps');
    const id = int(c.req.param('id'));
    if (id === undefined) return bad(c, 'bad id');
    const [before] = await deps.db
      .select()
      .from(adminNotices)
      .where(eq(adminNotices.id, id))
      .limit(1);
    if (!before) return bad(c, 'no such notice', 404);
    await deps.db.delete(adminNotices).where(eq(adminNotices.id, id));
    await audited(c, 'comms.notice_delete', String(id), serialise(before), null);
    return c.json({ ok: true });
  });

  /** Mememan speaks: a system line in GLOBAL chat on one net or all of them. */
  app.post('/admin/comms/announce', requireAdmin('moderator'), async (c) => {
    const deps = c.get('deps');
    const body = await readBody(c);
    const text = str(body['text'], 280);
    if (!text) return bad(c, 'text is required');
    const netRaw = body['net'];
    const nets: Net[] =
      netRaw === 'ALL' || netRaw === undefined
        ? [...ALL_NETS]
        : [parseNet(String(netRaw))].filter((n): n is Net => n !== null);
    if (nets.length === 0) return bad(c, 'net must be a known net or ALL');
    if (!confirmed(body, 'ANNOUNCE')) return bad(c, 'confirm with "ANNOUNCE"');
    const ids: Record<string, number> = {};
    for (const net of nets) {
      const [row] = await deps.db
        .insert(chatMessages)
        .values({
          net,
          room: 'GLOBAL',
          wallet: MEMEMAN_WALLET,
          text,
          flagged: false,
          createdAt: new Date(deps.now()),
        })
        .returning();
      if (!row) continue;
      ids[net] = row.id;
      await deps.publisher.chat(net, 'GLOBAL', {
        type: 'message',
        net,
        room: 'GLOBAL',
        id: row.id,
        wallet: MEMEMAN_WALLET,
        text,
        createdAtMs: row.createdAt.getTime(),
        username: 'MEMEMAN',
        avatarUrl: null,
      });
    }
    await audited(c, 'comms.announce', nets.join(','), null, { text, ids });
    return c.json({ ok: true, ids });
  });

  return app;
}
