#!/usr/bin/env -S pnpm --filter @stonkz/api exec tsx
/**
 * Referral native payouts, operator batch — see
 * `apps/api/src/cli/referral-payouts.ts`. This file only launches it from the
 * repo root; the implementation lives in the API package so drizzle and viem
 * resolve.
 *
 *   DATABASE_URL=… pnpm --filter @stonkz/api exec tsx ../../scripts/referral-payouts.ts list [--net BASE]
 *   DATABASE_URL=… pnpm --filter @stonkz/api exec tsx ../../scripts/referral-payouts.ts paid --tx 0x… --ids 12,13
 *   DATABASE_URL=… pnpm --filter @stonkz/api exec tsx ../../scripts/referral-payouts.ts void --id 12 --note "…"
 */
const { main } = await import('../apps/api/src/cli/referral-payouts.js');
await main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
