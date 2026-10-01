import { ALL_NETS, type Net } from '@stonkz/shared';
import type { Logger } from '@stonkz/api/observability/logger';
import type { AlertHook } from '@stonkz/api/observability/metrics';
import type { CatchupBacklog } from './source.js';

/**
 * Per-chain catch-up backlog: what a signature-paged source (Solana) still
 * has to walk between the cursor and the tip, and for how long it has been
 * that way.
 *
 * This exists because a backlog is *not* a failure. Before it, the only way
 * the runner could say "this range has more pages than one pass can hold" was
 * `SolanaRangeTooBusyError`, which went through the failure path, counted
 * towards `INDEXER_MAX_BATCH_ATTEMPTS`, and dead-lettered the range — losing
 * every fill in it after an outage on a busy program. Now the source reports
 * partial progress and the runner feeds it here instead, where it becomes:
 *
 * - a gauge (`stonkz_indexer_solana_catchup_backlog`) on `/metrics` and a
 *   `catchupBacklog` field on `/health`, read from {@link snapshot};
 * - a `chain-lag`-style edge-triggered alert, `solana-catchup-backlog:<net>`,
 *   once the backlog has persisted for `alertAfterMs` (default 10 minutes), with
 *   a `RESOLVED:` line when it clears;
 * - one `warn` log line per `logEveryMs` (default 60s) while the walk is in
 *   progress — never one per pass, because a catch-up runs hundreds of passes.
 *
 * The alert goes through the same {@link AlertHook} shape as `Metrics`, so
 * whatever sink the API wires for `chain-lag` sees this too.
 */
export interface CatchupMonitorOptions {
  logger: Logger;
  onAlert?: AlertHook;
  /** How long a backlog may persist before it alerts. `INDEXER_CATCHUP_ALERT_AFTER_MS`. */
  alertAfterMs?: number;
  /** Minimum gap between two progress log lines for one chain. */
  logEveryMs?: number;
  now?: () => number;
}

export interface CatchupState {
  net: Net;
  /** Estimated signatures still to ingest; 0 when caught up. */
  remaining: number;
  /** Whether the estimate covers the whole gap (the walk reached the cursor). */
  located: boolean;
  /** When the current backlog was first observed; `null` when there is none. */
  since: number | null;
  /** Passes observed since the backlog began. */
  passes: number;
  /** Signature pages spent since the backlog began. */
  pages: number;
  alerting: boolean;
}

const ALERT_KEY = (net: Net): string => `solana-catchup-backlog:${net}`;

export class CatchupMonitor {
  private readonly logger: Logger;
  private readonly onAlert: AlertHook;
  private readonly alertAfterMs: number;
  private readonly logEveryMs: number;
  private readonly now: () => number;
  private readonly state: Record<Net, CatchupState>;
  private readonly lastLoggedAt: Record<Net, number>;

  constructor(opts: CatchupMonitorOptions) {
    this.logger = opts.logger;
    this.onAlert = opts.onAlert ?? (() => {});
    this.alertAfterMs = Math.max(0, opts.alertAfterMs ?? 10 * 60_000);
    this.logEveryMs = Math.max(0, opts.logEveryMs ?? 60_000);
    this.now = opts.now ?? Date.now;
    this.state = Object.fromEntries(ALL_NETS.map((net) => [net, idle(net)])) as Record<
      Net,
      CatchupState
    >;
    this.lastLoggedAt = Object.fromEntries(
      ALL_NETS.map((net) => [net, Number.NEGATIVE_INFINITY]),
    ) as Record<Net, number>;
  }

  /**
   * Records what one pass reported. A backlog of zero on a complete pass
   * clears the chain; anything else extends the current backlog episode (or
   * starts one) and may log or alert.
   */
  observe(net: Net, backlog: CatchupBacklog, context: { from: number; to: number }): void {
    const now = this.now();
    const current = this.state[net];
    const active = backlog.remaining > 0 || backlog.partial || !backlog.located;

    if (!active) {
      this.clear(net);
      return;
    }

    const since = current.since ?? now;
    const next: CatchupState = {
      net,
      remaining: backlog.remaining,
      located: backlog.located,
      since,
      passes: current.passes + 1,
      pages: current.pages + backlog.pages,
      alerting: current.alerting,
    };
    this.state[net] = next;

    if (now - this.lastLoggedAt[net] >= this.logEveryMs) {
      this.lastLoggedAt[net] = now;
      this.logger.warn('catch-up in progress; the cursor advances as pages are walked', {
        net,
        from: context.from,
        to: context.to,
        remaining: backlog.remaining,
        located: backlog.located,
        passes: next.passes,
        pages: next.pages,
        forSeconds: Math.round((now - since) / 1000),
      });
    }

    if (!next.alerting && now - since >= this.alertAfterMs) {
      next.alerting = true;
      this.onAlert({
        key: ALERT_KEY(net),
        severity: 'critical',
        message: `${net} indexer catch-up backlog has persisted for ${Math.round(this.alertAfterMs / 60_000)}m`,
        fields: {
          net,
          remaining: backlog.remaining,
          located: backlog.located,
          forSeconds: Math.round((now - since) / 1000),
          passes: next.passes,
        },
      });
    }
  }

  /** A pass that walked its whole range with nothing left over. */
  clear(net: Net): void {
    const current = this.state[net];
    if (current.since === null) return;
    const now = this.now();
    this.logger.info('catch-up complete', {
      net,
      passes: current.passes,
      pages: current.pages,
      forSeconds: Math.round((now - current.since) / 1000),
    });
    if (current.alerting) {
      this.onAlert({
        key: ALERT_KEY(net),
        severity: 'warn',
        message: `RESOLVED: ${net} indexer catch-up backlog has persisted for ${Math.round(this.alertAfterMs / 60_000)}m`,
        fields: { net, forSeconds: Math.round((now - current.since) / 1000) },
      });
    }
    this.state[net] = idle(net);
    this.lastLoggedAt[net] = Number.NEGATIVE_INFINITY;
  }

  snapshot(): Record<Net, CatchupState> {
    return {
      SOL: { ...this.state.SOL },
      RH: { ...this.state.RH },
      BASE: { ...this.state.BASE },
      ARC: { ...this.state.ARC },
    };
  }
}

function idle(net: Net): CatchupState {
  return { net, remaining: 0, located: true, since: null, passes: 0, pages: 0, alerting: false };
}
