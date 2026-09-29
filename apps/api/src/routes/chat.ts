import { Hono } from 'hono';
import { and, eq, inArray } from 'drizzle-orm';
import { parseNet, type Net } from '@stonkz/shared';
import { users } from '../db/schema.js';
import { limit, optionalAuth, requireAuth } from '../app/middleware.js';
import { RATE_LIMITS } from '../redis/ratelimit.js';
import type { AppDeps, AppEnv } from '../app/context.js';
import { parseRoom, type ChatSendError } from '../social/chat.js';

/**
 * Plan step 151-152's REST half. Sending goes over `ws/hub.ts`'s `send_chat`
 * message so the room's other subscribers see it live; this is just the
 * backscroll a drawer needs the moment it opens a room, before any socket
 * message has arrived. `POST /chat/:net/:room` exists too, for anything that
 * cannot hold a socket open (a CLI, a test, a bot) — the WS path is not the
 * only way in, both go through the same `ChatService.send`, which is also
 * where the $100-volume and $5-holder gates live.
 *
 * History and live frames carry `username` / `avatarUrl` when the sender has
 * a profile row, so the drawer never invents "YOU" or RNG handles.
 */

async function profileMap(
  deps: AppDeps,
  net: Net,
  wallets: string[],
): Promise<Map<string, { username: string | null; avatarUrl: string | null }>> {
  const unique = [...new Set(wallets.filter(Boolean))];
  const out = new Map<string, { username: string | null; avatarUrl: string | null }>();
  if (!unique.length) return out;
  const rows = await deps.db
    .select({ wallet: users.wallet, username: users.username, avatarUrl: users.avatarUrl })
    .from(users)
    .where(and(eq(users.net, net), inArray(users.wallet, unique)));
  for (const r of rows) out.set(r.wallet, { username: r.username, avatarUrl: r.avatarUrl });
  return out;
}

/** HTTP status for a `ChatService.send` refusal. */
export function chatErrorStatus(error: ChatSendError): 400 | 401 | 403 | 404 | 429 | 503 {
  switch (error) {
    case 'rate_limited':
      return 429;
    case 'unauthorized':
      return 401;
    case 'volume_required':
    case 'holder_required':
    case 'net_mismatch':
    case 'banned':
      return 403;
    case 'unknown_token':
      return 404;
    case 'chat_disabled':
      return 503;
    default:
      return 400;
  }
}

export function chatRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  /**
   * The gate snapshot the composer renders from: `canRead` / `canPost` plus
   * the progress numbers ("$X SO FAR", "HOLD $5 OF $SYM"). Guests get the
   * public rooms' read-only view; the private room needs a token.
   */
  app.get('/chat/:net/:room/access', optionalAuth(), limit(RATE_LIMITS.read), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    const net = parseNet(c.req.param('net'));
    const room = c.req.param('room');
    if (!net || !room) return c.json({ error: 'bad_request' }, 400);
    const wallet = user && user.net === net ? user.wallet : null;
    return c.json(await deps.chat.access(net, room, wallet));
  });

  app.get('/chat/:net/:room/history', optionalAuth(), limit(RATE_LIMITS.read), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    const net = parseNet(c.req.param('net'));
    const room = c.req.param('room');
    if (!net || !room) return c.json({ error: 'bad_request' }, 400);

    const parsed = parseRoom(room);
    if (parsed.kind === 'private') {
      // Reading the holders' room is gated exactly like posting in it.
      const wallet = user && user.net === net ? user.wallet : null;
      const access = await deps.chat.access(net, room, wallet);
      if (!access.canRead) {
        const error = access.reason ?? 'unauthorized';
        return c.json({ error, access }, chatErrorStatus(error));
      }
    }

    const messages = await deps.chat.history(net, room);
    const profiles = await profileMap(
      deps,
      net,
      messages.map((m) => m.wallet),
    );
    return c.json({
      net,
      room: parsed.key,
      messages: messages.map((m) => {
        const p = profiles.get(m.wallet);
        return {
          ...m,
          username: p?.username ?? null,
          avatarUrl: p?.avatarUrl ?? null,
        };
      }),
    });
  });

  app.post('/chat/:net/:room', requireAuth(), limit(RATE_LIMITS.social), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const net = parseNet(c.req.param('net'));
    const room = c.req.param('room');
    if (!net || !room) return c.json({ error: 'bad_request' }, 400);
    if (net !== user.net) return c.json({ error: 'net_mismatch' }, 400);

    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown };
    const result = await deps.chat.send(net, room, user.wallet, String(body.text ?? ''));
    if (!result.ok) {
      const error = result.error ?? 'empty';
      return c.json(
        {
          error,
          ...(result.access ? { access: result.access } : {}),
          ...(result.retryAfterSeconds !== undefined
            ? { retryAfterSeconds: result.retryAfterSeconds }
            : {}),
        },
        chatErrorStatus(error),
      );
    }

    const [profile] = await deps.db
      .select({ username: users.username, avatarUrl: users.avatarUrl })
      .from(users)
      .where(and(eq(users.net, net), eq(users.wallet, user.wallet)))
      .limit(1);

    if (!result.message?.flagged && result.message) {
      await deps.publisher.chat(net, result.message.room, {
        type: 'message',
        net,
        room: result.message.room,
        id: result.message.id,
        wallet: user.wallet,
        text: result.message.text,
        createdAtMs: result.message.createdAtMs,
        username: profile?.username ?? null,
        avatarUrl: profile?.avatarUrl ?? null,
      });
    }

    return c.json({
      ok: true,
      message: result.message
        ? {
            ...result.message,
            username: profile?.username ?? null,
            avatarUrl: profile?.avatarUrl ?? null,
          }
        : null,
    });
  });

  return app;
}
