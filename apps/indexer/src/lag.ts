import type { Net } from '@stonkz/shared';
import type { ChainRpcs } from '@stonkz/api/chain/types';
import type { Logger } from '@stonkz/api/observability/logger';
import type { Metrics, ChainLag } from '@stonkz/api/observability/metrics';
import type { ReplayCursors } from './cursors.js';

export interface LagMonitorOptions {
  cursors: ReplayCursors;
  rpcs: ChainRpcs;
  metrics: Metrics;
  logger: Logger;
  /** Nominal slot/block time per chain, from `ApiEnv.chainTickMs`. */
  tickMs: Record<Net, number>;
}

/**
 * Per-chain lag, measured and alerted on independently (plan step 46).
 *
 * `Metrics.observeChainLag` owns the >30s threshold and edge-triggers the
 * alert, so one chain falling behind never suppresses or duplicates the
 * other's alert, and a flapping RPC does not produce a stream of identical
 * pages.
 */
export class LagMonitor {
  constructor(private readonly opts: LagMonitorOptions) {}

  async check(net: Net): Promise<ChainLag | null> {
    try {
      const head = await this.opts.rpcs[net].head();
      await this.opts.cursors.observeHead(net, head);
      const cursor = await this.opts.cursors.read(net);
      const lag = this.opts.metrics.observeChainLag(
        net,
        cursor.position,
        head,
        this.opts.tickMs[net],
      );
      this.opts.logger.debug('chain lag', {
        net,
        head,
        cursor: cursor.position,
        behind: lag.behind,
        seconds: Number(lag.seconds.toFixed(1)),
      });
      return lag;
    } catch (err) {
      this.opts.metrics.rpcCall(net, false);
      this.opts.logger.error('lag probe failed', {
        net,
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async checkAll(): Promise<Record<Net, ChainLag | null>> {
    const [sol, rh, base] = await Promise.all([
      this.check('SOL'),
      this.check('RH'),
      this.check('BASE'),
    ]);
    return { SOL: sol, RH: rh, BASE: base };
  }
}
