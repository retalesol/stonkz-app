import { desc, eq, and, gt, inArray, sql } from 'drizzle-orm';
import { ALL_NETS, type Net } from '@stonkz/shared';
import type { Db } from '../db/client.js';
import { chatMessages, holdersSnapshot, trades } from '../db/schema.js';
import { rateLimit, type RateLimitRule } from '../redis/ratelimit.js';
import type { RedisLike } from '../redis/types.js';
import { asErc20BalanceSource, type ChainRpcs } from '../chain/types.js';
import { resolveTokenRow } from '../routes/token-resolve.js';
import { serialiseToken } from '../routes/serialise.js';

/**
 * Plan step 151-152: "WS chat:global, WS chat:{sym}; persist; presence;
 * moderation" and "140-char limit". `ChatService` owns persistence, the
 * moderation/rate-limit gate and — since the access audit — the two
 * entry gates:
 *
 *  - GLOBAL and the public `$SYM` room: posting needs a signed-in wallet
 *    with ≥ {@link CHAT_VOLUME_GATE_USD} of lifetime curve volume across
 *    every net. Reading is open.
 *  - `$SYM:PRIVATE`: reading *and* posting need the wallet to hold
 *    ≥ {@link CHAT_HOLDER_GATE_USD} of the token at the API's own price.
 *
 * Both `ws/hub.ts` (subscribe + `send_chat`) and `routes/chat.ts` (history +
 * `POST`) go through {@link ChatService.access} / {@link ChatService.send},
 * so there is exactly one place the rules live.
 *
 * Room keys in `chat_messages.room` and on the WS channel: the literal
 * `GLOBAL`, a token's ticker (no `$`), or `TICKER:PRIVATE`.
 */

export const CHAT_MAX_LEN = 140;
/** One bucket per wallet, shared by every room — a limited wallet cannot reset it by switching rooms. */
export const CHAT_RATE_LIMIT: RateLimitRule = { bucket: 'chat', limit: 20, windowSeconds: 30 };

/** Lifetime USD curve volume a wallet needs before it may post in GLOBAL / public token rooms. */
export const CHAT_VOLUME_GATE_USD = 100;
/** USD value of a token a wallet must hold to read or post in that token's private room. */
export const CHAT_HOLDER_GATE_USD = 5;
/** How long a computed lifetime volume is trusted before the trades table is summed again. */
export const CHAT_VOLUME_CACHE_SECONDS = 30;
/** How long a holder verdict is trusted; short, so a sell drops access quickly. */
export const CHAT_HOLDING_CACHE_SECONDS = 20;
/**
 * An indexer holder row younger than this is treated as authoritative; when
 * the wallet traded more recently than the row (or the row is missing / below
 * the gate) the chain is asked directly so a fresh buyer is admitted at once.
 */
export const CHAT_HOLDER_FRESH_TRADE_MS = 60_000;

export const PRIVATE_ROOM_SUFFIX = ':PRIVATE';

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

/** `extra` is the admin-managed term list (`admin/settings.ts` → `moderation.words`), normalised the same way. */
export function isFlagged(text: string, extra: readonly string[] = []): boolean {
  const haystack = normalise(text);
  return (
    BLOCKLIST.some((word) => haystack.includes(word)) ||
    extra.some((word) => {
      const w = normalise(word);
      return w.length > 0 && haystack.includes(w);
    })
  );
}

export function normaliseRoom(room: string): string {
  const trimmed = room.trim().toUpperCase();
  return trimmed === 'GLOBAL' ? 'GLOBAL' : trimmed.replace(/^\$/, '');
}

export type ChatRoom =
  | { kind: 'global'; key: 'GLOBAL' }
  | { kind: 'token'; key: string; sym: string }
  | { kind: 'private'; key: string; sym: string };

/** `GLOBAL` | `$WOJAK` / `WOJAK` | `$WOJAK:PRIVATE` / `WOJAK:PRIVATE` → a typed room. */
export function parseRoom(room: string): ChatRoom {
  const key = normaliseRoom(room);
  if (key === 'GLOBAL') return { kind: 'global', key };
  if (key.endsWith(PRIVATE_ROOM_SUFFIX)) {
    const sym = key.slice(0, -PRIVATE_ROOM_SUFFIX.length);
    return { kind: 'private', key, sym };
  }
  return { kind: 'token', key, sym: key };
}

