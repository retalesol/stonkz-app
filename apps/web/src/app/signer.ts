import type { Net } from '@stonkz/shared';
import {
  WalletError,
  requireWallet,
  type BroadcastResult,
  type SignPayload,
} from '../wallet/index.js';
import { signSellPermit, type SellPermit } from '../wallet/permit.js';

/**
 * Signs a prepared payload and waits for a real confirmation.
 *
 * **What this used to be.** Until Phase B this module returned a fabricated
 * signature after a `setTimeout`, because nothing in `apps/web` could connect
 * a wallet and there was nowhere real to broadcast to. Its own header said
 * so. That is gone: `signAndConfirm()` now hands the exact bytes
 * `apps/api` prepared to the connected wallet, and does not resolve until the
 * transaction is confirmed on chain — `getSignatureStatuses` polling with a
 * `lastValidBlockHeight` expiry check on Solana (`wallet/solana.ts`),
 * `waitForTransactionReceipt` with a reverted-status check on Robinhood Chain
 * (`wallet/evm.ts`).
 *
 * **What it deliberately does not do.** It does not build, alter, re-sign or
 * re-order anything. The API composes the transaction (including every
 * `min_out` floor and the 20/60/10/10 fee split the contracts assert on), and
 * this layer's only job is custody of the signature. A signer that could
 * rewrite a payload would be a place to smuggle a fee into.
 *
 * The one honest exception is `wallet/practice.ts`, whose `signAndSend()`
 * returns `simulated: true` and broadcasts nothing. It is off unless
 * `VITE_PRACTICE_WALLET=1` and the UI pins a badge for the whole session.
 */

export interface UiStep {
  description: string;
  /**
   * Optional async work to run immediately before this step is signed —
   * e.g. its own independent `POST .../prepare` call, for a step whose
   * payload cannot be known until the previous step has already confirmed.
   * `modals/steps.ts`'s `advance()` awaits this, then signs.
   */
  run?: () => Promise<void>;
  /**
   * The transaction this step broadcasts. A thunk, not a value, because a
   * step's payload is frequently only known after its own `run()` has
   * fetched it (a fresh `/trade/prepare`, the next vault's claim calldata).
   */
  payload?: () => SignPayload | null;
  /**
   * An off-chain-only step: signs and returns, with nothing to broadcast.
   * The `StonkzRouter` sell permit is the only one
   * (`docs/rh-trade-atomicity-gap.md` §5).
   */
  signOffChain?: () => Promise<string>;
}

/**
 * Backing out of the signing flow — the steps modal's CANCEL, the backdrop,
 * or Escape.
 *
 * A `WalletError`, so a wallet rejection and an in-app cancel are the same
 * `kind` (`'rejected'`) to every `catch` that only wants to know "did the
 * user decline". Call sites that want the distinction still have
 * `instanceof SignerCancelledError`.
 */
export class SignerCancelledError extends WalletError {
  constructor() {
    super('rejected', 'signing cancelled');
    this.name = 'SignerCancelledError';
  }
}

/**
 * One wallet "sign, then wait for confirmation" round.
 *
 * Solana's atomic path calls this exactly once, inline; Robinhood's
 * non-atomic plan (`modals/steps.ts`) calls it once per `EvmStep`, gated on
 * an explicit click so "sequential confirmation" is a real user action per
 * step, not an automatic loop that only *looks* like separate signatures.
 */
export async function signAndConfirm(net: Net, payload: SignPayload): Promise<BroadcastResult> {
  const wallet = requireWallet(net);
  if (payload.net !== net) {
    throw new WalletError('unknown', `A ${payload.net} payload cannot be signed on ${net}.`);
  }
  return wallet.signAndSend(payload);
}

/** The EIP-712 permit for a first-time Robinhood sell. Off-chain; nothing broadcasts. */
export async function signPermit(net: Net, typedData: unknown): Promise<SellPermit> {
  const wallet = requireWallet(net);
  return signSellPermit(wallet, typedData);
}

/** True when the active signer settles nothing — drives the "SIMULATED" suffix on success copy. */
export function resultWasSimulated(result: BroadcastResult): boolean {
  return result.simulated === true;
}

export type { BroadcastResult, SignPayload } from '../wallet/index.js';
export type { SellPermit } from '../wallet/permit.js';
