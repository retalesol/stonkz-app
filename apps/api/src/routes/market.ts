import { Hono } from 'hono';
import { and, desc, eq, getTableColumns, sql, type SQL } from 'drizzle-orm';
import { MAJORS, isEvm, nativeUnit, parseNet, stockBasesFor, type Net } from '@stonkz/shared';
import { koth, tape, tokens, treasuries } from '../db/schema.js';
import { limit } from '../app/middleware.js';
import { basePriceFor, staticPricePolicy } from '../router/base-price.js';
import { evmRouterAddress } from '../chain/evm-net.js';
import { asEthCallSource, readRouterViaV3Support } from '../router/evm-pyth.js';
import { fillId } from '../chain/trade-fills.js';
import { RATE_LIMITS } from '../redis/ratelimit.js';
import { kothOverrides } from '../admin/index.js';
import type { AppEnv } from '../app/context.js';
import { serialiseToken, usdFromBase, type TokenRow } from './serialise.js';
import { snapshotBaseUsd } from './curve-facts.js';
import { LiveBaseUsd } from './live-base-usd.js';
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

    // Admin KOTH pin (`token_moderation.koth_override`) replaces that net's crown.
    for (const [oNet, mint] of await kothOverrides(deps.db, net)) {
      const pinned = await resolveTokenRow(deps.db, oNet, { mint });
      if (!pinned) continue;
      const idx = rows.findIndex((r) => r.net === oNet);
      const crownedAt = rows[idx]?.crownedAt ?? new Date(deps.now());
      const crown = {
        net: oNet,
        sym: pinned.sym,
        mc: pinned.mc,
        mcBase: pinned.mcBase ?? null,
        crownedAt,
      };
      if (idx >= 0) rows[idx] = crown;
      else rows.push(crown);
    }

    const now = deps.now();
    const prices = new LiveBaseUsd(deps);
    const curveParams = await deps.params.all();
    const kings = await Promise.all(
      rows.map(async (row) => {
        const token = await resolveTokenRow(deps.db, row.net, { sym: row.sym });
        // The crown's cap follows the live base price like the card does; the
        // `koth` row itself is the indexer's snapshot at crowning.
        const view = token
          ? serialiseToken(
              token as TokenRow,
              now,
              { baseUsd: await prices.liveForRow(token as TokenRow) },
              curveParams[row.net as Net],
            )
          : null;
        return {
          net: row.net as Net,
          sym: row.sym,
          mc: view ? view.mc : row.mc,
          mcBase: view ? view.mcBase : (row.mcBase ?? 0),
          baseUsd: view ? view.baseUsd : 0,
          crownedAt: row.crownedAt.getTime(),
          // 5s `crowned` glow in the UI keys off this.
          freshMs: now - row.crownedAt.getTime(),
          token: view,
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
    const parsed = Number.parseInt(c.req.query('limit') ?? '', 10);
    const max = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 40;

    // Spelled out in full: drizzle renders `${tape.net}` as a bare `"net"` in
    // a single-table select, which a correlated subquery resolves to *its*
    // own row — the fixture filter below was a tautology until it was
    // qualified, and the mint lookup would have returned the newest coin on
    // any chain.
    const TAPE_NET = sql.raw('"tape"."net"');
    const TAPE_SYM = sql.raw('"tape"."sym"');
    const filters = [
      net ? eq(tape.net, net) : undefined,
      // Drop fills for fixture / legacy tokens that may linger from old replays.
      sql`exists (
        select 1 from ${tokens} t
        where t.net = ${TAPE_NET}
          and t.sym = ${TAPE_SYM}
          and t.mint <> ''
          and t.mint not like 'legacy:%'
      )`,
    ].filter(Boolean);

    // The fill's position among its transaction's fills — the same ordinal
    // the indexer and `/trade/confirm` put in `fid`, so a seeded print and
    // the WS print of one fill carry one id and the strip shows it once.
    // Window functions run before LIMIT, so the ordinal is right even when
    // only one of a multi-fill transaction's rows makes the page.
    const ordinal = sql<number>`(row_number() over (
      partition by ${tape.net}, ${tape.txSig} order by ${tape.logIndex}
    ) - 1)::int`;
    // The newest coin with this ticker on this net, so the board can key the
    // print to a card even when a ticker was reused — and its base, so the
    // print's cap can be marked at today's base price.
    const newest = (col: string): SQL<string | null> => sql<string | null>`(
      select t.${sql.raw(col)} from ${tokens} t
      where t.net = ${TAPE_NET} and t.sym = ${TAPE_SYM}
      order by t.launched_at desc limit 1
    )`;
    const mint = newest('mint');
    const baseSymbol = newest('base_symbol');
    const basePrice1e6 = newest('base_price_usd_1e6');

    const rows = await deps.db
      .select({ ...getTableColumns(tape), ordinal, mint, baseSymbol, basePrice1e6 })
      .from(tape)
      .where(and(...filters))
      .orderBy(desc(tape.id))
      .limit(max);

    const prices = new LiveBaseUsd(deps);
    return c.json({
      net: net ?? 'ALL',
      fills: await Promise.all(
        rows.map(async (r) => {
          const snapshot = snapshotBaseUsd({ basePriceUsd1e6: r.basePrice1e6 ?? '0' });
          const mcBase =
            r.mcBase !== null && r.mcBase > 0
              ? r.mcBase
              : snapshot > 0 && r.mc > 0
                ? r.mc / snapshot
                : 0;
          const baseUsd = r.baseSymbol
            ? await prices.price(r.net as Net, r.baseSymbol, r.basePrice1e6 ?? '0')
            : 0;
          return {
            t: r.blockTime.getTime(),
            sym: r.sym,
            net: r.net,
            ...(r.mint ? { mint: r.mint } : {}),
            buy: r.side === 'buy',
            sol: r.nativeAmount,
            tok: r.tokenAmount,
            mc: usdFromBase(mcBase, baseUsd, r.mc),
            ...(mcBase > 0 ? { mcBase, baseUsd } : {}),
            w: r.trader,
            v: r.usdValue,
            cb: r.cashback,
            sig: r.txSig,
            fid: fillId(r.txSig, r.ordinal),
          };
        }),
      ),
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
      const price = await basePriceFor(net, symbol, deps.oracle, {
        staticPrices: staticPricePolicy(deps.env),
      }).catch(() => null);
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
