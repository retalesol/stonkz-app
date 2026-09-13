import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { and, eq } from 'drizzle-orm';
import type { Net } from '@stonkz/shared';
import { CHANNELS, CHANNEL_PATTERNS } from '../redis/channels.js';
import type { RedisLike, RedisUnsubscribe } from '../redis/types.js';
import type { JwtService } from '../auth/jwt.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import type { ChatService } from '../social/chat.js';
import type { Publisher } from './publisher.js';

export interface HubOptions {
  redis: RedisLike;
  jwt: JwtService;
  logger: Logger;
  metrics: Metrics;
  path?: string;
  /** Heartbeat interval; a socket that misses two pongs is dropped. */
  pingIntervalMs?: number;
  /**
   * Plan step 151's chat send path. Optional so every existing test that
   * builds a hub without them keeps working — a hub with neither refuses
   * `send_chat` with `error: "chat_unavailable"` rather than throwing.
   */
  chat?: ChatService;
  publisher?: Publisher;
  /** Optional: enrich chat frames with username / avatar. */
  db?: Db;
}

interface Client {
  socket: WebSocket;
  channels: Set<string>;
  alive: boolean;
  /** Set once the socket authenticates; gates `user:` subscriptions. */
  identity: { net: Net; wallet: string } | null;
}

type ClientMessage =
  | { type: 'auth'; token: string }
  | { type: 'subscribe'; channel: string }
  | { type: 'unsubscribe'; channel: string }
  | { type: 'ping' }
  | { type: 'send_chat'; net: Net; room: string; text: string };

/**
 * The WS gateway.
 *
 * Every message a client receives originates from Redis pub/sub, not from this
 * process's own state, so scaling to N API instances needs no sticky routing.
 * The hub keeps exactly one Redis subscription per channel *pattern* and fans
 * out in memory.
 *
 * `board` and `tape` are public. `token:{sym}` is public. `user:{net}:{addr}`
 * requires a verified access token *for that address* — otherwise anyone could
 * watch anyone's XP.
 */
export class WsHub {
  private readonly wss: WebSocketServer;
  private readonly clients = new Map<WebSocket, Client>();
  /** channel -> sockets. */
  private readonly subscribers = new Map<string, Set<WebSocket>>();
  private readonly unsubscribes: RedisUnsubscribe[] = [];
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(private readonly opts: HubOptions) {
    this.wss = new WebSocketServer({ noServer: true });
  }

  async attach(server: Server): Promise<void> {
    const path = this.opts.path ?? '/ws';

    server.on('upgrade', (req, socket, head) => {
      if (!req.url || new URL(req.url, 'http://localhost').pathname !== path) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    });

    // One Redis subscription per lane; patterns cover the per-token and
    // per-user channels without a subscription per symbol or per wallet.
    this.unsubscribes.push(
      await this.opts.redis.subscribe(CHANNELS.board(), (m, ch) => this.deliver(ch, m)),
      await this.opts.redis.subscribe(CHANNELS.tape(), (m, ch) => this.deliver(ch, m)),
      await this.opts.redis.psubscribe(CHANNEL_PATTERNS.token, (m, ch) => this.deliver(ch, m)),
      await this.opts.redis.psubscribe(CHANNEL_PATTERNS.user, (m, ch) => this.deliver(ch, m)),
      await this.opts.redis.psubscribe(CHANNEL_PATTERNS.chat, (m, ch) => this.deliver(ch, m)),
    );

    const interval = this.opts.pingIntervalMs ?? 30_000;
    this.heartbeat = setInterval(() => this.sweep(), interval);
    this.heartbeat.unref?.();
  }

  private onConnection(socket: WebSocket): void {
    const client: Client = { socket, channels: new Set(), alive: true, identity: null };
    this.clients.set(socket, client);
    this.opts.metrics.wsConnected();

    socket.on('pong', () => {
      client.alive = true;
    });
    socket.on('message', (raw) => void this.onMessage(client, raw.toString()));
    socket.on('close', () => this.onClose(client));
    socket.on('error', () => this.onClose(client));

    this.send(client, {
      type: 'hello',
      channels: ['board', 'tape', 'token:{sym}', 'user:{net}:{addr}', 'chat:{net}:{room}'],
    });
  }

  private async onMessage(client: Client, raw: string): Promise<void> {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      this.send(client, { type: 'error', error: 'bad_json' });
      return;
    }

