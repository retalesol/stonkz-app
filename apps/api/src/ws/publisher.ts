import type { Net } from '@stonkz/shared';
import { CHANNELS, type BoardEvent, type ChatEvent, type TapeEvent, type TokenEvent, type UserEvent } from '../redis/channels.js';
import type { RedisLike } from '../redis/types.js';

/**
 * The only way anything gets onto a WS channel.
 *
 * Both the API (crate opens, ledger awards) and the indexer (fills, lane
 * moves) publish through Redis rather than writing to sockets directly, so a
 * scaled-out deployment fans out correctly and a single-process dev setup
 * behaves identically via `MemoryRedis`.
 */
export class Publisher {
  constructor(
    private readonly redis: RedisLike,
    private readonly now: () => number = Date.now,
  ) {}

  private async send(channel: string, event: object): Promise<void> {
    await this.redis.publish(channel, JSON.stringify({ ...event, at: this.now() }));
  }

  board(event: BoardEvent): Promise<void> {
    return this.send(CHANNELS.board(), event);
  }

  token(sym: string, event: TokenEvent): Promise<void> {
    return this.send(CHANNELS.token(sym), event);
  }

  tape(event: TapeEvent): Promise<void> {
    return this.send(CHANNELS.tape(), event);
  }

  /** `WS user:{addr}` — the rewards ceremonies (plan step 121). */
  user(net: Net, wallet: string, event: UserEvent): Promise<void> {
    return this.send(CHANNELS.user(net, wallet), event);
  }

  /** `WS chat:{net}:{room}` — plan step 151. */
  chat(net: Net, room: string, event: ChatEvent): Promise<void> {
    return this.send(CHANNELS.chat(net, room), event);
  }

  /** A fill lands on the token page, the board and the tape at once. */
  async fill(net: Net, sym: string, payload: unknown): Promise<void> {
    await Promise.all([
      this.token(sym, { type: 'fill', net, sym, payload }),
      this.tape({ type: 'fill', net, sym, payload }),
    ]);
  }
}
