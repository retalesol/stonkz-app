import type { Net } from '@stonkz/shared';

/**
 * PLACEHOLDER. Phase 1.C owns this service.
 *
 * What lands here: a stateful worker with two independent replay cursors — a
 * Solana slot cursor fed by Helius and an EVM block cursor fed by Robinhood
 * Chain log subscriptions — writing `tokens`, `trades`, `candles`,
 * `holders_snapshot`, `koth`, `tape` and `treasuries` to Neon, and publishing
 * `board` / `token:{sym}` / `user:{addr}` over Redis pub/sub.
 *
 * Event schema to implement: TokenCreated, Trade, Graduated, FeeAccrued
 * (carrying the 20/70/10 split), Stake*, CashbackWindow, TreasuryCredit.
 *
 * Alert if either chain's lag exceeds 30 seconds.
 */
export interface ReplayCursor {
  net: Net;
  /** Solana slot, or EVM block number. */
  position: number;
  /** Epoch ms of the last committed advance. */
  updatedAt: number;
}

export const INDEXER_PLACEHOLDER = {
  name: '@stonkz/indexer',
  phase: '1.C',
  cursors: ['SOL', 'RH'] satisfies Net[],
  maxLagSeconds: 30,
} as const;
