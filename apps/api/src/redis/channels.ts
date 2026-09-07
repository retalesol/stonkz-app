import type { Net } from '@stonkz/shared';

/**
 * Every WS channel name in one place. The indexer publishes into Redis and the
 * API's WS hub fans out; both sides import these so a typo cannot silently
 * drop a lane.
 */
export const CHANNELS = {
  /** Board-wide: card paints, lane moves, KOTH changes. Tagged with `net`. */
  board: () => 'board',
  /** One token page: fills, curve, cashback fee decay. */
  token: (sym: string) => `token:${sym.toUpperCase()}`,
  /** Global fill feed behind the ticker tape. */
  tape: () => 'tape',
  /** Plan step 121 — xp, rank_up, sp, optionz, achievement, streak, crate_ready. */
  user: (net: Net, wallet: string) => `user:${net}:${wallet}`,
} as const;

export const CHANNEL_PATTERNS = {
  token: 'token:*',
  user: 'user:*',
} as const;

/** Board events carry `net` so a net-filtered board can drop the other chain. */
export type BoardEvent =
  | { type: 'token_created'; net: Net; sym: string; payload: unknown }
  | { type: 'token_update'; net: Net; sym: string; payload: unknown }
  | { type: 'lane_move'; net: Net; sym: string; from: string; to: string }
  | { type: 'koth'; net: Net; sym: string; mc: number }
  | { type: 'graduated'; net: Net; sym: string };

export type TokenEvent =
  | { type: 'fill'; net: Net; sym: string; payload: unknown }
  | { type: 'curve'; net: Net; sym: string; mc: number; price: number; lane: string }
  | { type: 'cashback'; net: Net; sym: string; cbStartMs: number | null; effFeePct: number }
  | { type: 'graduated'; net: Net; sym: string };

export type TapeEvent = { type: 'fill'; net: Net; sym: string; payload: unknown };

/** The seven user-channel event types the rewards ceremonies listen for. */
export type UserEvent =
  | { type: 'xp'; net: Net; wallet: string; amount: number; total: number; reason: string }
  | { type: 'rank_up'; net: Net; wallet: string; rankIndex: number; name: string }
  | { type: 'sp'; net: Net; wallet: string; delta: number; total: number }
  | { type: 'optionz'; net: Net; wallet: string; delta: number; total: number }
  | { type: 'achievement'; net: Net; wallet: string; key: string; xp: number }
  | { type: 'streak'; net: Net; wallet: string; count: number; mult: number }
  | { type: 'crate_ready'; net: Net; wallet: string; tier: string };

export type ChannelEvent = BoardEvent | TokenEvent | TapeEvent | UserEvent;
