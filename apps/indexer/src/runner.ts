import type { Net } from '@stonkz/shared';
import type { Logger } from '@stonkz/api/observability/logger';
import type { PriceOracle } from '@stonkz/api/chain/types';
import { nativeUnit } from '@stonkz/shared';
import type { ReplayCursors } from './cursors.js';
import type { Ingestor, IngestReport } from './ingest.js';
import type { LagMonitor } from './lag.js';
import type { EventSource } from './source.js';

export interface RunnerOptions {
  cursors: ReplayCursors;
  ingestor: Ingestor;
  lag: LagMonitor;
  logger: Logger;
  oracle: PriceOracle;
  sources: Record<Net, EventSource>;
  /** Positions consumed per pass; keeps one pass bounded after a long outage. */
  batchSize?: number;
}

export interface PassResult {
  net: Net;
  from: number;
  to: number;
  report: IngestReport;
  caughtUp: boolean;
}

/**
 * One pass of the indexer loop, per chain.
 *
 * The cursor advances only after `apply()` returns, so a crash mid-batch
 * replays that batch — which is safe because ingest is idempotent on
 * `(net, tx_sig, log_index, kind)`. Nothing is committed optimistically.
 */
export class IndexerRunner {
  private readonly batchSize: number;

  constructor(private readonly opts: RunnerOptions) {
    this.batchSize = opts.batchSize ?? 5_000;
  }

  async pass(net: Net): Promise<PassResult> {
    const source = this.opts.sources[net];
    const head = await source.head();
    const cursor = await this.opts.cursors.read(net);
    // A zeroed cursor means "never indexed"; start at the deployment position
    // rather than walking 250 million empty Solana slots.
    const from =
      cursor.position > 0 ? cursor.position : Math.max(0, (await source.startPosition()) - 1);
    const to = Math.min(head, from + this.batchSize);

    if (to <= from) {
      await this.opts.cursors.observeHead(net, head);
      return {
        net,
        from,
        to: from,
        report: { accepted: 0, duplicates: 0, rejected: [], xpAwarded: 0, achievementsUnlocked: [], positions: {} },
        caughtUp: true,
      };
    }

    const events = await source.poll(from, to);
    const report = await this.opts.ingestor.apply(events);

    await this.opts.cursors.advance(net, to, { chainHead: head, sawEvent: report.accepted > 0 });
    await this.opts.lag.check(net);

    if (report.rejected.length > 0) {
      this.opts.logger.error('batch had rejected events', {
        net,
        from,
        to,
        rejected: report.rejected.length,
      });
    }
    this.opts.logger.info('batch ingested', {
      net,
      from,
      to,
      accepted: report.accepted,
      duplicates: report.duplicates,
      xpAwarded: report.xpAwarded,
    });

    return { net, from, to, report, caughtUp: to >= head };
  }

  /** Drains both chains until each is level with its head. */
  async drain(maxPasses = 100): Promise<PassResult[]> {
    const results: PassResult[] = [];
    for (const net of ['SOL', 'RH'] as const) {
      for (let i = 0; i < maxPasses; i++) {
        const result = await this.pass(net);
        results.push(result);
        if (result.caughtUp) break;
      }
    }
    return results;
  }

  /**
   * The `diamond` sweep. Separate from ingest because it is a function of
   * current price, not of any single event, so it has to run on a timer.
   */
  async sweepAchievements(): Promise<Record<Net, string[]>> {
    const out: Record<Net, string[]> = { SOL: [], RH: [] };
    for (const net of ['SOL', 'RH'] as const) {
      try {
        const price = await this.opts.oracle.nativeUsd(nativeUnit(net));
        out[net] = await this.opts.ingestor.sweepDiamondHands(net, price);
      } catch (err) {
        this.opts.logger.warn('diamond sweep skipped', {
          net,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return out;
  }
}
