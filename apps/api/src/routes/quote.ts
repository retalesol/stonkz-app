import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import {
  effFee,
  nativeUnit,
  type Net,
  type Quote,
  type QuoteHop,
  type Venue,
} from '@stonkz/shared';
import { tokens } from '../db/schema.js';
import { limit } from '../app/middleware.js';
import { RATE_LIMITS } from '../redis/ratelimit.js';
import type { AppEnv } from '../app/context.js';

function parseNet(raw: string | undefined): Net | null {
  return raw === 'SOL' || raw === 'RH' ? raw : null;
}

/** Hop 1's venue, or none when the base mint already *is* the native token. */
function aggregatorFor(net: Net, baseSymbol: string): Venue | null {
  const native = nativeUnit(net);
  const wrapped = net === 'SOL' ? 'WSOL' : 'WETH';
  const base = baseSymbol.toUpperCase();
  if (base === native || base === wrapped) return null;
  return net === 'SOL' ? 'JUPITER' : 'UNISWAP';
}

/**
 * `GET /tokens/:sym/quote?side=&amount=` — plan step 59's cache surface.
 *
 * Scope note: composing the real Jupiter/Uniswap route (plan 2.R) is another
 * track's work. What lives here is everything the read path owns — the
 * native-denominated request, the two-hop response *shape*, the zero platform
 * fee on hop 1, the creator `effFee()` on the curve hop, and the 8-second
 * Redis cache keyed by net + side + native amount + base mint. Hop pricing
 * uses the shared curve stand-in and is labelled `indicative`, so nothing
 * downstream mistakes it for an executable quote.
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

    const cached = await deps.quotes.wrap(
      { net, side, nativeAmount: amount, baseMint: row.baseMint, sym },
      async () => {
        const now = deps.now();
        const native = nativeUnit(net);
        const graduated = row.graduatedAt !== null;
        // After graduation the curve fee stops; venue fees are the DEX's.
        const feePct = graduated ? 0 : effFee(
          { tfee: row.feeBps / 100, cashback: row.cashback, cbStart: row.cbStartMs ?? undefined },
          now,
        );
        const aggregator = aggregatorFor(net, row.baseSymbol);
        const usdPrice = await deps.oracle.nativeUsd(native).catch(() => null);

        const hops: QuoteHop[] = [];
        // Hop 1: native -> base. Stonkz charges nothing here, ever.
        const baseAmount = amount;
        if (aggregator) {
          hops.push({
            venue: aggregator,
            inSymbol: side === 'buy' ? native : row.baseSymbol,
            outSymbol: side === 'buy' ? row.baseSymbol : native,
            inAmount: amount,
            outAmount: baseAmount,
            impactPct: 0,
            feeBps: 0,
            feeAmount: 0,
          });
        }

        // Hop 2: the curve. The only hop that carries a Stonkz fee.
        const feeAmount = baseAmount * (feePct / 100);
        const netOfFee = baseAmount - feeAmount;
        const tokenPrice = row.mc / row.supply;
        const tokensOut = tokenPrice > 0 && usdPrice ? (netOfFee * usdPrice) / tokenPrice : 0;

        hops.push({
          venue: graduated ? 'DEX' : 'CURVE',
          inSymbol: side === 'buy' ? row.baseSymbol : sym,
          outSymbol: side === 'buy' ? sym : row.baseSymbol,
          inAmount: baseAmount,
          outAmount: tokensOut,
          impactPct: 0,
          feeBps: Math.round(feePct * 100),
          feeAmount,
        });

        const label = hops.map((h) => h.venue).join(' → ');
        const quote: Quote & { indicative: true; nativeUsd: number | null } = {
          sym,
          net,
          side,
          nativeUnit: native,
          amountIn: amount,
          amountOut: tokensOut,
          // Slippage from the caller's settings is applied at prepare time.
          minOut: tokensOut,
          hops,
          routeLabel: label,
          effFeePct: feePct,
          impactPct: 0,
          expiresAt: now + deps.env.quoteCacheTtlSeconds * 1000,
          indicative: true,
          nativeUsd: usdPrice,
        };
        return quote;
      },
    );

    // The bar drains against the cache entry's expiry, not the request time, so
    // a cache hit is honest about how stale it is.
    c.header('Cache-Control', `public, max-age=${deps.env.quoteCacheTtlSeconds}`);
    return c.json({ ...cached.value, expiresAt: cached.expiresAt });
  });

  return app;
}
