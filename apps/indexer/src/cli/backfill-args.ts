import type { Net } from '@stonkz/shared';

/**
 * The backfill CLI's argument contract, split out from `backfill.ts` so it can
 * be tested without booting the process.
 *
 * `backfill.ts` runs `main()` at module scope — it is a script, not a library —
 * so importing it in a test would connect to a database and start reading a
 * chain. Parsing lives here and throws instead of exiting, and the script turns
 * the throw into a usage message and an exit code.
 */
export interface BackfillArgs {
  net: Net;
  /** Exclusive lower bound; the same `(from, to]` window `pollRange` takes. */
  from: number;
  to: number;
  dryRun: boolean;
  allowUnconfirmed: boolean;
  rollbackFirst: boolean;
  rewind: boolean;
  resolve: boolean;
  /** Positions per pass; `null` means "use INDEXER_BATCH_SIZE". */
  window: number | null;
}

export const BACKFILL_USAGE = `
usage: pnpm --filter @stonkz/indexer backfill -- --net <SOL|RH> --from <position> --to <position> [flags]

  --net SOL|RH            which chain to replay
  --from <position>       exclusive lower bound (slot on SOL, block on RH)
  --to <position>         inclusive upper bound
  --dry-run               decode and report without writing
  --allow-unconfirmed     read past the confirmation depth (forensics only)
  --rollback-first        delete the range's materialised rows before re-ingesting
  --rewind                point the live cursor at --from when finished
  --resolve               close dead letters in this range afterwards
  --window <n>            positions per pass (default: INDEXER_BATCH_SIZE)

Idempotent: replaying an already-indexed range reports duplicates and writes
nothing. See docs/indexer-runbooks.md for the recovery procedures.
`.trim();

export class BackfillArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackfillArgsError';
  }
}

export function parseBackfillArgs(argv: readonly string[]): BackfillArgs {
  const flag = (name: string): boolean => argv.includes(`--${name}`);
  const value = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const int = (name: string): number | null => {
    const raw = value(name);
    if (raw === undefined || raw.startsWith('--')) return null;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0 || String(n) !== raw.trim()) {
      throw new BackfillArgsError(`--${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
    }
    return n;
  };

  const net = value('net')?.toUpperCase();
  if (net !== 'SOL' && net !== 'RH') throw new BackfillArgsError('--net must be SOL or RH');

  const from = int('from');
  const to = int('to');
  if (from === null) throw new BackfillArgsError('--from is required');
  if (to === null) throw new BackfillArgsError('--to is required');
  if (to <= from) {
    throw new BackfillArgsError(`--to (${to}) must be greater than --from (${from}); the range is (from, to]`);
  }

  const window = int('window');
  if (window !== null && window < 1) throw new BackfillArgsError('--window must be at least 1');

  return {
    net,
    from,
    to,
    dryRun: flag('dry-run'),
    allowUnconfirmed: flag('allow-unconfirmed'),
    rollbackFirst: flag('rollback-first'),
    rewind: flag('rewind'),
    resolve: flag('resolve'),
    window,
  };
}
