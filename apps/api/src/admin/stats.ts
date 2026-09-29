import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { ALL_NETS, type Net } from '@stonkz/shared';
import type { Db } from '../db/client.js';
import { tokens, trades, treasuryCredits } from '../db/schema.js';

/**
 * Dashboard aggregates. Everything here is a read over the indexer's tables;
 * "fees" is what the indexer credited to the three treasury vaults (the
 * protocol's own take, in native units), not the creator's 69 %.
 */
export interface WindowStats {
  launches: number;
  trades: number;
  volumeUsd: number;
  feesNative: number;
}

export interface DashboardStats {
  today: Record<Net, WindowStats>;
  week: Record<Net, WindowStats>;
  topTokens: { net: Net; sym: string; mint: string | null; volumeUsd: number; trades: number }[];
}

async function windowFor(db: Db, sinceMs: number): Promise<Record<Net, WindowStats>> {
  const since = new Date(sinceMs);
  const [launchRows, tradeRows, feeRows] = await Promise.all([
    db
      .select({ net: tokens.net, n: sql<number>`count(*)::int` })
      .from(tokens)
      .where(gte(tokens.launchedAt, since))
      .groupBy(tokens.net),
    db
      .select({
        net: trades.net,
        n: sql<number>`count(*)::int`,
        usd: sql<number>`coalesce(sum(${trades.usdValue}), 0)::float8`,
      })
      .from(trades)
      .where(gte(trades.blockTime, since))
      .groupBy(trades.net),
    db
      .select({
        net: treasuryCredits.net,
        amount: sql<number>`coalesce(sum(${treasuryCredits.amount}), 0)::float8`,
      })
      .from(treasuryCredits)
      .where(gte(treasuryCredits.blockTime, since))
      .groupBy(treasuryCredits.net),
  ]);
  const out = {} as Record<Net, WindowStats>;
  for (const net of ALL_NETS) {
    out[net] = {
      launches: launchRows.find((r) => r.net === net)?.n ?? 0,
      trades: tradeRows.find((r) => r.net === net)?.n ?? 0,
      volumeUsd: Number(tradeRows.find((r) => r.net === net)?.usd ?? 0),
      feesNative: Number(feeRows.find((r) => r.net === net)?.amount ?? 0),
    };
  }
  return out;
}

export async function dashboardStats(db: Db, nowMs: number): Promise<DashboardStats> {
  const dayStart = new Date(nowMs);
  dayStart.setUTCHours(0, 0, 0, 0);
  const [today, week, top] = await Promise.all([
    windowFor(db, dayStart.getTime()),
    windowFor(db, nowMs - 7 * 86_400_000),
    db
      .select({
        net: trades.net,
        sym: trades.sym,
        mint: trades.mint,
        usd: sql<number>`coalesce(sum(${trades.usdValue}), 0)::float8`,
        n: sql<number>`count(*)::int`,
      })
      .from(trades)
      .where(gte(trades.blockTime, new Date(nowMs - 86_400_000)))
      .groupBy(trades.net, trades.sym, trades.mint)
      .orderBy(desc(sql`sum(${trades.usdValue})`))
      .limit(10),
  ]);
  return {
    today,
    week,
    topTokens: top.map((r) => ({
      net: r.net as Net,
      sym: r.sym,
      mint: r.mint,
      volumeUsd: Number(r.usd),
      trades: r.n,
    })),
  };
}

/** Per-token fee/treasury/staker snapshot for the Tokens view. */
export async function tokenEconomics(
  db: Db,
  net: Net,
  mint: string,
): Promise<{
  trades24h: number;
  volume24hUsd: number;
}> {
  const since = new Date(Date.now() - 86_400_000);
  const [row] = await db
    .select({
      n: sql<number>`count(*)::int`,
      usd: sql<number>`coalesce(sum(${trades.usdValue}), 0)::float8`,
    })
    .from(trades)
    .where(and(eq(trades.net, net), eq(trades.mint, mint), gte(trades.blockTime, since)));
  return { trades24h: row?.n ?? 0, volume24hUsd: Number(row?.usd ?? 0) };
}
