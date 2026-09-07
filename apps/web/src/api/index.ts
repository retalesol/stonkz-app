import { liveApi } from './live.js';
import { simApi } from './sim.js';
import type { StonkzApi } from './types.js';

/**
 * The one place the app decides where its data comes from.
 *
 * `VITE_API_MODE=sim` (the default, and the only working value in Phase 0)
 * keeps every number local. Flipping it to `live` swaps the implementation and
 * nothing else: no view imports `sim.ts` or `live.ts` directly.
 *
 * @see plan step 30
 */

export type ApiMode = 'sim' | 'live';

export const API_MODE: ApiMode = (import.meta.env['VITE_API_MODE'] as ApiMode) === 'live' ? 'live' : 'sim';

export const api: StonkzApi = API_MODE === 'live' ? liveApi : simApi;

/**
 * The footer's disclosure line — not `api.mode === 'sim'`, because that flag
 * does not track which *features* are real.
 *
 * Phase 2.C lands `/quote`, `/trade/*`, `/launch/*` and `/fees*` for real in
 * `live.ts`: trading, launching and claiming creator fees are genuine API
 * calls now (signed with a local practice keypair, not a real wallet
 * extension or a broadcast to a live chain — `app/signer.ts`'s header has
 * the honesty trade). Staking, crates and XP have no live endpoint yet and
 * still run on `simApi`'s in-memory model regardless of `api.mode`, so this
 * line names exactly those three, not a blanket "simulated data" claim that
 * would now be false for the rest of the app. `plan step 68`, `plan step 99`
 */
export const DISCLOSURE = 'STAKING, CRATES & XP ARE SIMULATED \u00b7 NOT FINANCIAL ADVICE';

export type {
  ClaimResult,
  CrateResult,
  LaunchDraft,
  QuoteInput,
  StakeClaim,
  StakeInput,
  StonkzApi,
} from './types.js';
