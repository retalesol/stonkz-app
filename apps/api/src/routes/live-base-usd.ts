import { sql, type SQL } from 'drizzle-orm';
import { isEvm, isStockBase, type Net } from '@stonkz/shared';
import type { AppDeps } from '../app/context.js';
import { tokens } from '../db/schema.js';
import { basePriceFor } from '../router/base-price.js';
import { snapshotBaseUsd } from './curve-facts.js';
import { stockPricerFor } from './launch-evm.js';

/**
 * The live USD price of a coin's base asset — the one multiplier that turns
 * every stored base figure (`mcBase`, `priceBase`, base candles, base volume)
 * into the USD the terminal shows. Pump.fun semantics: a coin's dollar cap
 * follows SOL/ETH tick for tick, while its curve progress, lane and
 * graduation stay in base units because that is what the chain settles.
 *
 * Sources, per base:
 * - SOL / ETH (and their wrapped forms): `PriceOracle` (Coinbase spot behind
 *   `CachedPriceOracle`, so a board of 100 coins is one Redis read);
 * - USDC-like stables: $1 by definition;
 * - EVM stock-token bases: the live stock pricer (`router/stock-price.ts`);
 * - the RH testnet majors: the static table `PushPriceSource` was seeded with.
 *
 * When a source is down or a symbol is unknown the row's launch snapshot
 * (`basePriceUsd1e6`) is used instead, so a USD figure is always produced —
 * stale rather than blank — and rows without any price (fixtures) resolve to
 * `0`, which `serialiseToken` reads as "the `mc` column already is USD".
 *
 * One instance per request: prices are memoised per `(net, symbol)` so a
 * list, its lane counts and its sort expression all see the same mark.
 */
export class LiveBaseUsd {
  private readonly memo = new Map<string, Promise<number>>();

  constructor(private readonly deps: AppDeps) {}

  /** USD per whole base unit right now from a live source only; `0` when none answers. */
  live(net: Net, baseSymbol: string): Promise<number> {
    const key = `${net}:${baseSymbol.toUpperCase()}`;
    let pending = this.memo.get(key);
    if (!pending) {
      pending = this.resolve(net, baseSymbol).catch(() => 0);
      this.memo.set(key, pending);
    }
    return pending;
  }

  /** USD per whole base unit right now; the snapshot when no live source answers; `0` when neither exists. */
  async price(net: Net, baseSymbol: string, snapshot1e6 = '0'): Promise<number> {
    const live = await this.live(net, baseSymbol);
    return live > 0 ? live : snapshotBaseUsd({ basePriceUsd1e6: snapshot1e6 });
  }

  /** The live mark for one `tokens` row, `0` when none — what `serialiseToken` takes (it falls back to the snapshot itself). */
  liveForRow(row: { net: string; baseSymbol: string }): Promise<number> {
    return this.live(row.net as Net, row.baseSymbol);
  }

  /** The multiplier for one `tokens` row, snapshot fallback included. */
  forRow(row: { net: string; baseSymbol: string; basePriceUsd1e6: string }): Promise<number> {
    return this.price(row.net as Net, row.baseSymbol, row.basePriceUsd1e6);
  }

  private async resolve(net: Net, baseSymbol: string): Promise<number> {
    const sym = baseSymbol.toUpperCase();
    const stock = isEvm(net) && isStockBase(net, sym) ? stockPricerFor(this.deps, net) : null;
    const info = await basePriceFor(net, sym, this.deps.oracle, { stock });
    if (!info) return 0;
    const usd = Number(info.price1e6) / 1e6;
    return Number.isFinite(usd) && usd > 0 ? usd : 0;
  }
}

/**
 * A SQL expression for a `tokens` row's live USD cap, so MARKET CAP can be
 * sorted and paged in the database with mixed nets and bases on one board:
 * `mc_base × <live price for that row's (net, base)>`, falling back to the
 * snapshot `mc` for rows without a base figure. `pairs` is every
 * `(net, baseSymbol)` the scope can contain; a pair with no live price and no
 * usable snapshot orders by `mc` too.
 */
export async function liveMcSql(
  prices: LiveBaseUsd,
  pairs: Iterable<{ net: string; baseSymbol: string }>,
): Promise<SQL> {
  const arms: SQL[] = [];
  const seen = new Set<string>();
  for (const p of pairs) {
    const key = `${p.net}:${p.baseSymbol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const usd = await prices.price(p.net as Net, p.baseSymbol);
    if (!(usd > 0)) continue;
    arms.push(
      sql`when ${tokens.net} = ${p.net} and ${tokens.baseSymbol} = ${p.baseSymbol} then ${tokens.mcBase} * ${usd}`,
    );
  }
  if (arms.length === 0) return sql`${tokens.mc}`;
  return sql`coalesce(case ${sql.join(arms, sql` `)} else null end, ${tokens.mc})`;
}
