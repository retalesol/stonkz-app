import { buildDeps } from '@stonkz/api/app/deps';
import { readEnv } from '@stonkz/api/env';
import { BACKFILL_USAGE, BackfillArgsError, parseBackfillArgs } from './backfill-args.js';
import { buildChainSources } from '../chain/sources.js';
import { assertChainModeConfigured, readIndexerConfig } from '../config.js';
import { ReplayCursors } from '../cursors.js';
import { DeadLetters } from '../deadletter.js';
import { Ingestor } from '../ingest.js';
import { ReorgRollback } from '../rollback.js';
import { confirmedHeadOf, pollSource } from '../source.js';

/**
 * `pnpm --filter @stonkz/indexer backfill -- --net SOL --from <slot> --to <slot>`
 *
 * Re-reads a closed range of one chain and ingests it, without touching the
 * live cursor.
 *
 * ## Why this is safe to run against production
 *
 * Ingest is idempotent on `(net, tx_sig, log_index, kind)`, so re-reading a
 * range that is already indexed produces `duplicates`, not double rows and not
 * double XP — `xp_events`' own `(wallet, tx_sig, reason)` index catches
 * anything that gets past the first check. That is what makes replaying an
 * overlapping range a no-op rather than a corruption.
 *
 * Two things it deliberately does **not** do:
 *
 * - **It never moves the live cursor.** A backfill is a repair of history, not
 *   progress along it. Moving the cursor backwards would make the running
 *   indexer re-ingest everything since (harmless but slow), and moving it
 *   forwards would skip whatever the running indexer had not reached yet
 *   (not harmless at all). Use `--rewind` to do that explicitly.
 * - **It refuses to read past the confirmation depth by default.** Backfilling
 *   into the reorg zone would materialise rows the live indexer is
 *   deliberately waiting on, and the live indexer would then never see them —
 *   they would already be in `chain_events`, so its own pass would count them
 *   as duplicates and its reorg check would never have recorded a hash for
 *   them. `--allow-unconfirmed` overrides it for a forensic read.
 *
 * ## The recovery this exists for
 *
 * A dead-lettered batch (`scope: 'batch'` in `indexer_dead_letters`, visible
 * on `GET /dead-letters`) records the exact range ingest gave up on. Fix the
 * cause, run this over `from_position`/`to_position`, and the range is
 * recovered without rewinding the whole chain. `--resolve` then marks those
 * dead letters closed so they stop showing as an open incident.
 *
 * ## Flags
 *
 * ```
 *   --net SOL|RH             required
 *   --from <position>        required; exclusive lower bound (a slot or block)
 *   --to <position>          required; inclusive upper bound
 *   --dry-run                decode and report, write nothing
 *   --allow-unconfirmed      read past the confirmation depth (see above)
 *   --rollback-first         delete this range's rows before re-ingesting;
 *                            use when the range was indexed *wrongly*, not
 *                            merely missed
 *   --rewind                 after ingesting, set the live cursor to --from,
 *                            so the running indexer re-reads from there
 *   --resolve                mark dead letters in this range resolved
 *   --window <n>             positions per pass (default: the batch size)
 * ```
 */
