#!/usr/bin/env -S pnpm --filter @stonkz/indexer exec tsx
/**
 * Fee reconciliation, read-only — see `apps/indexer/src/cli/reconcile-fees.ts`
 * for what is checked. This file only launches it from the repo root; the
 * implementation lives in the indexer package so its dependencies (viem, the
 * Anchor event coder, the launchpad PDAs) resolve.
 *
 *   pnpm --filter @stonkz/indexer exec tsx ../../scripts/reconcile-fees.ts \
 *     --net BASE --mint 0x847eb6311333f8F7F2cd0E9A89379214302aB2c9 [--api https://api.example]
 *   pnpm --filter @stonkz/indexer exec tsx ../../scripts/reconcile-fees.ts --net SOL --mint <mint>
 */
const { main } = await import('../apps/indexer/src/cli/reconcile-fees.js');
await main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