export function privateRoomKey(sym: string): string {
  return normaliseRoom(sym) + PRIVATE_ROOM_SUFFIX;
}

/** Splits a `chat:{net}:{room}` channel; `null` when it is not a chat lane. */
export function parseChatChannel(channel: string): { net: string; room: ChatRoom } | null {
  if (!channel.startsWith('chat:')) return null;
  const rest = channel.slice('chat:'.length);
  const sep = rest.indexOf(':');
  if (sep <= 0 || sep === rest.length - 1) return null;
  return { net: rest.slice(0, sep), room: parseRoom(rest.slice(sep + 1)) };
}

export type ChatDenial =
  'unauthorized' | 'volume_required' | 'holder_required' | 'unknown_token' | 'net_mismatch';

export interface ChatAccess {
  room: string;
  kind: ChatRoom['kind'];
  sym: string | null;
  signedIn: boolean;
  canRead: boolean;
  canPost: boolean;
  /** Why `canPost` (or, for a private room, `canRead`) is false. */
  reason: ChatDenial | null;
  /** Lifetime USD curve volume across every net; `null` when nobody is signed in. */
  volumeUsd: number | null;
  volumeRequiredUsd: number;
  /** Only on a private room: the wallet's USD position in `sym`. */
  holdingUsd: number | null;
  holdingRequiredUsd: number;
}

export type ChatSendError =
  'rate_limited' | 'too_long' | 'empty' | 'chat_disabled' | 'banned' | ChatDenial;

export interface ChatSendResult {
  ok: boolean;
  error?: ChatSendError;
  retryAfterSeconds?: number;
  /** The gate snapshot that produced a denial, so a client can render progress. */
  access?: ChatAccess;
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

export interface ChatHolding {
  tokens: number;
  priceUsd: number;
  usd: number;
  source: 'indexer' | 'chain' | 'none';
}

/**
 * Whole-token balance of `wallet` in `mint`, or `null` when this net has no
 * balance reader. Injected so tests never need a real RPC.
 */
export type ChainBalanceReader = (
  net: Net,
  mint: string,
  wallet: string,
  decimals: number,
) => Promise<number | null>;

interface SplBalanceSource {
  splTokenBalances(owner: string): Promise<Map<string, number>>;
}

/** Builds the default reader from the chain RPCs: ERC-20 `balanceOf` on EVM nets, the owner's SPL accounts on Solana. */
export function chainBalanceReaderFor(rpcs: ChainRpcs): ChainBalanceReader {
  return async (net, mint, wallet, decimals) => {
    const rpc = rpcs[net];
    if (!rpc) return null;
    if (net === 'SOL') {
      const spl = rpc as Partial<SplBalanceSource>;
      if (typeof spl.splTokenBalances !== 'function') return null;
      const byMint = await spl.splTokenBalances(wallet);
      return byMint.get(mint) ?? 0;
    }
    const erc20 = asErc20BalanceSource(rpc);
    if (!erc20 || !mint.startsWith('0x')) return null;
    const atoms = await erc20.erc20BalanceAtoms(mint, wallet);
    const tok = Number(atoms) / 10 ** decimals;
    return Number.isFinite(tok) ? tok : 0;
  };
}

export interface ChatServiceOptions {
  db: Db;
  redis: RedisLike;
  now?: () => number;
  /** Either pass the RPC set (production) or a reader directly (tests). */
  rpcs?: ChainRpcs;
  chainBalance?: ChainBalanceReader;
  volumeGateUsd?: number;
  holderGateUsd?: number;
  /** Admin panel hooks (`deps.admin.settings` / `deps.admin.gate`); absent in unit tests. */
  settings?: {
    chatEnabled(): boolean;
    chatRateLimit(): RateLimitRule;
    moderationWords(): readonly string[];
  };
  moderation?: {
    state(net: Net, wallet: string): Promise<{ chatBanned: boolean; shadowMuted: boolean }>;
  };
}

export class ChatService {
  private readonly now: () => number;
  private readonly chainBalance: ChainBalanceReader | null;
  readonly volumeGateUsd: number;
  readonly holderGateUsd: number;

  constructor(private readonly opts: ChatServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.chainBalance = opts.chainBalance ?? (opts.rpcs ? chainBalanceReaderFor(opts.rpcs) : null);
    this.volumeGateUsd = opts.volumeGateUsd ?? CHAT_VOLUME_GATE_USD;
    this.holderGateUsd = opts.holderGateUsd ?? CHAT_HOLDER_GATE_USD;
  }

