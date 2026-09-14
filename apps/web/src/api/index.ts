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
 * Live mode against staging points at RH testnet + Solana devnet programs.
 * Sim mode keeps the sandbox disclosure.
 */
export const DISCLOSURE =
  API_MODE === 'live'
    ? 'DEVNET / RH TESTNET / BASE SEPOLIA \u00b7 NOT MAINNET \u00b7 NOT FINANCIAL ADVICE'
    : 'SIMULATED DATA \u00b7 NOT FINANCIAL ADVICE';

export type {
  ClaimResult,
  CrateResult,
  LaunchDraft,
  QuoteInput,
  StakeClaim,
  StakeInput,
  StonkzApi,
} from './types.js';
