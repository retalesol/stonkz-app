import { Hono } from 'hono';
import { requireAdmin, audited, type AdminEnv } from '../admin/middleware.js';
import { readBody } from '../admin/http.js';
import { SettingsError, settingDef } from '../admin/settings.js';

/**
 * `/admin/settings` — the DB-backed platform knobs (`admin/settings.ts`).
 * Reads are open to every role; writes need `admin`. Each write records the
 * before/after value, and `wired` in the listing says whether the API reads it.
 */
export function adminSettingsRoutes(): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();

  app.get('/admin/settings', requireAdmin('viewer'), (c) => {
    const deps = c.get('deps');
    return c.json({ settings: deps.admin.settings.all() });
  });

  app.put('/admin/settings/:key', requireAdmin('admin'), async (c) => {
    const deps = c.get('deps');
    const key = c.req.param('key');
    if (!settingDef(key)) return c.json({ error: 'not_found' }, 404);
    const body = await readBody(c);
    if (!('value' in body))
      return c.json({ error: 'bad_request', detail: 'body.value is required' }, 400);
    try {
      const result = await deps.admin.settings.set(key, body['value'], c.get('admin').address);
      await audited(c, 'settings.set', key, { value: result.before }, { value: result.after });
      return c.json({ ok: true, key, ...result });
    } catch (err) {
      if (err instanceof SettingsError)
        return c.json({ error: err.code, detail: err.message }, 400);
      throw err;
    }
  });

  app.delete('/admin/settings/:key', requireAdmin('admin'), async (c) => {
    const deps = c.get('deps');
    const key = c.req.param('key');
    if (!settingDef(key)) return c.json({ error: 'not_found' }, 404);
    const result = await deps.admin.settings.reset(key);
    await audited(c, 'settings.reset', key, { value: result.before }, { value: result.after });
    return c.json({ ok: true, key, ...result });
  });

  return app;
}
