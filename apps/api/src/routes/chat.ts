import { Hono } from 'hono';
import type { Net } from '@stonkz/shared';
import { limit, requireAuth } from '../app/middleware.js';
import { RATE_LIMITS } from '../redis/ratelimit.js';
import type { AppEnv } from '../app/context.js';

/**
 * Plan step 151-152's REST half. Sending goes over `ws/hub.ts`'s `send_chat`
 * message so the room's other subscribers see it live; this is just the
 * backscroll a drawer needs the moment it opens a room, before any socket
 * message has arrived. `POST /chat/:net/:room` exists too, for anything that
 * cannot hold a socket open (a CLI, a test, a bot) — the WS path is not the
 * only way in, both go through the same `ChatService.send`.
 */
function parseNet(raw: string | undefined): Net | null {
  return raw === 'SOL' || raw === 'RH' ? raw : null;
}

export function chatRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/chat/:net/:room/history', limit(RATE_LIMITS.read), async (c) => {
    const deps = c.get('deps');
    const net = parseNet(c.req.param('net'));
    const room = c.req.param('room');
    if (!net || !room) return c.json({ error: 'bad_request' }, 400);
    const messages = await deps.chat.history(net, room);
    return c.json({ net, room: room.toUpperCase().replace(/^\$/, ''), messages });
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
    if (!result.ok) return c.json({ error: result.error }, result.error === 'rate_limited' ? 429 : 400);

    if (!result.message?.flagged && result.message) {
      await deps.publisher.chat(net, result.message.room, {
        type: 'message',
        net,
        room: result.message.room,
        id: result.message.id,
        wallet: user.wallet,
        text: result.message.text,
        createdAtMs: result.message.createdAtMs,
      });
    }

    return c.json({ ok: true, message: result.message });
  });

  return app;
}
