import type { Net } from '@stonkz/shared';

/**
 * The two launch outcomes that are neither a clean success nor a clean
 * failure, and must never be answered with "press LAUNCH again":
 *
 * - `LaunchPendingError` — the create transaction was broadcast, but either
 *   its confirmation or `/launch/confirm` never came back. It may well have
 *   landed; relaunching would mint a second coin.
 * - `LaunchedDevBuyError` — the coin exists on chain; only the separate
 *   Robinhood/Base dev buy that follows it failed or was cancelled. Legacy
 *   only: a WETH-curve EVM launch carries its dev buy in the same
 *   transaction (`StonkzRouter.createAndBuyWithEth`); a non-WETH base, or a
 *   router that predates atomic launches, still takes this second step.
 *
 * Kept free of DOM and transport imports so `modals/launch.ts` and
 * `api/live.ts` can share them without a cycle.
 */

export class LaunchPendingError extends Error {
  constructor(
    readonly net: Net,
    readonly signature: string,
    detail: string,
  ) {
    super(detail);
    this.name = 'LaunchPendingError';
  }
}

export class LaunchedDevBuyError extends Error {
  constructor(
    readonly sym: string,
    readonly mint: string | undefined,
    detail: string,
    options?: { cause?: unknown },
  ) {
    super(detail, options);
    this.name = 'LaunchedDevBuyError';
  }
}

/** Progress the launch dialog shows on its button while a launch is in flight. */
export type LaunchPhase = 'prepare' | 'sign' | 'confirm' | 'devbuy';

export interface LaunchHooks {
  onPhase?(phase: LaunchPhase): void;
}
