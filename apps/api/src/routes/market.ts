import { Hono } from 'hono';
import { and, desc, eq, sql } from 'drizzle-orm';
import { MAJORS, isEvm, nativeUnit, parseNet, stockBasesFor, type Net } from '@stonkz/shared';
import { koth, tape, tokens, treasuries } from '../db/schema.js';
import { limit } from '../app/middleware.js';
import { basePriceFor } from '../router/base-price.js';
import { evmRouterAddress } from '../chain/evm-net.js';
import { asEthCallSource, readRouterViaV3Support } from '../router/evm-pyth.js';
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
   * Plan step 60 — majors per net, plus tokenized stocks (`STOCK_BASES`,
   * config-driven per net: Solana `STOCKS`, Robinhood `RH_STOCKS`, Base
   * `BASE_STOCKS`).
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
    // An EVM stock base trades 24/7 on its V3 pool and is priced on-chain
    // from it (`StockPriceSource`), so a pinned address is all it needs —
    // never whether US equity markets happen to be open right now.
    const stockAvailable = async (symbol: string): Promise<boolean> =>
      isEvm(net) ? deps.baseMints.mintFor(net, symbol) !== null : available(symbol);
    const majors = await Promise.all(
      MAJORS[net].map(async ([symbol, name]) => ({
        symbol,
        name,
        kind: 'major' as const,
        available: await available(symbol),
      })),
    );
    // Whether a stock-base dev buy rides in the launch transaction
    // (`StonkzRouter.createAndBuyViaV3`), so the stepper can stop warning
    // about a second wallet prompt. One cached probe per router.
    const stockList = stockBasesFor(net);
    let atomicStockDevBuy = false;
    if (isEvm(net) && stockList.length > 0) {
      const caller = asEthCallSource(deps.rpcs[net]);
      atomicStockDevBuy = caller
        ? await readRouterViaV3Support(
            caller,
            evmRouterAddress(deps.env, net),
            deps.now(),
            deps.logger,
          ).catch(() => false)
        : false;
    }
    // Each net advertises only its own list (Base: `BASE_STOCKS`, empty
    // until it lists stocks) — never another net's symbols, which
    // /launch/prepare would refuse with base_mint_not_allowed.
    const stocks = await Promise.all(
      stockList.map(async ([symbol, name]) => ({
        symbol,
        name,
        kind: 'stock' as const,
        available: await stockAvailable(symbol),
        ...(isEvm(net)
          ? {
              tradesAllHours: true,
              priceSource: 'dex' as const,
              atomicDevBuy: atomicStockDevBuy,
            }
          : {}),
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
