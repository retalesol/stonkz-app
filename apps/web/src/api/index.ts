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

/** True while the app is inventing its own data. Used to label the footer. */
export const SIMULATED = api.mode === 'sim';

export type {
  ClaimResult,
  CrateResult,
  LaunchDraft,
  QuoteInput,
  StakeClaim,
  StakeInput,
  StonkzApi,
} from './types.js';