    switch (msg.type) {
      case 'ping':
        this.send(client, { type: 'pong' });
        return;

      case 'auth': {
        try {
          const claims = await this.opts.jwt.verify(msg.token, 'access');
          client.identity = { net: claims.net, wallet: claims.sub };
          this.send(client, { type: 'auth', ok: true, net: claims.net, wallet: claims.sub });
        } catch {
          this.send(client, { type: 'auth', ok: false });
        }
        return;
      }

      case 'subscribe': {
        const channel = msg.channel;
        if (!this.maySubscribe(client, channel)) {
          this.send(client, { type: 'error', error: 'forbidden', channel });
          return;
        }
        if (client.channels.has(channel)) return;
        client.channels.add(channel);
        let set = this.subscribers.get(channel);
        if (!set) {
          set = new Set();
          this.subscribers.set(channel, set);
        }
        set.add(client.socket);
        this.opts.metrics.wsSubscriptionsChanged(1);
        this.send(client, { type: 'subscribed', channel });
        return;
      }

      case 'unsubscribe': {
        if (!client.channels.delete(msg.channel)) return;
        this.subscribers.get(msg.channel)?.delete(client.socket);
        this.opts.metrics.wsSubscriptionsChanged(-1);
        this.send(client, { type: 'unsubscribed', channel: msg.channel });
        return;
      }

      case 'send_chat': {
        if (!client.identity) {
          this.send(client, { type: 'error', error: 'unauthorized' });
          return;
        }
        if (!this.opts.chat || !this.opts.publisher) {
          this.send(client, { type: 'error', error: 'chat_unavailable' });
          return;
        }
        const { net, wallet } = client.identity;
        if (msg.net !== net) {
          this.send(client, { type: 'error', error: 'net_mismatch' });
          return;
        }
        const result = await this.opts.chat.send(net, msg.room, wallet, msg.text);
        if (!result.ok) {
          this.send(client, { type: 'send_chat', ok: false, error: result.error });
          return;
        }
        this.send(client, { type: 'send_chat', ok: true });
        if (!result.message?.flagged) {
          let username: string | null = null;
          let avatarUrl: string | null = null;
          if (this.opts.db) {
            const [profile] = await this.opts.db
              .select({ username: users.username, avatarUrl: users.avatarUrl })
              .from(users)
              .where(and(eq(users.net, net), eq(users.wallet, wallet)))
              .limit(1);
            username = profile?.username ?? null;
            avatarUrl = profile?.avatarUrl ?? null;
          }
          await this.opts.publisher.chat(net, result.message?.room ?? msg.room, {
            type: 'message',
            net,
            room: result.message?.room ?? msg.room,
            id: result.message?.id ?? 0,
            wallet,
            text: result.message?.text ?? msg.text,
            createdAtMs: result.message?.createdAtMs ?? Date.now(),
            username,
            avatarUrl,
          });
        }
        return;
      }

      default:
        this.send(client, { type: 'error', error: 'unknown_type' });
    }
  }

  /** A `user:` channel is only readable by the address it belongs to. */
  maySubscribe(client: Client, channel: string): boolean {
    if (channel === 'board' || channel === 'tape') return true;
    if (channel.startsWith('token:')) return channel.length > 'token:'.length;
    if (channel.startsWith('chat:')) return channel.length > 'chat:'.length;
    if (channel.startsWith('user:')) {
      if (!client.identity) return false;
      return channel === CHANNELS.user(client.identity.net, client.identity.wallet);
    }
    return false;
  }

  private deliver(channel: string, message: string): void {
    const sockets = this.subscribers.get(channel);
    if (!sockets || sockets.size === 0) return;

    let frame: string;
    try {
      frame = JSON.stringify({ channel, data: JSON.parse(message) as unknown });
    } catch (err) {
      // A malformed payload is a publisher bug, not a reason to drop the lane.
      this.opts.logger.error('ws: undeliverable payload', { channel, err: String(err) });
      return;
    }

    // `readyState` can go stale between the check and the write, and a socket
    // that closed in that window throws. One wedged client must not stop the
    // rest of the room from seeing this message.
    for (const socket of [...sockets]) {
      if (socket.readyState !== socket.OPEN) continue;
      try {
        socket.send(frame);
        this.opts.metrics.wsMessageSent();
      } catch (err) {
        this.opts.logger.warn('ws: send failed, dropping client', { channel, err: String(err) });
        this.dropSocket(socket);
      }
    }
  }

  private send(client: Client, payload: object): void {
    if (client.socket.readyState !== client.socket.OPEN) return;
    try {
      client.socket.send(JSON.stringify(payload));
      this.opts.metrics.wsMessageSent();
    } catch {
      this.dropSocket(client.socket);
    }
  }

  private dropSocket(socket: WebSocket): void {
    const client = this.clients.get(socket);
    if (client) this.onClose(client);
    try {
      socket.terminate();
    } catch {
      // Already gone.
    }
  }

  private onClose(client: Client): void {
    if (!this.clients.delete(client.socket)) return;
    for (const channel of client.channels) {
      this.subscribers.get(channel)?.delete(client.socket);
      this.opts.metrics.wsSubscriptionsChanged(-1);
    }
    client.channels.clear();
    this.opts.metrics.wsDisconnected();
  }

  private sweep(): void {
    for (const client of this.clients.values()) {
      if (!client.alive) {
        client.socket.terminate();
        this.onClose(client);
        continue;
      }
      client.alive = false;
      client.socket.ping();
    }
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const un of this.unsubscribes) await un();
    for (const client of [...this.clients.values()]) {
      client.socket.close();
      this.onClose(client);
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  get connectionCount(): number {
    return this.clients.size;
  }
}