  /* ------------------------------------------------------------- volume gate */

  private volumeKey(wallet: string): string {
    return `chat:vol:${wallet}`;
  }

  /**
   * Lifetime USD value of the wallet's curve buys and sells across every net.
   * Summed from `trades` (the indexer's authoritative fill log) and cached for
   * {@link CHAT_VOLUME_CACHE_SECONDS}; {@link invalidateVolume} drops the
   * cache the moment a fill for the wallet is published.
   */
  async lifetimeVolumeUsd(wallet: string): Promise<number> {
    const key = this.volumeKey(wallet);
    const cached = await this.opts.redis.get(key);
    if (cached !== null) {
      const n = Number(cached);
      if (Number.isFinite(n)) return n;
    }
    const [row] = await this.opts.db
      .select({ total: sql<string>`coalesce(sum(${trades.usdValue}), 0)` })
      .from(trades)
      // Every net, spelled out so the `(net, trader, block_time)` index serves the lookup.
      .where(and(inArray(trades.net, [...ALL_NETS]), eq(trades.trader, wallet)));
    const total = Number(row?.total ?? 0);
    const volume = Number.isFinite(total) && total > 0 ? total : 0;
    await this.opts.redis.set(key, String(volume), { ttlSeconds: CHAT_VOLUME_CACHE_SECONDS });
    return volume;
  }

  /** Called when a fill for `wallet` lands, so the composer's progress moves at once. */
  async invalidateVolume(wallet: string): Promise<void> {
    await this.opts.redis.del(this.volumeKey(wallet));
  }

  /* ------------------------------------------------------------- holder gate */

  private holdingKey(net: Net, mint: string, wallet: string): string {
    return `chat:hold:${net}:${mint}:${wallet}`;
  }

  /** Drops a cached holder verdict — a sell fill must not ride out the cache. */
  async invalidateHolding(net: Net, sym: string, wallet: string): Promise<void> {
    const row = await resolveTokenRow(this.opts.db, net, { sym });
    if (!row) return;
    await this.opts.redis.del(this.holdingKey(net, row.mint, wallet));
  }

  /**
   * The wallet's USD position in `sym` at the API's token price
   * (`serialiseToken().priceUsd`, the same number the token page shows).
   *
   * The indexer's `holders_snapshot` row is the cheap answer. It is trusted
   * when it already clears the gate and the wallet has not traded the token
   * more recently than the row was written; otherwise — missing row, below
   * the gate, or a trade inside {@link CHAT_HOLDER_FRESH_TRADE_MS} — the chain
   * is read directly (ERC-20 `balanceOf` / SPL token accounts) so a fresh buy
   * admits immediately and a fresh sell evicts immediately.
   */
  async holding(net: Net, sym: string, wallet: string): Promise<ChatHolding | null> {
    const row = await resolveTokenRow(this.opts.db, net, { sym });
    if (!row || !row.mint) return null;
    const priceUsd = serialiseToken(row, this.now()).priceUsd;

    const key = this.holdingKey(net, row.mint, wallet);
    const cached = await this.opts.redis.get(key);
    if (cached !== null) {
      try {
        const parsed = JSON.parse(cached) as ChatHolding;
        if (typeof parsed.tokens === 'number') {
          // Re-price the cached balance: the balance is what is expensive to fetch, the price is not.
          return { ...parsed, priceUsd, usd: parsed.tokens * priceUsd };
        }
      } catch {
        /* fall through to a fresh read */
      }
    }

    const [snapshot] = await this.opts.db
      .select({ tokenAmount: holdersSnapshot.tokenAmount, updatedAt: holdersSnapshot.updatedAt })
      .from(holdersSnapshot)
      .where(
        and(
          eq(holdersSnapshot.net, net),
          eq(holdersSnapshot.mint, row.mint),
          eq(holdersSnapshot.wallet, wallet),
        ),
      )
      .limit(1);

    let result: ChatHolding = {
      tokens: snapshot?.tokenAmount ?? 0,
      priceUsd,
      usd: (snapshot?.tokenAmount ?? 0) * priceUsd,
      source: snapshot ? 'indexer' : 'none',
    };

    const clearsGate = result.usd >= this.holderGateUsd;
    const needsChain =
      !snapshot ||
      !clearsGate ||
      (await this.tradedSince(net, row.mint, wallet, snapshot.updatedAt));

    if (needsChain && this.chainBalance) {
      try {
        const onChain = await this.chainBalance(net, row.mint, wallet, row.tokenDecimals);
        if (onChain !== null) {
          result = { tokens: onChain, priceUsd, usd: onChain * priceUsd, source: 'chain' };
        }
      } catch {
        // RPC down: the indexer row (or its absence) stands — "DB mocks on-chain when RPC is down".
      }
    }

    await this.opts.redis.set(key, JSON.stringify(result), {
      ttlSeconds: CHAT_HOLDING_CACHE_SECONDS,
    });
    return result;
  }

