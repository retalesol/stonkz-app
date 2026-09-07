import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { nativeUnit, type Net } from '@stonkz/shared';
import { tokens } from '../db/schema.js';
import { limit } from '../app/middleware.js';
import { RATE_LIMITS } from '../redis/ratelimit.js';
import type { AppEnv } from '../app/context.js';
import { aggregatorFor, composeQuote } from '../router/compose.js';
import { RouterError } from '../router/errors.js';
import type { TokenRow } from './serialise.js';

function parseNet(raw: string | undefined): Net | null {
  return raw === 'SOL' || raw === 'RH' ? raw : null;
}

/**
 * `GET /tokens/:sym/quote?side=&amount=` — plan step 82.
 *
 * Delegates every hop-pricing decision to `router/compose.ts`: real
 * `@stonkz/curve-sim` math against live curve state once a token has one
 * (every token this phase's `/launch/confirm` creates), the pre-existing
 * mc/supply approximation for rows that do not (everything the Phase 1.C
 * fixture read-path track seeds — kept working, unmodified, alongside it).
 * The 8-second Redis cache, keyed by net + side + native amount + base mint,
 * is unchanged from Phase 1.C.
 */
export function quoteRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/tokens/:sym/quote', limit(RATE_LIMITS.quote), async (c) => {
    const deps = c.get('deps');
    const sym = c.req.param('sym').toUpperCase();
    const net = parseNet(c.req.query('net')) ?? c.get('user')?.net ?? 'SOL';
    const side = c.req.query('side') === 'sell' ? 'sell' : 'buy';
    const amount = Number.parseFloat(c.req.query('amount') ?? '');

    if (!Number.isFinite(amount) || amount <= 0) {
      return c.json({ error: 'bad_request', detail: 'amount must be a positive native amount' }, 400);
    }

    const [row] = await deps.db
      .select()
      .from(tokens)
      .where(and(eq(tokens.net, net), eq(tokens.sym, sym)))
      .limit(1);
    if (!row) return c.json({ error: 'not_found' }, 404);

    try {
      const cached = await deps.quotes.wrap(
        { net, side, nativeAmount: amount, baseMint: row.baseMint, sym },
        async () => {
          const now = deps.now();
          const native = nativeUnit(net);
          const usdPrice = await deps.oracle.nativeUsd(native).catch(() => null);
          const aggregatorVenue = aggregatorFor(net, row.baseSymbol);
          const aggregator = aggregatorVenue === 'JUPITER' ? deps.jupiter : aggregatorVenue === 'UNISWAP' ? deps.uniswap : null;

          return composeQuote({
            net,
            side,
            amount,
            row: row as TokenRow,
            usdPrice,
            now,
            aggregator,
          });
        },
      );

      // The bar drains against the cache entry's expiry, not the request time, so
      // a cache hit is honest about how stale it is.
      c.header('Cache-Control', `public, max-age=${deps.env.quoteCacheTtlSeconds}`);
      return c.json({ ...cached.value, expiresAt: cached.expiresAt });
    } catch (err) {
      if (err instanceof RouterError) return c.json(err.toResponse(), err.httpStatus);
      throw err;
    }
  });

  return app;
}
