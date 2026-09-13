import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { nativeUnit, type Net } from '@stonkz/shared';
import { tokens } from '../db/schema.js';
import { limit } from '../app/middleware.js';
import { RATE_LIMITS } from '../redis/ratelimit.js';
import type { AppEnv } from '../app/context.js';
import { SolanaRpc } from '../chain/solana.js';
import { aggregatorFor, composeQuote } from '../router/compose.js';
import { RouterError } from '../router/errors.js';
import {
  reserveFingerprint,
  syncCurveReserves,
  type EthCaller,
  type SolanaAccountSource,
} from '../router/curve-sync.js';
import type { TokenRow } from './serialise.js';

function asEthCaller(rpc: unknown): EthCaller | undefined {
  const candidate = rpc as Partial<EthCaller>;
  return typeof candidate.ethCall === 'function' ? (candidate as EthCaller) : undefined;
}

function asSolanaAccountSource(rpc: unknown): SolanaAccountSource | undefined {
  if (rpc instanceof SolanaRpc) return rpc;
  const candidate = rpc as Partial<SolanaAccountSource>;
  return typeof candidate.getAccountDataBase64 === 'function' ? (candidate as SolanaAccountSource) : undefined;
}

function parseNet(raw: string | undefined): Net | null {
  return raw === 'SOL' || raw === 'RH' ? raw : null;
}

/**
 * `GET /tokens/:sym/quote?side=&amount=` — plan step 82.
 *
 * Syncs curve reserves from chain before compose so sells work after buys
 * even when the indexer is lagging or still on fixtures. Cache key includes
 * the reserve fingerprint so a post-buy sync cannot serve a stale quote.
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

    const synced = await syncCurveReserves({
      db: deps.db,
      row: row as TokenRow,
      rh: { eth: asEthCaller(deps.rpcs.RH), launchpad: deps.env.rhLaunchpadAddress },
      sol: { rpc: asSolanaAccountSource(deps.rpcs.SOL), programId: deps.env.solanaLaunchpadProgramId },
    });

    try {
      const cached = await deps.quotes.wrap(
        {
          net,
          side,
          nativeAmount: amount,
          baseMint: synced.baseMint,
          sym,
          reserves: reserveFingerprint(synced),
        },
        async () => {
          const now = deps.now();
          const native = nativeUnit(net);
          const usdPrice = await deps.oracle.nativeUsd(native).catch(() => null);
          const aggregatorVenue = aggregatorFor(net, synced.baseSymbol);
          const aggregator = aggregatorVenue === 'JUPITER' ? deps.jupiter : aggregatorVenue === 'UNISWAP' ? deps.uniswap : null;

          return composeQuote({
            net,
            side,
            amount,
            row: synced,
            usdPrice,
            now,
            aggregator,
          });
        },
      );

      c.header('Cache-Control', `public, max-age=${deps.env.quoteCacheTtlSeconds}`);
      return c.json({ ...cached.value, expiresAt: cached.expiresAt });
    } catch (err) {
      if (err instanceof RouterError) return c.json(err.toResponse(), err.httpStatus);
      throw err;
    }
  });

  return app;
}
