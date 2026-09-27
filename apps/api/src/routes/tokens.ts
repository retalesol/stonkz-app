import { Hono } from 'hono';
import { and, desc, eq, gt, ilike, or, sql, type SQL } from 'drizzle-orm';
import {
  FEE_SPLIT,
  effFee,
  isEvm,
  laneOf,
  nativeUnit,
  parseNet,
  type Lane,
  type TokenFees,
} from '@stonkz/shared';
import { evmExplorerUrl, evmLaunchpadAddress } from '../chain/evm-net.js';
import { fetchEvmHoldersFromExplorer, fetchSolHoldersFromRpc } from '../chain/token-holders.js';
import {
  candles,
  creatorVaults,
  holdersSnapshot,
  referralFeeEvents,
  tokens,
  trades,
  treasuryCredits,
} from '../db/schema.js';
import { limit } from '../app/middleware.js';
import { RATE_LIMITS } from '../redis/ratelimit.js';
import type { AppEnv } from '../app/context.js';
import { serialiseToken, type TokenRow } from './serialise.js';
import { resolveTokenRow } from './token-resolve.js';

const TIMEFRAMES = new Set(['1m', '5m', '15m', '1h', '4h', '1d']);
/** `index.html:1451` — NEWEST, MARKET CAP, GAINERS, MOST REPLIES. */
const SORTS = new Set(['new', 'mc', 'chg', 'rep']);

function parseLane(raw: string | undefined): Lane | null {
  return raw === 'new' || raw === 'soon' || raw === 'grad' ? raw : null;
}

