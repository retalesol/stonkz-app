import { Hono } from 'hono';
import { limit } from '../app/middleware.js';
import { RATE_LIMITS } from '../redis/ratelimit.js';
import type { AppEnv } from '../app/context.js';

/** Plan step 153 — `GET /x/:handle`. */
export function xRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/x/:handle', limit(RATE_LIMITS.x), async (c) => {
    const deps = c.get('deps');
    const handle = c.req.param('handle');
    if (!handle) return c.json({ error: 'bad_request' }, 400);
    const profile = await deps.xCache.get(handle);
    return c.json(profile);
  });

  return app;
}
