import type { CrateTier, Fill, Net, Quote, Wallet } from '@stonkz/shared';
import type { SimCoin } from '../state/coins.js';
import type { ClaimResult, CrateResult, LaunchDraft, QuoteInput, StakeClaim, StakeInput, StonkzApi } from './types.js';

/**
 * The live adapter.
 *
 * Deliberately unimplemented: this file exists so the seam is real in Phase 0
 * rather than promised, and so each Phase has an obvious landing site. Turning
 * it on before a method exists must fail loudly at the call, not silently fall
 * back to the simulation — a fallback here is how fake balances reach
 * production.
 *
 * Landing sites, in the order the plan fills them:
 *
 *   ready / startStream   Phase 1.C  `GET /tokens`, then the `board` WS channel
 *   connect / disconnect  Phase 1.B  SIWS (Wallet Standard) / SIWE (wagmi)
 *   quote / trade         Phase 2.R  router quote, then sign + send + confirm
 *   launch                Phase 2.L  `create_coin` with the optional dev buy
 *   claimCreatorFees      Phase 2.F  `claim_creator_fees` on the fee vault
 *   stake / unstake       Phase 4.B  escrow with the lock encoded in the PDA
 *   openCrate             Phase 3.C  server-rolled drop, written to the ledger
 *
 * @see plan step 30
 */

const BASE = import.meta.env['VITE_API_URL'] ?? '';

function todo(method: string, phase: string): never {
  throw new Error(`live api: ${method}() lands in Phase ${phase}. VITE_API_MODE=live is not usable yet.`);
}

export const liveApi: StonkzApi = {
  mode: 'live',

  async ready(): Promise<void> {
    todo('ready', '1.C');
  },
  startStream(): void {
    todo('startStream', '1.C');
  },
  stopStream(): void {
    /* nothing is running yet */
  },
  async quote(_input: QuoteInput): Promise<Quote> {
    todo('quote', '2.R');
  },
  async trade(_quote: Quote): Promise<Fill> {
    todo('trade', '2.R');
  },
  async connect(_net: Net): Promise<Wallet> {
    todo('connect', '1.B');
  },
  disconnect(): void {
    todo('disconnect', '1.B');
  },
  async launch(_draft: LaunchDraft): Promise<SimCoin> {
    todo('launch', '2.L');
  },
  async claimCreatorFees(_sym?: string): Promise<ClaimResult> {
    todo('claimCreatorFees', '2.F');
  },
  async stake(_input: StakeInput): Promise<void> {
    todo('stake', '4.B');
  },
  async unstake(_sym: string): Promise<number> {
    todo('unstake', '4.B');
  },
  async claimStake(_sym: string): Promise<StakeClaim> {
    todo('claimStake', '4.B');
  },
  async openCrate(_tier: CrateTier): Promise<CrateResult> {
    todo('openCrate', '3.C');
  },
};

/** Where the live adapter will point once it exists. */
export const API_BASE = BASE;