function clampLimit(raw: string | undefined, fallback: number, max: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

/**
 * Phase 1.C read path (plan step 57).
 *
 * The board defaults to the connected net — `WALLET.net` in the UI — and
 * `net=ALL` opts into the cross-chain view. Everything here is a plain read of
 * what the indexer materialised; no simulation, no `tick()`.
 */
export function tokenRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('/tokens/*', limit(RATE_LIMITS.read));

  app.get('/tokens', async (c) => {
    const deps = c.get('deps');
    const netParam = c.req.query('net');
    const net = netParam === 'ALL' ? null : (parseNet(netParam) ?? c.get('user')?.net ?? 'SOL');
    const lane = parseLane(c.req.query('lane'));
    const q = (c.req.query('q') ?? '').trim();
    const sort = SORTS.has(c.req.query('sort') ?? '') ? (c.req.query('sort') as string) : 'new';
    const max = clampLimit(c.req.query('limit'), 100, 500);

    const filters: SQL[] = [];
    if (net) filters.push(eq(tokens.net, net));
    if (lane) filters.push(eq(tokens.lane, lane));
    // Hide fixture placeholders (empty mint / legacy: synthetic ids) from the
    // live board. Chain-mode ingest always has a real mint address.
    filters.push(sql`${tokens.mint} <> ''`);
    filters.push(sql`${tokens.mint} not like 'legacy:%'`);
    if (q) {
      const like = `${q}%`;
      const contains = `%${q}%`;
      // The placeholder promises ticker, name or contract: a pasted mint
      // matches exactly (case-sensitive base58 / checksummed hex).
      const clause = or(ilike(tokens.sym, like), ilike(tokens.name, contains), eq(tokens.mint, q));
      if (clause) filters.push(clause);
    }

    const order =
      sort === 'mc'
        ? desc(tokens.mc)
        : sort === 'chg'
          ? desc(tokens.chg)
          : sort === 'rep'
            ? desc(tokens.replies)
            : desc(tokens.launchedAt);

    const rows = await deps.db
      .select()
      .from(tokens)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(order)
      .limit(max);

    const counts = await deps.db
      .select({ lane: tokens.lane, n: sql<number>`count(*)::int` })
      .from(tokens)
      .where(net ? eq(tokens.net, net) : undefined)
      .groupBy(tokens.lane);

    const now = deps.now();
    return c.json({
      net: net ?? 'ALL',
      sort,
      count: rows.length,
      lanes: {
        new: counts.find((r) => r.lane === 'new')?.n ?? 0,
        soon: counts.find((r) => r.lane === 'soon')?.n ?? 0,
        grad: counts.find((r) => r.lane === 'grad')?.n ?? 0,
      },
      tokens: rows.map((r) => serialiseToken(r as TokenRow, now)),
    });
  });

  app.get('/tokens/:sym', async (c) => {
    const deps = c.get('deps');
    const sym = c.req.param('sym').toUpperCase();
    const net = parseNet(c.req.query('net')) ?? c.get('user')?.net ?? 'SOL';
    const mintQ = c.req.query('mint')?.trim() || undefined;

    const row = await resolveTokenRow(deps.db, net, { mint: mintQ, sym });
    if (!row) return c.json({ error: 'not_found' }, 404);

    return c.json(serialiseToken(row as TokenRow, deps.now()));
  });

  app.get('/tokens/:sym/candles', async (c) => {
    const deps = c.get('deps');
    const sym = c.req.param('sym').toUpperCase();
    const net = parseNet(c.req.query('net')) ?? c.get('user')?.net ?? 'SOL';
    const mintQ = c.req.query('mint')?.trim() || undefined;
    const tf = c.req.query('tf') ?? '1m';
    if (!TIMEFRAMES.has(tf)) return c.json({ error: 'bad_timeframe' }, 400);
    const max = clampLimit(c.req.query('limit'), 200, 1000);

    const token = await resolveTokenRow(deps.db, net, { mint: mintQ, sym });
    const mint = token?.mint;
    const rows = mint
      ? await deps.db
          .select()
          .from(candles)
          .where(and(eq(candles.net, net), eq(candles.mint, mint), eq(candles.tf, tf)))
          .orderBy(desc(candles.bucketStart))
          .limit(max)
      : await deps.db
          .select()
          .from(candles)
          .where(and(eq(candles.net, net), eq(candles.sym, sym), eq(candles.tf, tf)))
          .orderBy(desc(candles.bucketStart))
          .limit(max);

    return c.json({
      net,
      sym,
      tf,
      // Oldest first: `drawTChart` walks the series left to right.
      candles: rows.reverse().map((r) => ({
        t: r.bucketStart.getTime(),
        o: r.o,
        h: r.h,
        l: r.l,
        c: r.c,
        v: r.v,
        nativeVolume: r.nativeVolume,
        trades: r.trades,
      })),
    });
  });

  app.get('/tokens/:sym/trades', async (c) => {
    const deps = c.get('deps');
    const sym = c.req.param('sym').toUpperCase();
    const net = parseNet(c.req.query('net')) ?? c.get('user')?.net ?? 'SOL';
    const mintQ = c.req.query('mint')?.trim() || undefined;
    const max = clampLimit(c.req.query('limit'), 50, 200);

    const token = await resolveTokenRow(deps.db, net, { mint: mintQ, sym });
    const mint = token?.mint;
    const rows = mint
      ? await deps.db
          .select()
          .from(trades)
          .where(and(eq(trades.net, net), eq(trades.mint, mint)))
          .orderBy(desc(trades.id))
          .limit(max)
      : await deps.db
          .select()
          .from(trades)
          .where(and(eq(trades.net, net), eq(trades.sym, sym)))
          .orderBy(desc(trades.id))
          .limit(max);

    return c.json({
      net,
      sym,
      ...(mint ? { mint } : {}),
      nativeUnit: nativeUnit(net),
      trades: rows.map((r) => ({
        t: r.blockTime.getTime(),
        sym: r.sym,
        mint: r.mint ?? undefined,
        net: r.net,
        buy: r.side === 'buy',
        sol: r.nativeAmount,
        tok: r.tokenAmount,
        base: r.baseAmount,
        mc: r.mc,
        w: r.trader,
        v: r.usdValue,
        cb: r.cashback,
        sig: r.txSig,
      })),
    });
  });

  /**
   * `GET /tokens/:sym/fees?net=` — the lifetime fee ledger behind the Fees tab.
   * Treasury legs come from `treasury_credits` (one row per vault per fill,
   * written by the indexer from `FeeAccrued`); the creator bucket and the
   * staker peel from `creator_vaults`. Native units throughout.
   */
  app.get('/tokens/:sym/fees', async (c) => {
    const deps = c.get('deps');
    const sym = c.req.param('sym').toUpperCase();
    const net = parseNet(c.req.query('net')) ?? c.get('user')?.net ?? 'SOL';
    const mintQ = c.req.query('mint')?.trim() || undefined;
    const token = await resolveTokenRow(deps.db, net, { mint: mintQ, sym });
    if (!token) return c.json({ error: 'not_found' }, 404);

    const legs = await deps.db
      .select({
        kind: treasuryCredits.kind,
        total: sql<number>`coalesce(sum(${treasuryCredits.amount}), 0)`,
      })
      .from(treasuryCredits)
      .where(and(eq(treasuryCredits.net, net), eq(treasuryCredits.sym, token.sym)))
      .groupBy(treasuryCredits.kind);
    const leg = (kind: string): number => Number(legs.find((l) => l.kind === kind)?.total ?? 0);

    const [vault] = await deps.db
      .select()
      .from(creatorVaults)
      .where(and(eq(creatorVaults.net, net), eq(creatorVaults.mint, token.mint ?? '')))
      .limit(1);
    const creatorBucket = vault?.lifetimeNative ?? 0;
    const stakers = vault?.stakerPoolNative ?? 0;
    const protocol = leg('protocol');
    const game = leg('stonkz_ops');
    const burn = leg('burn');
    // Referral payouts are settled off the protocol leg per fill; the ledger
    // is keyed by tx, so scope it to this coin through its trades.
    const [ref] = await deps.db
      .select({ total: sql<number>`coalesce(sum(${referralFeeEvents.payoutNative}), 0)` })
      .from(referralFeeEvents)
      .innerJoin(
        trades,
        and(eq(trades.net, referralFeeEvents.net), eq(trades.txSig, referralFeeEvents.txSig)),
      )
      .where(and(eq(trades.net, net), eq(trades.mint, token.mint ?? '')));
    const referrals = Number(ref?.total ?? 0);
    const feeBps = token.feeBps ?? 100;
    // What a fill pays right now: the creator fee plus the decaying cashback
    // premium while that window is open (the same curve the ticket shows).
    const effFeeBps = Math.round(
      effFee(
        { tfee: feeBps / 100, cashback: token.cashback, cbStart: token.cbStartMs ?? undefined },
        deps.now(),
      ) * 100,
    );
    const body: TokenFees = {
      sym: token.sym,
      net,
      unit: nativeUnit(net),
      feeBps,
      effFeeBps,
      split: { ...FEE_SPLIT },
      totals: {
        gross: protocol + game + burn + creatorBucket,
        protocol,
        game,
        burn,
        creatorBucket,
        creator: Math.max(0, creatorBucket - stakers),
        stakers,
        referrals,
      },
      source: 'chain',
    };
    return c.json(body);
  });

  app.get('/tokens/:sym/holders', async (c) => {
    const deps = c.get('deps');
    const sym = c.req.param('sym').toUpperCase();
    const net = parseNet(c.req.query('net')) ?? c.get('user')?.net ?? 'SOL';
    const mintQ = c.req.query('mint')?.trim() || undefined;
    const max = clampLimit(c.req.query('limit'), 50, 200);

    const token = await resolveTokenRow(deps.db, net, { mint: mintQ, sym });
    if (!token) return c.json({ error: 'not_found' }, 404);

    const supply = token.supply > 0 ? token.supply : 0;
    const mint = (token.mint ?? '').trim();

    type HolderOut = {
      wallet: string;
      amount: number;
      pct: number;
      costNative: number;
      curve?: boolean;
    };

    const fromDb = async (): Promise<{
      holders: HolderOut[];
      source: 'db';
      holderCount: number;
    }> => {
      const rows = await deps.db
        .select()
        .from(holdersSnapshot)
        .where(
          and(
            eq(holdersSnapshot.net, net),
            eq(holdersSnapshot.mint, mint),
            gt(holdersSnapshot.tokenAmount, 0),
          ),
        )
        .orderBy(desc(holdersSnapshot.tokenAmount))
        .limit(max);
      const launchpad = deps.env.rhLaunchpadAddress.toLowerCase();
      const holders: HolderOut[] = rows.map((r) => ({
        wallet: r.wallet,
        amount: r.tokenAmount,
        pct: supply > 0 ? (r.tokenAmount / supply) * 100 : 0,
        costNative: r.costNative,
        ...(isEvm(net) && r.wallet.toLowerCase() === launchpad ? { curve: true } : {}),
      }));
      const holderCount = holders.filter((h) => !h.curve).length;
      return { holders, source: 'db', holderCount };
    };

    const cacheChainHolders = async (
      chainHolders: { wallet: string; amount: number; curve: boolean }[],
    ): Promise<void> => {
      // Best-effort: keep the snapshot warm so an RPC/explorer outage still
      // serves the last known on-chain picture.
      try {
        for (const h of chainHolders) {
          await deps.db
            .insert(holdersSnapshot)
            .values({
              net,
              sym,
              mint,
              wallet: h.wallet,
              tokenAmount: h.amount,
              costNative: 0,
            })
            .onConflictDoUpdate({
              target: [holdersSnapshot.net, holdersSnapshot.mint, holdersSnapshot.wallet],
              set: { tokenAmount: h.amount },
            });
        }
        const holderCount = chainHolders.filter((h) => !h.curve).length;
        await deps.db
          .update(tokens)
          .set({ holders: holderCount, updatedAt: new Date(deps.now()) })
          .where(and(eq(tokens.net, net), eq(tokens.mint, mint)));
      } catch (err) {
        deps.logger.warn('holders snapshot cache failed', { net, sym, mint, err: String(err) });
      }
    };

    if (mint) {
      try {
        if (isEvm(net)) {
          const live = await fetchEvmHoldersFromExplorer({
            mint,
            launchpad: evmLaunchpadAddress(deps.env, net),
            decimals: token.tokenDecimals || 18,
            limit: max,
            explorerUrl: evmExplorerUrl(deps.env, net),
          });
          const holders: HolderOut[] = live.holders.map((h) => ({
            wallet: h.wallet,
            amount: h.amount,
            pct: supply > 0 ? (h.amount / supply) * 100 : 0,
            costNative: 0,
            ...(h.curve ? { curve: true } : {}),
          }));
          void cacheChainHolders(live.holders);
          return c.json({
            net,
            sym,
            source: live.source,
            curveWallet: deps.env.rhLaunchpadAddress,
            holderCount: holders.filter((h) => !h.curve).length,
            holders,
          });
        }

        if (net === 'SOL') {
          const live = await fetchSolHoldersFromRpc({
            mint,
            decimals: token.tokenDecimals || 6,
            limit: Math.min(max, 20),
            rpcUrl: deps.env.solanaRpcUrl,
          });
          const holders: HolderOut[] = live.holders.map((h) => ({
            wallet: h.wallet,
            amount: h.amount,
            pct: supply > 0 ? (h.amount / supply) * 100 : 0,
            costNative: 0,
            ...(h.curve ? { curve: true } : {}),
          }));
          void cacheChainHolders(live.holders);
          return c.json({
            net,
            sym,
            source: live.source,
            holderCount: holders.filter((h) => !h.curve).length,
            holders,
          });
        }
      } catch (err) {
        deps.logger.warn('on-chain holders failed; falling back to db', {
          net,
          sym,
          mint,
          err: String(err),
        });
      }
    }

    const fallback = await fromDb();
    return c.json({
      net,
      sym,
      ...(isEvm(net)
        ? {
            curveWallet: evmLaunchpadAddress(deps.env, net),
          }
        : {}),
      ...fallback,
    });
  });

  return app;
}

/** Board lane from market cap, so route code never re-derives the thresholds. */
export function laneFor(mc: number): Lane {
  return laneOf({ mc });
}
