import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { esc, inferNetFromAddress, parseNet, usd } from '@stonkz/shared';
import { users } from '../db/schema.js';
import { limit } from '../app/middleware.js';
import { RATE_LIMITS } from '../redis/ratelimit.js';
import type { AppEnv } from '../app/context.js';
import { resolveTokenRow } from './token-resolve.js';

/**
 * Plan step 155 — "OG images per `/t/:sym`", extended to profile pages per
 * this phase's `/u/:net/:addr`.
 *
 * `apps/web` is a pure Vite SPA (plan's "target frontend layout" never adds a
 * server), so a social crawler hitting `https://ston.kz/t/SYM` directly gets
 * the same `index.html` shell every browser gets — no meta tags reflect the
 * coin. These routes are the server-rendered stand-in a crawler should be
 * pointed at instead: `GET /og/t/:sym` and `GET /og/u/:net/:addr` return a
 * tiny real HTML document with the right `og:title`/`og:description`/
 * `og:url` (and a `twitter:card`), plus a JS + meta-refresh redirect to the
 * real SPA URL for the rare human who opens the OG link directly.
 *
 * Getting a *crawler* to actually request this instead of the SPA URL needs
 * an edge rule outside this repo's API — `apps/web/vercel.json` (added this
 * phase) rewrites known bot user agents on `ston.kz/t/*` and `ston.kz/u/*` to
 * this host. See the final report for why that rewrite, not a change to
 * `apps/web`'s own (framework-less) build, is the right layer for it.
 */
function ogPage(opts: { title: string; description: string; url: string; image?: string }): string {
  const image = opts.image ?? '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="STONKZ">
<meta property="og:title" content="${esc(opts.title)}">
<meta property="og:description" content="${esc(opts.description)}">
<meta property="og:url" content="${esc(opts.url)}">
${image ? `<meta property="og:image" content="${esc(image)}">` : ''}
<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${esc(opts.title)}">
<meta name="twitter:description" content="${esc(opts.description)}">
<meta http-equiv="refresh" content="0; url=${esc(opts.url)}">
<script>location.replace(${JSON.stringify(opts.url)});</script>
</head>
<body><a href="${esc(opts.url)}">${esc(opts.title)}</a></body>
</html>`;
}

export function ogRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/og/t/:sym', limit(RATE_LIMITS.read), async (c) => {
    const deps = c.get('deps');
    const net = parseNet(c.req.query('net')) ?? 'SOL';
    const sym = (c.req.param('sym') ?? '').toUpperCase();
    const mintQ = c.req.query('mint')?.trim();
    const row = await resolveTokenRow(deps.db, net, { mint: mintQ, sym });
    const url = row?.mint
      ? `${deps.env.publicWebOrigin}/t/${sym}?mint=${encodeURIComponent(row.mint)}`
      : `${deps.env.publicWebOrigin}/t/${sym}`;
    if (!row) {
      c.header('content-type', 'text/html; charset=utf-8');
      return c.body(ogPage({ title: `STONKZ · $${sym}`, description: 'A coin on ston.kz.', url }));
    }
    const title = `STONKZ · $${row.sym} · ${usd(row.mc)} MCAP`;
    const description = row.descr || `${row.name} ($${row.sym}) is trading on ston.kz.`;
    c.header('content-type', 'text/html; charset=utf-8');
    return c.body(ogPage({ title, description, url }));
  });

  /** Profile OG when net is unknown — infers SOL vs EVM from address shape. */
  app.get('/og/u/:addr', limit(RATE_LIMITS.read), async (c) => {
    const deps = c.get('deps');
    const addr = c.req.param('addr') ?? '';
    const netQ = parseNet(c.req.query('net'));
    const net = netQ ?? (addr.startsWith('0x') ? inferNetFromAddress(addr, 'RH') : 'SOL');
    const url = `${deps.env.publicWebOrigin}/u/${addr}`;
    if (!addr) {
      c.header('content-type', 'text/html; charset=utf-8');
      return c.body(ogPage({ title: 'STONKZ', description: 'A member of ston.kz.', url }));
    }
    const [row] = await deps.db
      .select()
      .from(users)
      .where(and(eq(users.net, net), eq(users.wallet, addr)))
      .limit(1);
    const name = row?.username || `${addr.slice(0, 4)}…${addr.slice(-4)}`;
    const description = row?.bio || `${name}'s profile on ston.kz.`;
    c.header('content-type', 'text/html; charset=utf-8');
    return c.body(ogPage({ title: `STONKZ · ${name}`, description, url }));
  });

  app.get('/og/u/:net/:addr', limit(RATE_LIMITS.read), async (c) => {
    const deps = c.get('deps');
    const net = parseNet(c.req.param('net'));
    const addr = c.req.param('addr');
    const url = `${deps.env.publicWebOrigin}/u/${addr ?? ''}`;
    if (!net || !addr) {
      c.header('content-type', 'text/html; charset=utf-8');
      return c.body(ogPage({ title: 'STONKZ', description: 'A member of ston.kz.', url }));
    }
    const [row] = await deps.db
      .select()
      .from(users)
      .where(and(eq(users.net, net), eq(users.wallet, addr)))
      .limit(1);
    const name = row?.username || `${addr.slice(0, 4)}…${addr.slice(-4)}`;
    const description = row?.bio || `${name}'s profile on ston.kz.`;
    c.header('content-type', 'text/html; charset=utf-8');
    return c.body(ogPage({ title: `STONKZ · ${name}`, description, url }));
  });

  return app;
}