  /** True when `wallet` has a fill in `mint` newer than `since` and inside the freshness window. */
  private async tradedSince(net: Net, mint: string, wallet: string, since: Date): Promise<boolean> {
    const floor = new Date(Math.max(since.getTime(), this.now() - CHAT_HOLDER_FRESH_TRADE_MS));
    const [recent] = await this.opts.db
      .select({ id: trades.id })
      .from(trades)
      .where(
        and(
          eq(trades.net, net),
          eq(trades.trader, wallet),
          eq(trades.mint, mint),
          gt(trades.blockTime, floor),
        ),
      )
      .limit(1);
    return !!recent;
  }

  /* -------------------------------------------------------------- the verdict */

  /**
   * Everything a client needs to draw a room: whether it may be read, whether
   * the composer is live, and the progress numbers for the locked states.
   * `wallet` is `null` for a guest.
   */
  async access(net: Net, roomName: string, wallet: string | null): Promise<ChatAccess> {
    const room = parseRoom(roomName);
    const base: ChatAccess = {
      room: room.key,
      kind: room.kind,
      sym: room.kind === 'global' ? null : room.sym,
      signedIn: wallet !== null,
      canRead: room.kind !== 'private',
      canPost: false,
      reason: null,
      volumeUsd: null,
      volumeRequiredUsd: this.volumeGateUsd,
      holdingUsd: null,
      holdingRequiredUsd: this.holderGateUsd,
    };

    if (room.kind === 'private') {
      if (wallet === null) return { ...base, reason: 'unauthorized' };
      const holding = await this.holding(net, room.sym, wallet);
      if (!holding) return { ...base, reason: 'unknown_token', holdingUsd: 0 };
      const ok = holding.usd >= this.holderGateUsd;
      return {
        ...base,
        canRead: ok,
        canPost: ok,
        reason: ok ? null : 'holder_required',
        holdingUsd: holding.usd,
      };
    }

    if (wallet === null) return { ...base, reason: 'unauthorized' };
    const volumeUsd = await this.lifetimeVolumeUsd(wallet);
    const ok = volumeUsd >= this.volumeGateUsd;
    return { ...base, canPost: ok, reason: ok ? null : 'volume_required', volumeUsd };
  }

  /* ------------------------------------------------------------------- send */

  async send(net: Net, room: string, wallet: string, rawText: string): Promise<ChatSendResult> {
    const text = rawText.trim();
    if (!text) return { ok: false, error: 'empty' };
    if (text.length > CHAT_MAX_LEN) return { ok: false, error: 'too_long' };
    if (this.opts.settings && !this.opts.settings.chatEnabled()) {
      return { ok: false, error: 'chat_disabled' };
    }
    const moderation = await this.opts.moderation?.state(net, wallet);
    if (moderation?.chatBanned) return { ok: false, error: 'banned' };

    // Gate before the limiter: a locked wallet hammering the composer must not
    // burn its own quota, but it must not get a message through either.
    const access = await this.access(net, room, wallet);
    if (!access.canPost) return { ok: false, error: access.reason ?? 'unauthorized', access };

    const verdict = await rateLimit(
      this.opts.redis,
      this.opts.settings?.chatRateLimit() ?? CHAT_RATE_LIMIT,
      `${net}:${wallet}`,
      Math.floor(this.now() / 1000),
    );
    if (!verdict.ok)
      return { ok: false, error: 'rate_limited', retryAfterSeconds: verdict.resetSeconds };

    // A shadow-muted wallet's message persists flagged: the sender sees success,
    // nobody else ever receives it (flagged rows are never broadcast or replayed).
    const flagged =
      isFlagged(text, this.opts.settings?.moderationWords() ?? []) ||
      moderation?.shadowMuted === true;
    const normalisedRoom = access.room;

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
