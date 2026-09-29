import { Hono } from 'hono';
import { isNull, sql } from 'drizzle-orm';
import { ALL_NETS, type Net } from '@stonkz/shared';
import { requireAdmin, type AdminEnv } from '../admin/middleware.js';
import { pendingIndexerCommands } from '../admin/indexer-control.js';
import { dashboardStats } from '../admin/stats.js';
import { indexerCursors, indexerDeadLetters } from '../db/schema.js';
import { isNetDeployed } from './health.js';

/** `GET /admin/dashboard` — health, per-net lag, RPC error rates, WS gauge, volumes, top tokens, alerts. */
export function adminDashboardRoutes(): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();

  app.get('/admin/dashboard', requireAdmin('viewer'), async (c) => {
    const deps = c.get('deps');
    const now = deps.now();

    const cursors = await deps.db
      .select()
      .from(indexerCursors)
      .catch(() => []);
    const heads = await Promise.all(
      ALL_NETS.map(async (net) => {
        if (!isNetDeployed(deps.env, net))
          return { net, head: null as number | null, error: 'not deployed' };
        try {
          return { net, head: await deps.rpcs[net].head(), error: null as string | null };
        } catch (err) {
          return {
            net,
            head: null as number | null,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );

    const chains = {} as Record<
      Net,
      {
        deployed: boolean;
        head: number | null;
        cursor: number;
        confirmedHead: number;
        behind: number | null;
        lagSeconds: number | null;
        failedAttempts: number;
        reorgs: number;
        lastError: string | null;
        lastErrorAt: number | null;
        lastEventAt: number | null;
        error: string | null;
      }
    >;
    for (const net of ALL_NETS) {
      const row = cursors.find((r) => r.net === net);
      const probe = heads.find((h) => h.net === net);
      const head = probe?.head ?? null;
      const cursor = row?.position ?? 0;
      const buffer = Math.max(0, (row?.chainHead ?? 0) - (row?.confirmedHead ?? 0));
      const behind = head === null ? null : Math.max(0, head - buffer - cursor);
      chains[net] = {
        deployed: isNetDeployed(deps.env, net),
        head,
        cursor,
        confirmedHead: row?.confirmedHead ?? 0,
        behind,
        lagSeconds:
          behind === null ? null : Number(((behind * deps.env.chainTickMs[net]) / 1000).toFixed(1)),
        failedAttempts: row?.failedAttempts ?? 0,
        reorgs: row?.reorgs ?? 0,
        lastError: row?.lastError ?? null,
        lastErrorAt: row?.lastErrorAt?.getTime() ?? null,
        lastEventAt: row?.lastEventAt?.getTime() ?? null,
        error: probe?.error ?? null,
      };
    }

    const [stats, deadLetters, pendingCommands] = await Promise.all([
      dashboardStats(deps.db, now),
      deps.db
        .select({ net: indexerDeadLetters.net, n: sql<number>`count(*)::int` })
        .from(indexerDeadLetters)
        .where(isNull(indexerDeadLetters.resolvedAt))
        .groupBy(indexerDeadLetters.net)
        .catch(() => []),
      pendingIndexerCommands(deps.redis),
    ]);

    const metrics = deps.metrics.snapshot();
    const alerts: { severity: 'warn' | 'critical'; key: string; message: string }[] = [];
    for (const net of ALL_NETS) {
      const ch = chains[net];
      if (!ch.deployed) continue;
      if (ch.error)
        alerts.push({
          severity: 'critical',
          key: `rpc-down:${net}`,
          message: `${net} RPC unreachable: ${ch.error}`,
        });
      else if (ch.lagSeconds !== null && ch.lagSeconds > deps.env.maxChainLagSeconds)
        alerts.push({
          severity: 'critical',
          key: `chain-lag:${net}`,
          message: `${net} indexer ${ch.lagSeconds}s behind`,
        });
      if (metrics.rpc[net].calls >= 20 && metrics.rpc[net].errorRate > 0.25)
        alerts.push({
          severity: 'warn',
          key: `rpc-errors:${net}`,
          message: `${net} RPC error rate ${(metrics.rpc[net].errorRate * 100).toFixed(0)}%`,
        });
      if (ch.failedAttempts > 0)
        alerts.push({
          severity: 'warn',
          key: `ingest-failing:${net}`,
          message: `${net} ingest failing at ${ch.cursor} (${ch.failedAttempts} attempts)`,
        });
    }
    const openDead = deadLetters.reduce((a, r) => a + r.n, 0);
    if (openDead > 0)
      alerts.push({
        severity: 'warn',
        key: 'dead-letters',
        message: `${openDead} open dead letter(s)`,
      });
    const banner = deps.admin.settings.banner();
    if (banner.text)
      alerts.push({
        severity: 'warn',
        key: 'banner',
        message: `maintenance banner live: ${banner.text}`,
      });
    for (const net of ALL_NETS) {
      if (!deps.admin.settings.launchEnabled(net))
        alerts.push({
          severity: 'warn',
          key: `launch-off:${net}`,
          message: `launches disabled on ${net}`,
        });
      if (!deps.admin.settings.tradingEnabled(net))
        alerts.push({
          severity: 'warn',
          key: `trading-off:${net}`,
          message: `trading disabled on ${net}`,
        });
    }
    if (!deps.admin.settings.chatEnabled())
      alerts.push({ severity: 'warn', key: 'chat-off', message: 'chat disabled' });

    return c.json({
      now,
      uptimeSeconds: metrics.uptimeSeconds,
      requests: metrics.requests,
      ws: metrics.ws,
      rpc: metrics.rpc,
      chains,
      stats,
      deadLetters: Object.fromEntries(deadLetters.map((r) => [r.net, r.n])),
      pendingIndexerCommands: pendingCommands.length,
      alerts,
    });
  });

  return app;
}