async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(BACKFILL_USAGE);
    return;
  }

  let args;
  try {
    args = parseBackfillArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof BackfillArgsError)) throw err;
    console.error(`backfill: ${err.message}\n\n${BACKFILL_USAGE}`);
    process.exit(2);
  }

  const env = readEnv();
  const config = readIndexerConfig(env);
  // A backfill only means anything against a chain, so the chain-mode
  // prerequisites are enforced even when the worker is running on fixtures.
  assertChainModeConfigured(config);

  const { deps, close } = await buildDeps(env);
  const logger = deps.logger.child({ svc: 'backfill', net: args.net });

  try {
    const { sources, registry } = buildChainSources({ config, env, db: deps.db, oracle: deps.oracle, logger });
    const source = sources[args.net];
    const cursors = new ReplayCursors(deps.db, deps.now);
    const deadLetters = new DeadLetters({ db: deps.db, logger, now: deps.now });
    const ingestor = new Ingestor({
      db: deps.db,
      ledger: deps.ledger,
      awards: deps.awards,
      publisher: deps.publisher,
      logger,
      now: deps.now,
    });

    const confirmed = await confirmedHeadOf(source);
    let to = args.to;
    if (to > confirmed) {
      if (!args.allowUnconfirmed) {
        console.error(
          `backfill: --to ${to} is past ${args.net}'s confirmed head (${confirmed}); clamping.\n` +
            '  Pass --allow-unconfirmed to read into the reorg zone anyway.',
        );
        to = confirmed;
      } else {
        console.error(
          `backfill: reading past the confirmed head (${confirmed}) because --allow-unconfirmed was set.\n` +
            '  Rows written here were never confirmation-gated and may describe a chain that gets reorged out.',
        );
      }
    }
    if (to <= args.from) {
      console.error(`backfill: nothing to do — the range (${args.from}, ${to}] is empty after clamping.`);
      return;
    }

    const cursorBefore = await cursors.read(args.net);
    console.error(
      `backfill: ${args.net} (${args.from}, ${to}]  live cursor=${cursorBefore.position}  ` +
        `confirmed head=${confirmed}${args.dryRun ? '  DRY RUN' : ''}`,
    );

    if (args.rollbackFirst) {
      if (args.dryRun) {
        console.error('backfill: --rollback-first skipped under --dry-run');
      } else {
        const rollback = new ReorgRollback({ db: deps.db, logger, now: deps.now });
        const report = await rollback.rollback(args.net, args.from + 1);
        registry.forget(args.net);
        console.error(
          `backfill: rolled back ${report.events} events, ${report.trades} trades, ` +
            `${report.xpEventsDeleted} xp events (${report.xpReversed} XP reversed)`,
        );
      }
    }

    // Solana's signature paging resumes from a signature, and a backfill is
    // reading a historical window rather than following the tip, so it starts
    // with no bookmark and walks the range from `--from`.
    source.restoreBookmark?.(null);

    const window = Math.max(1, args.window ?? config.batchSize);
    const totals = { events: 0, accepted: 0, duplicates: 0, rejected: 0, xp: 0, passes: 0 };
    let cursor = args.from;

    while (cursor < to) {
      const target = Math.min(to, cursor + window);
      const polled = await pollSource(source, cursor, target);
      const covered = Math.max(cursor, Math.min(target, polled.coveredTo));
      totals.events += polled.events.length;
      totals.passes++;

      if (args.dryRun) {
        const byKind = new Map<string, number>();
        for (const event of polled.events) byKind.set(event.kind, (byKind.get(event.kind) ?? 0) + 1);
        console.error(
          `  (${cursor}, ${covered}]  ${polled.events.length} events` +
            (byKind.size > 0
              ? `  ${[...byKind].map(([k, n]) => `${k}=${n}`).join(' ')}`
              : ''),
        );
      } else {
        const report = await ingestor.apply(polled.events);
        totals.accepted += report.accepted;
        totals.duplicates += report.duplicates;
        totals.rejected += report.rejected.length;
        totals.xp += report.xpAwarded;
        for (const { event, reason } of report.rejected) await deadLetters.recordEvent(event, reason);
        console.error(
          `  (${cursor}, ${covered}]  accepted=${report.accepted} duplicates=${report.duplicates} ` +
            `rejected=${report.rejected.length} xp=${report.xpAwarded}`,
        );
      }

      // A source that covered less than it was asked for has not seen the
      // rest; advancing to `target` would silently skip it.
      if (covered <= cursor) {
        console.error(`backfill: source made no progress past ${cursor}; stopping rather than looping.`);
        break;
      }
      cursor = covered;
    }

    if (args.resolve && !args.dryRun) {
      const resolved = await deadLetters.resolveRange(args.net, args.from, to);
      console.error(`backfill: resolved ${resolved} dead letter(s) in the range`);
    }

    if (args.rewind && !args.dryRun) {
      await cursors.rewind(args.net, args.from);
      console.error(
        `backfill: live cursor rewound to ${args.from}; the running indexer will re-read from there`,
      );
    } else if (!args.dryRun) {
      const after = await cursors.read(args.net);
      console.error(`backfill: live cursor untouched at ${after.position}`);
    }

    console.log(
      JSON.stringify(
        {
          net: args.net,
          from: args.from,
          to,
          dryRun: args.dryRun,
          ...totals,
        },
        null,
        2,
      ),
    );
  } finally {
    await close();
  }
}

await main();
