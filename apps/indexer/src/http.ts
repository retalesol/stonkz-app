import { createServer, type Server } from 'node:http';
import type { Net } from '@stonkz/shared';
import type { Logger } from '@stonkz/api/observability/logger';
import type { CursorState, ReplayCursors } from './cursors.js';
import type { DeadLetters } from './deadletter.js';

/**
 * The indexer's operability surface.
 *
 * `docs/indexer-runbooks.md` used to say, accurately, that the indexer had no
 * HTTP server: the only way to see whether it was alive was to read its logs
 * or query `indexer_cursors` by hand, and there was nothing to point a scraper
 * or a liveness probe at. Three routes close that:
 *
 * - `GET /health` — 200 while both chains are inside their lag budget,
 *   503 otherwise, with the per-chain detail in the body. This is the shape a
 *   container orchestrator's readiness probe wants.
 * - `GET /metrics` — Prometheus text format.
 * - `GET /dead-letters` — the open dead letters as JSON, so triage does not
 *   require a database session.
 *
 * Everything is served straight off `indexer_cursors` and
 * `indexer_dead_letters` rather than from in-process counters. That is
 * deliberate: an in-process counter resets on restart and lies about a
 * crash-looping replica, whereas the cursor row is the same thing the next
 * replica will resume from. What an operator sees is what ingest will do.
 */
export interface IndexerHttpOptions {
  cursors: ReplayCursors;
  deadLetters: DeadLetters;
  logger: Logger;
  host: string;
  port: number;
  /** Nominal slot/block time per chain, for turning a position gap into seconds. */
  tickMs: Record<Net, number>;
  /** Lag budget in seconds; over it, `/health` fails. Matches `ApiEnv.maxChainLagSeconds`. */
  maxLagSeconds: number;
  /** `fixtures` | `chain`, reported so a dashboard cannot mistake one for the other. */
  mode: string;
  /** Whether this replica holds the single-writer lock. */
  isLeader: () => boolean;
  now?: () => number;
}

export interface ChainHealth {
  net: Net;
  position: number;
  chainHead: number;
  confirmedHead: number;
  /** Confirmed head minus cursor: what ingest still owes, excluding the buffer. */
  behind: number;
  behindSeconds: number;
  /** Raw head minus cursor: includes the confirmation buffer, so never 0 in chain mode. */
  behindRaw: number;
  reorgs: number;
  failedAttempts: number
  deadLetters: number;
  lastError: string | null;
  lastEventAgeSeconds: number | null;
  healthy: boolean;
}

export interface IndexerHealth {
  ok: boolean;
  mode: string;
  leader: boolean;
  chains: ChainHealth[];
}

const NETS: readonly Net[] = ['SOL', 'RH'];

export async function readHealth(opts: IndexerHttpOptions): Promise<IndexerHealth> {
  const now = (opts.now ?? Date.now)();
  const chains: ChainHealth[] = [];

  for (const net of NETS) {
    const cursor = await opts.cursors.read(net);
    const deadLetters = await opts.deadLetters.countOpen(net);
    chains.push(chainHealthOf(cursor, deadLetters, opts, now));
  }

  // A replica that does not hold the lock is *healthy* — it is correctly
  // standing by. Reporting it unhealthy would make an orchestrator restart the
  // one replica that is behaving.
  return {
    ok: chains.every((c) => c.healthy),
    mode: opts.mode,
    leader: opts.isLeader(),
    chains,
  };
}

function chainHealthOf(
  cursor: CursorState,
  deadLetters: number,
  opts: IndexerHttpOptions,
  now: number,
): ChainHealth {
  // Lag is measured against the *confirmed* head, not the raw head. Measuring
  // against the raw head would report every correctly-buffered chain as
  // permanently behind by its own confirmation depth, which would make the
  // metric useless on Robinhood Chain and turn the alert into noise.
  const behind = Math.max(0, cursor.confirmedHead - cursor.position);
  const behindSeconds = (behind * (opts.tickMs[cursor.net] ?? 1_000)) / 1000;
  return {
    net: cursor.net,
    position: cursor.position,
    chainHead: cursor.chainHead,
    confirmedHead: cursor.confirmedHead,
    behind,
    behindSeconds,
    behindRaw: Math.max(0, cursor.chainHead - cursor.position),
    reorgs: cursor.reorgs,
    failedAttempts: cursor.failedAttempts,
    deadLetters,
    lastError: cursor.lastError,
    lastEventAgeSeconds: cursor.lastEventAt === null ? null : (now - cursor.lastEventAt) / 1000,
    healthy: behindSeconds <= opts.maxLagSeconds,
  };
}

/* -------------------------------------------------------------- Prometheus */

function metricLines(name: string, help: string, type: string, samples: [string, number][]): string[] {
  if (samples.length === 0) return [];
  return [
    `# HELP ${name} ${help}`,
    `# TYPE ${name} ${type}`,
    ...samples.map(([labels, value]) => `${name}${labels} ${value}`),
  ];
}

