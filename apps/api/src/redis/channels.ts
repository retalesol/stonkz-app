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
  /** Plan step 121 — xp, rank_up, sp, stonkz, rwa, achievement, streak, crate_ready. */
  user: (net: Net, wallet: string) => `user:${net}:${wallet}`,
  /** Plan step 151 — `GLOBAL` or a token ticker (no `$` prefix). Tagged with `net`, like every other lane. */
  chat: (net: Net, room: string) => `chat:${net}:${room.toUpperCase()}`,
} as const;

export const CHANNEL_PATTERNS = {
  token: 'token:*',
  user: 'user:*',
  chat: 'chat:*',
} as const;

/** Board events carry `net` so a net-filtered board can drop the other chain. */
export type BoardEvent =
  | { type: 'token_created'; net: Net; sym: string; payload: unknown }
  | { type: 'token_update'; net: Net; sym: string; payload: unknown }
  | { type: 'lane_move'; net: Net; sym: string; from: string; to: string }
  | { type: 'koth'; net: Net; sym: string; mc: number; mcBase?: number }
  | { type: 'graduated'; net: Net; sym: string };

/**
 * Market-cap convention on every frame (0027): `mc` / `price` are USD at the
 * launch snapshot price (what the indexer can compute without an oracle);
 * `mcBase` / `priceBase` are the base-denominated truth. A client shows
 * `mcBase × its own live base mark` and only falls back to `mc` when a frame
 * predates `mcBase`.
 */
export type TokenEvent =
  | { type: 'fill'; net: Net; sym: string; payload: unknown; mint?: string }
  | {
      type: 'curve';
      net: Net;
      sym: string;
      mc: number;
      price: number;
      /** Cap after the fill in whole base units, and base per token. */
      mcBase?: number;
      priceBase?: number;
      lane: string;
      mint?: string;
      /** From `/trade/confirm`'s fast path, ahead of the indexer's confirmation depth. */
      provisional?: boolean;
    }
  | { type: 'cashback'; net: Net; sym: string; cbStartMs: number | null; effFeePct: number }
  | { type: 'graduated'; net: Net; sym: string };

export type TapeEvent = { type: 'fill'; net: Net; sym: string; payload: unknown; mint?: string };

/** The seven user-channel event types the rewards ceremonies listen for. */
export type UserEvent =
  | { type: 'xp'; net: Net; wallet: string; amount: number; total: number; reason: string }
  | { type: 'rank_up'; net: Net; wallet: string; rankIndex: number; name: string }
  | { type: 'sp'; net: Net; wallet: string; delta: number; total: number }
  | { type: 'stonkz'; net: Net; wallet: string; delta: number; total: number }
  | { type: 'rwa'; net: Net; wallet: string; asset: string; units: number; total: number }
  | { type: 'achievement'; net: Net; wallet: string; key: string; xp: number }
  | { type: 'streak'; net: Net; wallet: string; count: number; mult: number }
  | { type: 'crate_ready'; net: Net; wallet: string; tier: string }
  /** An SP level's crate grants landed in inventory (`SpLevelService.sync`). */
  | {
      type: 'level_up';
      net: Net;
      wallet: string;
      level: number;
      grants: Record<string, number>;
      totalSp: number;
    };

/** Plan step 151's chat drawer — one event per persisted (non-flagged) message. */
export type ChatEvent = {
  type: 'message';
  net: Net;
  room: string;
  id: number;
  wallet: string;
  text: string;
  createdAtMs: number;
  /** Present when the sender has a profile row. */
  username?: string | null;
  avatarUrl?: string | null;
};

export type ChannelEvent = BoardEvent | TokenEvent | TapeEvent | UserEvent | ChatEvent;
