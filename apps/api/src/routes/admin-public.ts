import { Hono } from 'hono';
import { and, eq, isNull, or } from 'drizzle-orm';
import { ALL_NETS, parseNet } from '@stonkz/shared';
import type { AppEnv } from '../app/context.js';
import { limit } from '../app/middleware.js';
import { adminNotices } from '../db/schema.js';
import { RATE_LIMITS } from '../redis/ratelimit.js';

/**
 * `GET /platform/status` — the public read side of the admin panel's comms
 * and feature flags: the maintenance banner, active notices for a net, any
 * live/scheduled maintenance window and the per-net launch/trading switches.
 * The web shell polls it (`apps/web/src/admin/banner.ts`).
 */
export function platformRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/platform/status', limit(RATE_LIMITS.read), async (c) => {
    const deps = c.get('deps');
    const net = parseNet(c.req.query('net') ?? null);
    const now = deps.now();
    const settings = deps.admin.settings;

    const rows = await deps.db
      .select()
      .from(adminNotices)
      .where(
        and(
          eq(adminNotices.active, true),
          net ? or(isNull(adminNotices.net), eq(adminNotices.net, net)) : undefined,
        ),
      )
      .catch(() => []);
    const live = rows.filter(
      (r) =>
        (!r.startsAt || r.startsAt.getTime() <= now) && (!r.endsAt || r.endsAt.getTime() > now),
    );
    const upcoming = rows.filter(
      (r) => r.kind === 'maintenance' && r.startsAt && r.startsAt.getTime() > now,
    );

    const banner = settings.banner();
    return c.json({
      now,
      banner: banner.text ? banner : null,
      notices: live.map((r) => ({
        id: r.id,
        kind: r.kind,
        net: r.net,
        text: r.text,
        severity: r.severity,
        startsAt: r.startsAt?.getTime() ?? null,
        endsAt: r.endsAt?.getTime() ?? null,
      })),
      maintenance: {
        active: live.some((r) => r.kind === 'maintenance'),
        upcoming: upcoming.map((r) => ({
          id: r.id,
          text: r.text,
          startsAt: r.startsAt?.getTime() ?? null,
          endsAt: r.endsAt?.getTime() ?? null,
        })),
      },
      features: {
        chat: settings.chatEnabled(),
        launch: Object.fromEntries(ALL_NETS.map((n) => [n, settings.launchEnabled(n)])),
        trading: Object.fromEntries(ALL_NETS.map((n) => [n, settings.tradingEnabled(n)])),
      },
    });
  });

  return app;
}