/** Prometheus text exposition format, version 0.0.4. */
export function renderPrometheus(health: IndexerHealth): string {
  const byNet = (pick: (c: ChainHealth) => number): [string, number][] =>
    health.chains.map((c) => [`{net="${c.net}"}`, pick(c)]);

  const lines = [
    ...metricLines(
      'stonkz_indexer_up',
      '1 when every chain is inside its lag budget.',
      'gauge',
      [['', health.ok ? 1 : 0]],
    ),
    ...metricLines(
      'stonkz_indexer_leader',
      '1 when this replica holds the single-writer advisory lock.',
      'gauge',
      [['', health.leader ? 1 : 0]],
    ),
    ...metricLines(
      'stonkz_indexer_cursor_position',
      'Last committed slot (SOL) or block (RH).',
      'gauge',
      byNet((c) => c.position),
    ),
    ...metricLines(
      'stonkz_indexer_chain_head',
      'Raw chain head as last observed.',
      'gauge',
      byNet((c) => c.chainHead),
    ),
    ...metricLines(
      'stonkz_indexer_confirmed_head',
      'Highest position ingest may materialise: head minus the confirmation depth.',
      'gauge',
      byNet((c) => c.confirmedHead),
    ),
    ...metricLines(
      'stonkz_indexer_lag_positions',
      'Confirmed head minus cursor, in slots or blocks.',
      'gauge',
      byNet((c) => c.behind),
    ),
    ...metricLines(
      'stonkz_indexer_lag_seconds',
      'Confirmed head minus cursor, converted with the chain tick.',
      'gauge',
      byNet((c) => c.behindSeconds),
    ),
    ...metricLines(
      'stonkz_indexer_confirmation_buffer_positions',
      'Raw head minus cursor. Exceeds lag_positions by the confirmation depth, by design.',
      'gauge',
      byNet((c) => c.behindRaw),
    ),
    ...metricLines(
      'stonkz_indexer_reorgs_total',
      'Reorgs detected at the cursor since the row was created.',
      'counter',
      byNet((c) => c.reorgs),
    ),
    ...metricLines(
      'stonkz_indexer_dead_letters_open',
      'Unresolved dead-lettered events and batches.',
      'gauge',
      byNet((c) => c.deadLetters),
    ),
    ...metricLines(
      'stonkz_indexer_failed_attempts',
      'Consecutive failed passes at the current position. Reaching INDEXER_MAX_BATCH_ATTEMPTS dead-letters the batch.',
      'gauge',
      byNet((c) => c.failedAttempts),
    ),
    ...metricLines(
      'stonkz_indexer_last_event_age_seconds',
      'Seconds since the last accepted event. Absent for a chain that has never seen one.',
      'gauge',
      health.chains
        .filter((c) => c.lastEventAgeSeconds !== null)
        .map((c) => [`{net="${c.net}"}`, c.lastEventAgeSeconds ?? 0] as [string, number]),
    ),
    ...metricLines(
      'stonkz_indexer_chain_healthy',
      '1 when this chain is inside its lag budget.',
      'gauge',
      byNet((c) => (c.healthy ? 1 : 0)),
    ),
  ];

  return `${lines.join('\n')}\n`;
}

/* ------------------------------------------------------------------ server */

/**
 * Starts the surface, or returns `null` when `port` is 0.
 *
 * A disabled port is a supported configuration, not a degraded one: a local
 * `pnpm dev` run does not need a scrape endpoint, and two developers running
 * the indexer would otherwise collide on it.
 */
export function startIndexerHttp(opts: IndexerHttpOptions): Server | null {
  if (opts.port <= 0) {
    opts.logger.info('indexer http surface disabled', { reason: 'INDEXER_HTTP_PORT=0' });
    return null;
  }

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];

    const send = (status: number, body: string, contentType: string): void => {
      res.writeHead(status, {
        'content-type': contentType,
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
    };

    void (async () => {
      try {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          send(405, 'method not allowed\n', 'text/plain; charset=utf-8');
          return;
        }

        switch (path) {
          case '/health':
          case '/healthz': {
            const health = await readHealth(opts);
            send(health.ok ? 200 : 503, `${JSON.stringify(health, null, 2)}\n`, 'application/json');
            return;
          }
          case '/metrics': {
            const health = await readHealth(opts);
            send(200, renderPrometheus(health), 'text/plain; version=0.0.4; charset=utf-8');
            return;
          }
          case '/dead-letters': {
            const rows = await opts.deadLetters.open(undefined, 200);
            send(200, `${JSON.stringify({ count: rows.length, rows }, null, 2)}\n`, 'application/json');
            return;
          }
          default:
            send(404, 'not found\n', 'text/plain; charset=utf-8');
        }
      } catch (err) {
        // A failed probe must be a 500, never a hang: a liveness probe that
        // times out looks the same as a dead process to an orchestrator, and
        // the distinction matters when the cause is the database rather than
        // the indexer.
        const message = err instanceof Error ? err.message : String(err);
        opts.logger.error('indexer http request failed', { path, err: message });
        send(500, `${JSON.stringify({ ok: false, error: message })}\n`, 'application/json');
      }
    })();
  });

  server.listen(opts.port, opts.host, () => {
    opts.logger.info('indexer http surface listening', {
      host: opts.host,
      port: opts.port,
      routes: ['/health', '/metrics', '/dead-letters'],
    });
  });

  return server;
}
