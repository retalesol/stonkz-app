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
 * True while trading, launch, staking and crates are simulated. This is
 * *not* `api.mode === 'sim'` — Phase 1.D (`live.ts`) wires the read path
 * (board/candles/trades/holders/tape/koth) to the real API, but quote/trade/
 * launch/stake/crate still run on `simApi`'s in-memory model regardless of
 * mode, so the footer's disclosure must stay lit either way. Flip this once
 * Phase 2.C lands `/quote` and `/trade/*` for real. `plan step 68`
 */
export const SIMULATED = true;

export type {
  ClaimResult,
  CrateResult,
  LaunchDraft,
  QuoteInput,
  StakeClaim,
  StakeInput,
  StonkzApi,
} from './types.js';
