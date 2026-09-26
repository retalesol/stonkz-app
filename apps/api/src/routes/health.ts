import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { ALL_NETS, isEvmNet, type Net } from '@stonkz/shared';
import { ZERO_EVM_ADDRESS, type ApiEnv } from '../env.js';
import { evmLaunchpadAddress } from '../chain/evm-net.js';
import { indexerCursors } from '../db/schema.js';
import { listAppliedMigrations } from '../db/migrate.js';
import type { AppDeps, AppEnv } from '../app/context.js';

export type ComponentStatus = 'ok' | 'degraded' | 'down';

export interface HealthReport {
  status: ComponentStatus;
  version: string;
  uptimeSeconds: number;
  api: { status: 'ok'; migrations: number };
  db: { status: ComponentStatus; latencyMs: number | null; error?: string };
  redis: { status: ComponentStatus; latencyMs: number | null; error?: string };
  chains: Record<
    Net,
    {
      status: ComponentStatus;
      /** Chain head as the RPC reports it. */
      head: number | null;
      /** Where the indexer has committed to. */
      cursor: number;
      /** Head minus cursor, in slots/blocks. */
      behind: number | null;
      /** …and in seconds, which is what the >30s alert fires on. */
      lagSeconds: number | null;
      alerting: boolean;
      error?: string;
      /** `false` when this env has no launchpad on the net: not probed, never a reason to be down. */
      deployed: boolean;
    }
  >;
  metrics: ReturnType<AppDeps['metrics']['snapshot']>;
}

/**
 * An EVM net with no launchpad configured is not part of this environment
 * (Arc before its deploy, RH on a Base-only stack). Its RPC is not probed and
 * it cannot drag `/health` to 503; the picker shows it as "not deployed".
 * Solana is always probed: the API refuses to boot without its program id.
 */
export function isNetDeployed(env: ApiEnv, net: Net): boolean {
  return !isEvmNet(net) || evmLaunchpadAddress(env, net) !== ZERO_EVM_ADDRESS;
}

async function timed<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; ms: number; value: T } | { ok: false; ms: number; error: string }> {
  const started = Date.now();
  try {
    const value = await fn();
    return { ok: true, ms: Date.now() - started, value };
  } catch (err) {
    return {
      ok: false,
      ms: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * `GET /health` — plan step 44: api, db, redis, Solana RPC lag, RH RPC lag.
 *
 * Chain lag is measured as the distance between the RPC's head and the
 * indexer's committed cursor, converted to seconds with the chain's nominal
 * tick. Every probe is also fed to `Metrics`, so the >30s alert hook fires from
 * a health check as well as from the indexer loop.
 */
export function healthRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/health', async (c) => {
    const deps = c.get('deps');
    const nets: Net[] = ALL_NETS.filter((n) => isNetDeployed(deps.env, n));
    const skipped: Net[] = ALL_NETS.filter((n) => !isNetDeployed(deps.env, n));

    const cursorRows = await deps.db
      .select()
      .from(indexerCursors)
      .catch(() => []);
    const cursorByNet = new Map(cursorRows.map((r) => [r.net, r.position]));
    // The indexer commits only up to its confirmed head, so it always trails
    // the raw head by the chain's confirmation depth (12 blocks on RH). That
    // buffer is not lag: it is read back off the cursor row as the gap the
    // indexer last observed between the raw and confirmed heads.
    const bufferByNet = new Map(
      cursorRows.map((r) => [r.net, Math.max(0, (r.chainHead ?? 0) - (r.confirmedHead ?? 0))]),
    );

    const [dbProbe, redisProbe, ...chainProbes] = await Promise.all([
      timed(() => deps.db.execute(sql`select 1`)),
      timed(() => deps.redis.ping()),
      ...nets.map((net) => timed(() => deps.rpcs[net].head())),
    ]);

    const chains = {} as HealthReport['chains'];
    for (const net of skipped) {
      chains[net] = {
        status: 'ok',
        head: null,
        cursor: cursorByNet.get(net) ?? 0,
        behind: null,
        lagSeconds: null,
        alerting: false,
        deployed: false,
        error: 'not deployed on this env',
      };
    }
    nets.forEach((net, i) => {
      const probe = chainProbes[i];
      const cursor = cursorByNet.get(net) ?? 0;
      if (!probe || !probe.ok) {
        deps.metrics.rpcCall(net, false);
        chains[net] = {
          status: 'down',
          head: null,
          cursor,
          behind: null,
          lagSeconds: null,
          alerting: true,
          deployed: true,
          error: probe && !probe.ok ? probe.error : 'probe missing',
        };
        return;
      }
      deps.metrics.rpcCall(net, true);
      const head = probe.value;
      const confirmedHead = Math.max(cursor, head - (bufferByNet.get(net) ?? 0));
      const lag = deps.metrics.observeChainLag(
        net,
        cursor,
        confirmedHead,
        deps.env.chainTickMs[net],
      );
      chains[net] = {
        status: lag.alerting ? 'degraded' : 'ok',
        head,
        cursor,
        behind: lag.behind,
        lagSeconds: Number(lag.seconds.toFixed(1)),
        alerting: lag.alerting,
        deployed: true,
      };
    });

    const migrations = await listAppliedMigrations(deps.db).catch(() => []);
    const dbStatus: ComponentStatus = dbProbe.ok ? 'ok' : 'down';
    const redisStatus: ComponentStatus = redisProbe.ok && redisProbe.value ? 'ok' : 'down';

    const anyDown =
      dbStatus === 'down' ||
      redisStatus === 'down' ||
      nets.some((n) => chains[n].status === 'down');
    const anyDegraded = nets.some((n) => chains[n].status === 'degraded');
    const status: ComponentStatus = anyDown ? 'down' : anyDegraded ? 'degraded' : 'ok';

    const report: HealthReport = {
      status,
      version: '0.1.0',
      uptimeSeconds: deps.metrics.snapshot().uptimeSeconds,
      api: { status: 'ok', migrations: migrations.length },
      db: {
        status: dbStatus,
        latencyMs: dbProbe.ms,
        ...(dbProbe.ok ? {} : { error: dbProbe.error }),
      },
      redis: {
        status: redisStatus,
        latencyMs: redisProbe.ms,
        ...(redisProbe.ok ? {} : { error: redisProbe.error }),
      },
      chains,
      metrics: deps.metrics.snapshot(),
    };

    // 503 so a load balancer drains the instance, while the body still explains why.
    return c.json(report, status === 'down' ? 503 : 200);
  });

  /** Liveness only — never touches a dependency, so a DB blip cannot kill the pod. */
  app.get('/health/live', (c) => c.json({ status: 'ok' }));

  return app;
}
