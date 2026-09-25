import { ALL_NETS, type Net } from '@stonkz/shared';
import type { Logger } from './logger.js';

export type AlertSeverity = 'warn' | 'critical';

export interface Alert {
  key: string;
  severity: AlertSeverity;
  message: string;
  fields: Record<string, unknown>;
}

export type AlertHook = (alert: Alert) => void;

export interface ChainLag {
  net: Net;
  /** Chain head minus indexer cursor, in slots/blocks. */
  behind: number;
  /** …converted to seconds using the chain's nominal tick. */
  seconds: number;
  /** Whether it crossed `MAX_CHAIN_LAG_SECONDS`. */
  alerting: boolean;
}

export interface MetricsSnapshot {
  uptimeSeconds: number;
  requests: {
    total: number;
    byStatusClass: Record<string, number>;
    inFlight: number;
    p50Ms: number;
    p95Ms: number;
  };
  ws: {
    /** The plan's step-46 WS gauge. */
    connections: number;
    peakConnections: number;
    subscriptions: number;
    messagesSent: number;
  };
  rpc: Record<Net, { calls: number; errors: number; errorRate: number }>;
  chainLag: Record<Net, ChainLag>;
}

const NETS: readonly Net[] = ALL_NETS;

/**
 * In-process counters. Deliberately not Prometheus: the plan asks for request
 * logs, a WS gauge, per-chain indexer lag and an RPC error rate, and a scrape
 * endpoint can be layered on this snapshot later without changing call sites.
 */
export class Metrics {
  private started: number;
  private requestTotal = 0;
  private inFlight = 0;
  private readonly statusClasses = new Map<string, number>();
  /** Ring buffer of recent durations; percentiles come from this. */
  private readonly durations: number[] = [];
  private static readonly DURATION_WINDOW = 512;

  private wsConnections = 0;
  private wsPeak = 0;
  private wsSubscriptions = 0;
  private wsMessagesSent = 0;

  private readonly rpcCalls: Record<Net, number> = { SOL: 0, RH: 0, BASE: 0 };
  private readonly rpcErrors: Record<Net, number> = { SOL: 0, RH: 0, BASE: 0 };
  private readonly lag: Record<Net, ChainLag> = {
    SOL: { net: 'SOL', behind: 0, seconds: 0, alerting: false },
    RH: { net: 'RH', behind: 0, seconds: 0, alerting: false },
    BASE: { net: 'BASE', behind: 0, seconds: 0, alerting: false },
  };

  /** Alerts are edge-triggered: one per transition, not one per observation. */
  private readonly alerting = new Set<string>();

  constructor(
    private readonly maxChainLagSeconds: number,
    private readonly onAlert: AlertHook = () => {},
    private readonly now: () => number = Date.now,
  ) {
    this.started = this.now();
  }

  requestStarted(): void {
    this.inFlight++;
  }

  requestFinished(status: number, durationMs: number): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.requestTotal++;
    const cls = `${Math.floor(status / 100)}xx`;
    this.statusClasses.set(cls, (this.statusClasses.get(cls) ?? 0) + 1);
    this.durations.push(durationMs);
    if (this.durations.length > Metrics.DURATION_WINDOW) this.durations.shift();
  }

  wsConnected(): void {
    this.wsConnections++;
    if (this.wsConnections > this.wsPeak) this.wsPeak = this.wsConnections;
  }

  wsDisconnected(): void {
    this.wsConnections = Math.max(0, this.wsConnections - 1);
  }

  wsSubscriptionsChanged(delta: number): void {
    this.wsSubscriptions = Math.max(0, this.wsSubscriptions + delta);
  }

  wsMessageSent(count = 1): void {
    this.wsMessagesSent += count;
  }

  rpcCall(net: Net, ok: boolean): void {
    this.rpcCalls[net]++;
    if (!ok) this.rpcErrors[net]++;
    const calls = this.rpcCalls[net];
    const rate = calls === 0 ? 0 : this.rpcErrors[net] / calls;
    // Only meaningful once there is a sample worth believing.
    this.edge(
      `rpc-errors:${net}`,
      calls >= 20 && rate > 0.25,
      'warn',
      `${net} RPC error rate is high`,
      {
        net,
        calls,
        errors: this.rpcErrors[net],
        errorRate: Number(rate.toFixed(3)),
      },
    );
  }

  /**
   * Plan step 46: alert if either chain's lag exceeds 30 seconds. `tickMs` is
   * the chain's nominal slot/block time, which is how a cursor distance becomes
   * a duration.
   */
  observeChainLag(net: Net, cursorPosition: number, chainHead: number, tickMs: number): ChainLag {
    const behind = Math.max(0, chainHead - cursorPosition);
    const seconds = (behind * tickMs) / 1000;
    const alerting = seconds > this.maxChainLagSeconds;
    const lag: ChainLag = { net, behind, seconds, alerting };
    this.lag[net] = lag;
    this.edge(
      `chain-lag:${net}`,
      alerting,
      'critical',
      `${net} indexer lag exceeds ${this.maxChainLagSeconds}s`,
      { net, behind, seconds: Number(seconds.toFixed(1)), threshold: this.maxChainLagSeconds },
    );
    return lag;
  }

  private edge(
    key: string,
    active: boolean,
    severity: AlertSeverity,
    message: string,
    fields: Record<string, unknown>,
  ): void {
    const wasActive = this.alerting.has(key);
    if (active && !wasActive) {
      this.alerting.add(key);
      this.onAlert({ key, severity, message, fields });
    } else if (!active && wasActive) {
      this.alerting.delete(key);
      this.onAlert({ key, severity: 'warn', message: `RESOLVED: ${message}`, fields });
    }
  }

  private percentile(p: number): number {
    if (this.durations.length === 0) return 0;
    const sorted = [...this.durations].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return Number((sorted[idx] ?? 0).toFixed(2));
  }

  snapshot(): MetricsSnapshot {
    const rpc = {} as MetricsSnapshot['rpc'];
    for (const net of NETS) {
      const calls = this.rpcCalls[net];
      rpc[net] = {
        calls,
        errors: this.rpcErrors[net],
        errorRate: calls === 0 ? 0 : Number((this.rpcErrors[net] / calls).toFixed(4)),
      };
    }
    return {
      uptimeSeconds: Math.floor((this.now() - this.started) / 1000),
      requests: {
        total: this.requestTotal,
        byStatusClass: Object.fromEntries(this.statusClasses),
        inFlight: this.inFlight,
        p50Ms: this.percentile(50),
        p95Ms: this.percentile(95),
      },
      ws: {
        connections: this.wsConnections,
        peakConnections: this.wsPeak,
        subscriptions: this.wsSubscriptions,
        messagesSent: this.wsMessagesSent,
      },
      rpc,
      chainLag: { SOL: this.lag.SOL, RH: this.lag.RH, BASE: this.lag.BASE },
    };
  }
}

/** The default hook: alerts become structured log lines at the right level. */
export function loggingAlertHook(logger: Logger): AlertHook {
  return (alert) => {
    const fields = { alert: alert.key, ...alert.fields };
    if (alert.severity === 'critical') logger.error(alert.message, fields);
    else logger.warn(alert.message, fields);
  };
}
