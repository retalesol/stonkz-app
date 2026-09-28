import { Hono } from 'hono';
import { and, desc, eq, sql } from 'drizzle-orm';
import { MAJORS, STOCKS, RH_STOCKS, nativeUnit, parseNet, type Net } from '@stonkz/shared';
import { koth, tape, tokens, treasuries } from '../db/schema.js';
import { limit } from '../app/middleware.js';
import { basePriceFor } from '../router/base-price.js';
import { RATE_LIMITS } from '../redis/ratelimit.js';
import type { AppEnv } from '../app/context.js';
import { serialiseToken, type TokenRow } from './serialise.js';
import { resolveTokenRow } from './token-resolve.js';

/** `GET /koth`, `GET /tape`, `GET /base-tokens`, `GET /treasuries`. */
export function marketRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('/koth', limit(RATE_LIMITS.read));
  app.use('/tape', limit(RATE_LIMITS.read));

  /** One king per net; `net=ALL` returns both crowns. */
  app.get('/koth', async (c) => {
    const deps = c.get('deps');
    const netParam = c.req.query('net');
    const net = netParam === 'ALL' ? null : (parseNet(netParam) ?? c.get('user')?.net ?? 'SOL');

    const rows = await deps.db
      .select()
      .from(koth)
      .where(net ? eq(koth.net, net) : undefined);

    const now = deps.now();
    const kings = await Promise.all(
      rows.map(async (row) => {
        const token = await resolveTokenRow(deps.db, row.net, { sym: row.sym });
        return {
          net: row.net as Net,
          sym: row.sym,
          mc: row.mc,
          crownedAt: row.crownedAt.getTime(),
          // 5s `crowned` glow in the UI keys off this.
          freshMs: now - row.crownedAt.getTime(),
          token: token ? serialiseToken(token as TokenRow, now) : null,
        };
      }),
    );

    return c.json({ net: net ?? 'ALL', kings });
  });

  /** The global fill feed behind the ticker tape. */
  app.get('/tape', async (c) => {
    const deps = c.get('deps');
    const netParam = c.req.query('net');
    const net = netParam === 'ALL' ? null : (parseNet(netParam) ?? c.get('user')?.net ?? 'SOL');
    const max = Math.min(Number.parseInt(c.req.query('limit') ?? '40', 10) || 40, 200);

    const filters = [
      net ? eq(tape.net, net) : undefined,
      // Drop fills for fixture / legacy tokens that may linger from old replays.
      sql`exists (
        select 1 from ${tokens} t
        where t.net = ${tape.net}
          and t.sym = ${tape.sym}
          and t.mint <> ''
          and t.mint not like 'legacy:%'
      )`,
    ].filter(Boolean);

    const rows = await deps.db
      .select()
      .from(tape)
      .where(and(...filters))
      .orderBy(desc(tape.id))
      .limit(max);

    return c.json({
      net: net ?? 'ALL',
      fills: rows.map((r) => ({
        t: r.blockTime.getTime(),
        sym: r.sym,
        net: r.net,
        buy: r.side === 'buy',
        sol: r.nativeAmount,
        tok: r.tokenAmount,
        mc: r.mc,
        w: r.trader,
        v: r.usdValue,
        cb: r.cashback,
        sig: r.txSig,
      })),
    });
  });

  /**
   * Plan step 60 — majors per net, plus tokenized stocks.
   * Solana uses `STOCKS` (xStock tickers); Robinhood uses `RH_STOCKS`.
   */
  app.get('/base-tokens', async (c) => {
    const deps = c.get('deps');
    const net = parseNet(c.req.query('network')) ?? parseNet(c.req.query('net')) ?? 'SOL';
    // `available` is what /launch/prepare will accept: a pinned mint on this
    // env and a price source. The stepper greys out the rest up front instead
    // of letting a tester fill three steps and fail on the fourth.
    const available = async (symbol: string): Promise<boolean> => {
      if (!deps.baseMints.mintFor(net, symbol)) return false;
      const price = await basePriceFor(net, symbol, deps.oracle).catch(() => null);
      return price !== null;
    };
    const majors = await Promise.all(
      MAJORS[net].map(async ([symbol, name]) => ({
        symbol,
        name,
        kind: 'major' as const,
        available: await available(symbol),
      })),
    );
    // Base has no stock bases (see MAJORS.BASE): advertising RH_STOCKS there
    // would offer symbols /launch/prepare then refuses with base_mint_not_allowed.
    const stockList = net === 'SOL' ? STOCKS : net === 'RH' ? RH_STOCKS : [];
    const stocks = await Promise.all(
      stockList.map(async ([symbol, name]) => ({
        symbol,
        name,
        kind: 'stock' as const,
        available: await available(symbol),
      })),
    );

    return c.json({
      net,
      nativeUnit: nativeUnit(net),
      source: 'snapshot:2026-09-06',
      stale: true,
      baseTokens: [...majors, ...stocks],
    });
  });

  /**
   * Plan step 139 — running protocol (15%), `$STONKZ` buyback (10%) and RWA
   * crate fund (6%) balances.
   * Read-only and deliberately unauthenticated-safe: there is no claim path,
   * and the withdrawal keys are not in this process.
   */
  app.get('/treasuries', async (c) => {
    const deps = c.get('deps');
    const rows = await deps.db.select().from(treasuries);
    return c.json({
      claimable: false,
      note: 'Ops-visible only. Protocol 15%, the $STONKZ buyback 10% (half to crates, half burned) and the RWA crate fund 6% are never user-claimable and never enter memecoin staking.',
      vaults: rows.map((r) => ({
        net: r.net as Net,
        kind: r.kind,
        nativeUnit: nativeUnit(r.net as Net),
        nativeBalance: r.nativeBalance,
        lifetimeCredited: r.lifetimeCredited,
        updatedAt: r.updatedAt.getTime(),
      })),
    });
  });

  return app;
}
