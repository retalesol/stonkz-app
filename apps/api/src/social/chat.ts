import { desc, eq, and } from 'drizzle-orm';
import type { Net } from '@stonkz/shared';
import type { Db } from '../db/client.js';
import { chatMessages } from '../db/schema.js';
import { rateLimit, type RateLimitRule } from '../redis/ratelimit.js';
import type { RedisLike } from '../redis/types.js';

/**
 * Plan step 151-152: "WS chat:global, WS chat:{sym}; persist; presence;
 * moderation" and "140-char limit". `ChatService` owns persistence and the
 * moderation/rate-limit gate; `ws/hub.ts` calls it from an authenticated
 * socket, `routes/chat.ts` calls it for the REST history read.
 *
 * The room name convention mirrors the frontend's drawer: the literal room
 * `GLOBAL`, or a token's ticker (without the `$` the UI prefixes onto it).
 */

export const CHAT_MAX_LEN = 140;
export const CHAT_RATE_LIMIT: RateLimitRule = { bucket: 'chat', limit: 20, windowSeconds: 30 };

/** Same substring/normalise approach as `router/moderation.ts`, kept separate since a launch and a chat line are different surfaces with different consequences for a false positive. */
const BLOCKLIST = [
  'fuck',
  'shit',
  'bitch',
  'cunt',
  'nigger',
  'nigga',
  'faggot',
  'retard',
  'rape',
  'nazi',
  'hitler',
  'kike',
  'chink',
  'spic',
  'terrorist',
  'kys',
] as const;

function normalise(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isFlagged(text: string): boolean {
  const haystack = normalise(text);
  return BLOCKLIST.some((word) => haystack.includes(word));
}

export function normaliseRoom(room: string): string {
  const trimmed = room.trim().toUpperCase();
  return trimmed === 'GLOBAL' ? 'GLOBAL' : trimmed.replace(/^\$/, '');
}

export interface ChatSendResult {
  ok: boolean;
  error?: 'rate_limited' | 'too_long' | 'empty';
  retryAfterSeconds?: number;
  message?: {
    id: number;
    net: Net;
    room: string;
    wallet: string;
    text: string;
    flagged: boolean;
    createdAtMs: number;
  };
}

export interface ChatServiceOptions {
  db: Db;
  redis: RedisLike;
  now?: () => number;
}

export class ChatService {
  private readonly now: () => number;

  constructor(private readonly opts: ChatServiceOptions) {
    this.now = opts.now ?? Date.now;
  }

  async send(net: Net, room: string, wallet: string, rawText: string): Promise<ChatSendResult> {
    const text = rawText.trim();
    if (!text) return { ok: false, error: 'empty' };
    if (text.length > CHAT_MAX_LEN) return { ok: false, error: 'too_long' };

    const verdict = await rateLimit(
      this.opts.redis,
      CHAT_RATE_LIMIT,
      `${net}:${wallet}`,
      Math.floor(this.now() / 1000),
    );
    if (!verdict.ok)
      return { ok: false, error: 'rate_limited', retryAfterSeconds: verdict.resetSeconds };

    const flagged = isFlagged(text);
    const normalisedRoom = normaliseRoom(room);

    const [inserted] = await this.opts.db
      .insert(chatMessages)
      .values({ net, room: normalisedRoom, wallet, text, flagged, createdAt: new Date(this.now()) })
      .returning();
    if (!inserted) throw new Error('chat_messages insert returned no row');

    return {
      ok: true,
      message: {
        id: inserted.id,
        net,
        room: normalisedRoom,
        wallet: inserted.wallet,
        text: inserted.text,
        flagged: inserted.flagged,
        createdAtMs: inserted.createdAt.getTime(),
      },
    };
  }

  /** History for the drawer's backscroll. Flagged messages never replay to a fresh subscriber. */
  async history(
    net: Net,
    room: string,
    limit = 50,
  ): Promise<{ id: number; wallet: string; text: string; createdAtMs: number }[]> {
    const normalisedRoom = normaliseRoom(room);
    const rows = await this.opts.db
      .select()
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.net, net),
          eq(chatMessages.room, normalisedRoom),
          eq(chatMessages.flagged, false),
        ),
      )
      .orderBy(desc(chatMessages.id))
      .limit(limit);
    return rows.reverse().map((r) => ({
      id: r.id,
      wallet: r.wallet,
      text: r.text,
      createdAtMs: r.createdAt.getTime(),
    }));
  }
}
