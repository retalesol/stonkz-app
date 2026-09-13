import { Hono } from 'hono';
import { and, eq, inArray } from 'drizzle-orm';
import type { Net } from '@stonkz/shared';
import { users } from '../db/schema.js';
import { limit, requireAuth } from '../app/middleware.js';
import { RATE_LIMITS } from '../redis/ratelimit.js';
import type { AppDeps, AppEnv } from '../app/context.js';

/**
 * Plan step 151-152's REST half. Sending goes over `ws/hub.ts`'s `send_chat`
 * message so the room's other subscribers see it live; this is just the
 * backscroll a drawer needs the moment it opens a room, before any socket
 * message has arrived. `POST /chat/:net/:room` exists too, for anything that
 * cannot hold a socket open (a CLI, a test, a bot) — the WS path is not the
 * only way in, both go through the same `ChatService.send`.
 *
 * History and live frames carry `username` / `avatarUrl` when the sender has
 * a profile row, so the drawer never invents "YOU" or RNG handles.
 */
function parseNet(raw: string | undefined): Net | null {
  return raw === 'SOL' || raw === 'RH' ? raw : null;
}

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

export function chatRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/chat/:net/:room/history', limit(RATE_LIMITS.read), async (c) => {
    const deps = c.get('deps');
    const net = parseNet(c.req.param('net'));
    const room = c.req.param('room');
    if (!net || !room) return c.json({ error: 'bad_request' }, 400);
    const messages = await deps.chat.history(net, room);
    const profiles = await profileMap(deps, net, messages.map((m) => m.wallet));
    return c.json({
      net,
      room: room.toUpperCase().replace(/^\$/, ''),
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
    if (!result.ok) return c.json({ error: result.error }, result.error === 'rate_limited' ? 429 : 400);

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
