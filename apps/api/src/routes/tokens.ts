import { Hono } from 'hono';
import { and, desc, eq, getTableColumns, gt, gte, ilike, lt, or, sql, type SQL } from 'drizzle-orm';
import {
  SUPPLY,
  effFee,
  feeSplitOf,
  isEvm,
  laneOf,
  nativeUnit,
  parseNet,
  type EvmNet,
  type Lane,
  type Net,
  type TokenFees,
} from '@stonkz/shared';
import { PublicKey } from '@solana/web3.js';
import { evmChainId, evmExplorerUrl, evmLaunchpadAddress } from '../chain/evm-net.js';
import {
  fetchEvmHoldersFromExplorer,
  fetchEvmHoldersFromRpc,
  fetchSolHoldersFromRpc,
  type ChainHolder,
  type EthCaller,
  type HolderKind,
  type TaggedAccounts,
} from '../chain/token-holders.js';
import {
  candles,
  chatMessages,
  creatorVaults,
  holdersSnapshot,
  referralFeeEvents,
  stakePositions,
  tokens,
  trades,
  treasuryCredits,
} from '../db/schema.js';
import { derivePdas } from '../router/solana-idl.js';
import { limit, optionalAuth } from '../app/middleware.js';
import { RATE_LIMITS } from '../redis/ratelimit.js';
import { notHiddenFilter } from '../admin/index.js';
import type { AppEnv } from '../app/context.js';
import { PRIVATE_ROOM_SUFFIX } from '../social/chat.js';
import { serialiseToken, usdFromBase, type TokenRow } from './serialise.js';
import { curveFacts, snapshotBaseUsd, type CurveFacts } from './curve-facts.js';
import { LiveBaseUsd, liveMcSql } from './live-base-usd.js';
import { resolveTokenRow } from './token-resolve.js';
import { stakePoolSummary } from './stake-data.js';
import { creatorClaimable, sameWallet } from './creator-claimable.js';
import { encodeClaimPoolFeesCall, poolFeesExtra, poolFeesView } from '../chain/pool-fees.js';

/** Candle buckets, ms — the same six the indexer materialises (`apps/indexer/src/candles.ts`). */
const TF_MS: Record<string, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};
const TIMEFRAMES = new Set(Object.keys(TF_MS));

/**
 * One candle on the wire. `o`–`c` are USD per token at the response's
 * `baseUsd` (live); `ob`–`cb` are the same candle in base per token — the
 * series of record, which a client re-prices itself as the native mark ticks.
 */
interface WireCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  ob: number;
  hb: number;
  lb: number;
  cb: number;
  /** USD volume as recorded at fill time. */
  v: number;
  baseVolume: number;
  nativeVolume: number;
  trades: number;
}
const DAY_MS = 86_400_000;
/** `index.html:1451` — NEWEST, MARKET CAP, GAINERS, MOST REPLIES. */
const SORTS = new Set(['new', 'mc', 'chg', 'rep']);
/** Hard ceiling on `offset` so a crafted URL cannot make Postgres skip through the whole table. */
const MAX_OFFSET = 100_000;
/**
 * Shortest address fragment the search will prefix-match. `0x` or `So` alone
 * would otherwise list every coin on a chain.
 */
export const MINT_PREFIX_MIN = 6;

function parseLane(raw: string | undefined): Lane | null {
  return raw === 'new' || raw === 'soon' || raw === 'grad' ? raw : null;
}

function clampLimit(raw: string | undefined, fallback: number, max: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

// `curveFacts` lives in `./curve-facts.ts` so `serialise.ts` can share it;
// re-exported here for the callers (and tests) that import it from the route.
export { curveFacts, type CurveFacts };

/** Staked balances per wallet (the indexer's view), so a staker still reads as a holder. */
async function stakedByWallet(
  deps: { db: AppEnv['Variables']['deps']['db'] },
  net: Net,
  mint: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!mint) return out;
  const rows = await deps.db
    .select({ wallet: stakePositions.wallet, amount: stakePositions.amount })
    .from(stakePositions)
    .where(
      and(eq(stakePositions.net, net), eq(stakePositions.mint, mint), gt(stakePositions.amount, 0)),
    );
  for (const r of rows) {
    const key = net === 'SOL' ? r.wallet : r.wallet.toLowerCase();
    out.set(key, (out.get(key) ?? 0) + r.amount);
  }
  return out;
}

/** Program-owned Solana token accounts for `mint`, by address, or `{}` when the program id is unset. */
function solVaultTags(programId: string, mint: string, baseMint: string): TaggedAccounts {
  if (!programId || !mint || !baseMint) return {};
  try {
    const pdas = derivePdas(new PublicKey(programId), new PublicKey(mint), new PublicKey(baseMint));
    return {
      [pdas.curveTokenVault.toBase58()]: 'curve',
      [pdas.lpVault.toBase58()]: 'lp',
      [pdas.stakeEscrow.toBase58()]: 'stake',
      [pdas.bucketTokenVault.toBase58()]: 'bucket',
    };
  } catch {
    return {};
  }
}

/** A row on the holders tab, as the wire carries it. */
interface HolderOut {
  wallet: string;
  /** Balance plus anything staked — what the wallet economically holds. */
  amount: number;
  pct: number;
  costNative: number;
  /** Portion of `amount` sitting in the stake escrow / launchpad position. */
  staked?: number;
  kind: HolderKind;
  /** Kept for older clients: the bonding-curve vault row. */
  curve?: true;
}

/**
 * Turns raw chain balances into holder rows:
 *
 * - the launchpad's single EVM balance is split into the curve reserve, the
 *   LP reserve and the staked total (the contract holds all three), using the
 *   row's curve columns — so the tab never shows a 99.99% "BONDING CURVE"
 *   row that is really 79% curve + 20% LP + everyone's stakes;
 * - stakes are handed back to their wallets (indexer positions), so staking
 *   does not make a holder vanish;
 * - program accounts are never counted in `holderCount`.
 */
export function shapeHolders(input: {
  chain: ChainHolder[];
  supply: number;
  facts: CurveFacts | null;
  staked: Map<string, number>;
  cost: Map<string, number>;
  /** Preferred spelling per lower-cased EVM address (checksummed, as the indexer stores it). */
  canon?: Map<string, string>;
  evm: boolean;
  limit: number;
}): { holders: HolderOut[]; holderCount: number } {
  const { supply, facts, evm } = input;
  const key = (w: string): string => (evm ? w.toLowerCase() : w);
  const spell = (w: string): string => (evm ? (input.canon?.get(w.toLowerCase()) ?? w) : w);
  const pctOf = (amount: number): number => (supply > 0 ? (amount / supply) * 100 : 0);
  const stakedTotal = [...input.staked.values()].reduce((n, v) => n + v, 0);

  const byWallet = new Map<string, HolderOut>();
  const program: HolderOut[] = [];
  for (const h of input.chain) {
    if (h.kind === 'wallet') {
      const k = key(h.wallet);
      const prev = byWallet.get(k);
      if (prev) prev.amount += h.amount;
      else {
        byWallet.set(k, {
          wallet: spell(h.wallet),
          amount: h.amount,
          pct: 0,
          costNative: input.cost.get(k) ?? 0,
          kind: 'wallet',
        });
      }
      continue;
    }
    if (h.kind === 'curve' && evm && facts) {
      // One launchpad balance = curve reserve + LP reserve + stakes.
      const stakedHere = Math.min(h.amount, stakedTotal);
      const curveAmt = Math.min(h.amount - stakedHere, facts.realToken);
      const lpAmt = Math.max(0, h.amount - stakedHere - curveAmt);
      program.push({
        wallet: h.wallet,
        amount: curveAmt,
        pct: 0,
        costNative: 0,
        kind: 'curve',
        curve: true,
      });
      if (lpAmt > 0)
        program.push({ wallet: h.wallet, amount: lpAmt, pct: 0, costNative: 0, kind: 'lp' });
      continue;
    }
    if (h.kind === 'stake') {
      // Solana's stake escrow: attributed to wallets below; only the remainder (positions
      // the indexer has not seen yet) stays as its own row.
      const rest = Math.max(0, h.amount - stakedTotal);
      if (rest > 1e-9)
        program.push({ wallet: h.wallet, amount: rest, pct: 0, costNative: 0, kind: 'stake' });
      continue;
    }
    program.push({
      wallet: h.wallet,
      amount: h.amount,
      pct: 0,
      costNative: 0,
      kind: h.kind,
      ...(h.kind === 'curve' ? { curve: true as const } : {}),
    });
  }
  // Stakes: back to the wallets that own them.
  for (const [k, amt] of input.staked) {
    const prev = byWallet.get(k);
    if (prev) {
      prev.amount += amt;
      prev.staked = (prev.staked ?? 0) + amt;
    } else {
      byWallet.set(k, {
        wallet: spell(k),
        amount: amt,
        pct: 0,
        costNative: input.cost.get(k) ?? 0,
        staked: amt,
        kind: 'wallet',
      });
    }
  }
  const wallets = [...byWallet.values()].filter((h) => h.amount > 0);
  const holderCount = wallets.length;
  const holders = [...wallets, ...program]
    .map((h) => ({ ...h, pct: pctOf(h.amount) }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, input.limit);
  return { holders, holderCount };
}

/**
 * The token page header beyond the board card: real volume from the trades
 * table, real liquidity and cap in the base asset from the curve columns, and
 * the launch links. `serialiseToken`'s `liqUsd` is a simulation-era fraction
 * of the cap; it is overridden here whenever curve state exists.
 */
export async function tokenDetailExtras(
  deps: Pick<AppEnv['Variables']['deps'], 'db' | 'params'>,
  net: Net,
  row: TokenRow,
  now: number,
  /** Live USD per base unit; the launch snapshot when the route has none. */
  baseUsd: number = snapshotBaseUsd(row),
): Promise<Record<string, unknown>> {
  const mint = (row.mint ?? '').trim();
  const scope = mint
    ? and(eq(trades.net, net), eq(trades.mint, mint))
    : and(eq(trades.net, net), eq(trades.sym, row.sym));
  const agg = {
    usd: sql<number>`coalesce(sum(${trades.usdValue}), 0)`,
    nat: sql<number>`coalesce(sum(${trades.nativeAmount}), 0)`,
    base: sql<number>`coalesce(sum(${trades.baseAmount}), 0)`,
    n: sql<number>`count(*)::int`,
  };
  const [[all], [day]] = await Promise.all([
    deps.db.select(agg).from(trades).where(scope),
    deps.db
      .select(agg)
      .from(trades)
      .where(and(scope, gte(trades.blockTime, new Date(now - DAY_MS)))),
  ]);
  const facts = curveFacts(row);
  const unit = nativeUnit(net);
  const curveParams = await deps.params.get(net);
  const vol24Base = Number(day?.base ?? 0);
  const volTotalBase = Number(all?.base ?? 0);
  const vol24Recorded = Number(day?.usd ?? 0);
  return {
    nativeUnit: unit,
    baseUnit: row.baseSymbol,
    /** USD per base unit the live figures below were converted at. */
    baseUsd,
    // The "current" figures follow the live base price (Pump.fun): 24h volume
    // is the base traded × today's price. Lifetime USD volume stays as each
    // fill recorded it — history is not re-marked.
    vol24Usd: baseUsd > 0 && vol24Base > 0 ? vol24Base * baseUsd : vol24Recorded,
    vol24UsdRecorded: vol24Recorded,
    vol24Base,
    vol24Native: Number(day?.nat ?? 0),
    trades24h: Number(day?.n ?? 0),
    volTotalUsd: Number(all?.usd ?? 0),
    volTotalBase,
    volTotalNative: Number(all?.nat ?? 0),
    tradeCount: Number(all?.n ?? 0),
    graduationUsd: curveParams.gradUsd,
    ...(facts
      ? {
          mcBase: facts.mcBase,
          liqBase: facts.realBase,
          liqUsd: facts.realBase * (baseUsd > 0 ? baseUsd : facts.baseUsd),
          circulating: facts.circulating,
          curveTokens: facts.realToken,
          lpReserve: facts.lpReserve,
          baseUsdAtLaunch: facts.baseUsd,
          graduationBase: facts.gradBase,
          /** Graduation cap in USD at the live base price — what "$X to go" should count toward. */
          graduationUsdLive: facts.gradBase * (baseUsd > 0 ? baseUsd : facts.baseUsd),
          curveFillPct: facts.fillPct,
        }
      : {}),
  };
}

function clampOffset(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, MAX_OFFSET);
}

/** Escape LIKE metacharacters so a pasted name or address is matched literally. */
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => '\\' + m);
}

/**
 * The board search — the placeholder promises "ticker, name or contract":
 * ticker by prefix, name by substring, contract exactly or by prefix. All
 * case-insensitive: a pasted EVM address may be checksummed or lowercased and
 * a typed ticker may be lowercase; the ILIKE never changes what is matched,
 * only how (`0xabc` finds `0xAbC…`).
 */
export function searchClause(q: string): SQL | undefined {
  const lit = likeEscape(q);
  const parts: SQL[] = [
    ilike(tokens.sym, `${lit}%`),
    ilike(tokens.name, `%${lit}%`),
    ilike(tokens.mint, lit),
  ];
  if (q.length >= MINT_PREFIX_MIN) parts.push(ilike(tokens.mint, `${lit}%`));
  return or(...parts);
}

/**
 * Rows the live board hides: fixture placeholders with an empty mint and
 * `legacy:` synthetic ids left by old replays. Chain-mode ingest always has a
 * real mint address. Applied to the list *and* the lane counts so a header
 * never claims more coins than the lane below it shows.
 */
function liveRowFilters(): SQL[] {
  // `notHiddenFilter()`: an admin can delist a token from the board (never from the chain).
  return [sql`${tokens.mint} <> ''`, sql`${tokens.mint} not like 'legacy:%'`, notHiddenFilter()];
}

/**
 * Reply count for the card: the public token room plus its holders' room in
 * `chat_messages`, flagged lines excluded. Nothing bumps `tokens.replies`
 * today, so deriving it here is what makes MOST REPLIES sort by anything;
 * `greatest()` keeps a future write-through counter from lowering it.
 */
// The outer columns are spelled out in full: drizzle renders `${tokens.net}`
// as a bare `"net"` in a single-table select, which the subquery would resolve
// to *its* row and count every chain's room.
const OUTER_NET = sql.raw('"tokens"."net"');
const OUTER_SYM = sql.raw('"tokens"."sym"');
const repliesExpr = sql<number>`greatest(${tokens.replies}, (
  select count(*)::int from ${chatMessages} m
  where m.net = ${OUTER_NET}
    and m.room in (${OUTER_SYM}, ${OUTER_SYM} || ${PRIVATE_ROOM_SUFFIX})
    and not m.flagged
))`;

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
    const offset = clampOffset(c.req.query('offset'));

    const scope: SQL[] = [...liveRowFilters()];
    if (net) scope.push(eq(tokens.net, net));
    const filters: SQL[] = [...scope];
    if (lane) filters.push(eq(tokens.lane, lane));
    if (q) {
      const clause = searchClause(q);
      if (clause) filters.push(clause);
    }
    const where = and(...filters);

    // USD figures are base × the live base price, resolved once per request.
    const prices = new LiveBaseUsd(deps);
    const curveParams = await deps.params.all();

    // Every sort breaks ties on recency so paging with `offset` is stable:
    // two coins with the same cap never swap places between pages. MARKET CAP
    // orders by the *live* USD cap so a board of mixed nets and bases ranks
    // the way the cards read; the expression is built from the bases the
    // scope actually contains.
    let primary: SQL;
    if (sort === 'mc') {
      const pairs = await deps.db
        .selectDistinct({ net: tokens.net, baseSymbol: tokens.baseSymbol })
        .from(tokens)
        .where(where);
      primary = desc(await liveMcSql(prices, pairs));
    } else if (sort === 'chg') primary = desc(tokens.chg);
    else if (sort === 'rep') primary = desc(repliesExpr);
    else primary = desc(tokens.launchedAt);

    const [rows, [total], counts] = await Promise.all([
      deps.db
        .select({ ...getTableColumns(tokens), replies: repliesExpr })
        .from(tokens)
        .where(where)
        .orderBy(primary, desc(tokens.launchedAt), desc(tokens.mint))
        .limit(max)
        .offset(offset),
      deps.db
        .select({ n: sql<number>`count(*)::int` })
        .from(tokens)
        .where(where),
      deps.db
        .select({ lane: tokens.lane, n: sql<number>`count(*)::int` })
        .from(tokens)
        .where(and(...scope))
        .groupBy(tokens.lane),
    ]);

    const now = deps.now();
    const matched = total?.n ?? rows.length;
    return c.json({
      net: net ?? 'ALL',
      sort,
      count: rows.length,
      offset,
      /** Rows matching the filters across every page; `hasMore` is what a LOAD MORE button reads. */
      total: matched,
      hasMore: offset + rows.length < matched,
      lanes: {
        new: counts.find((r) => r.lane === 'new')?.n ?? 0,
        soon: counts.find((r) => r.lane === 'soon')?.n ?? 0,
        grad: counts.find((r) => r.lane === 'grad')?.n ?? 0,
      },
      tokens: await Promise.all(
        rows.map(async (r) =>
          serialiseToken(
            r as TokenRow,
            now,
            { baseUsd: await prices.liveForRow(r as TokenRow) },
            curveParams[r.net as Net],
          ),
        ),
      ),
    });
  });

  app.get('/tokens/:sym', async (c) => {
    const deps = c.get('deps');
    const sym = c.req.param('sym').toUpperCase();
    const net = parseNet(c.req.query('net')) ?? c.get('user')?.net ?? 'SOL';
    const mintQ = c.req.query('mint')?.trim() || undefined;

    const row = await resolveTokenRow(deps.db, net, { mint: mintQ, sym });
    if (!row) return c.json({ error: 'not_found' }, 404);

    // Same derived reply count the board card shows, so the header agrees.
    const [rep] = await deps.db
      .select({ n: repliesExpr })
      .from(tokens)
      .where(and(eq(tokens.net, net), eq(tokens.mint, row.mint)))
      .limit(1);
    const replies = rep?.n ?? row.replies;
    const prices = new LiveBaseUsd(deps);
    const [liveUsd, baseUsd] = await Promise.all([
      prices.liveForRow(row as TokenRow),
      prices.forRow(row as TokenRow),
    ]);

    return c.json({
      ...serialiseToken(
        { ...(row as TokenRow), replies },
        deps.now(),
        { baseUsd: liveUsd },
        await deps.params.get(net),
      ),
      ...(await tokenDetailExtras(deps, net, row as TokenRow, deps.now(), baseUsd)),
      // EVM v3 graduation only: the locked position's uncollected fees.
      ...(await poolFeesExtra(deps, net, row as TokenRow)),
    });
  });

  /**
   * `POST /tokens/:sym/pool-fees/claim/prepare` — the "CLAIM POOL FEES"
   * button on a v3-graduated EVM coin. `FeeLocker.claimFees(token)` is
   * permissionless: it collects the locked position's fees and routes them
   * into the launchpad's ledgers (creator, stakers, treasuries) by the curve
   * split; the caller only pays gas. Same single-call shape as
   * `/fees/claim/prepare`. Refuses `nothing_to_claim` when the pool reports
   * no uncollected fees, and `no_locked_position` for a coin whose
   * liquidity is not in the locker (a v2 graduation, or not yet migrated).
   */
  app.post(
    '/tokens/:sym/pool-fees/claim/prepare',
    optionalAuth(),
    limit(RATE_LIMITS.fees),
    async (c) => {
      const deps = c.get('deps');
      const sym = c.req.param('sym').toUpperCase();
      const net = parseNet(c.req.query('net')) ?? c.get('user')?.net ?? 'SOL';
      if (!isEvm(net)) return c.json({ error: 'bad_request', detail: 'EVM nets only' }, 400);
      const body = (await c.req.json().catch(() => ({}))) as { mint?: unknown };
      const mintBody = typeof body.mint === 'string' ? body.mint.trim() : undefined;

      const row = await resolveTokenRow(deps.db, net, { mint: mintBody, sym });
      if (!row || !row.mint) return c.json({ error: 'not_found' }, 404);
      if (row.graduatedAt === null || !row.poolAddress)
        return c.json({ error: 'not_graduated' }, 409);

      const fees = await poolFeesView(deps, net, row as TokenRow);
      if (!fees) return c.json({ error: 'no_locked_position' }, 422);
      if (fees.pendingBase <= 0 && fees.pendingTokens <= 0) {
        return c.json({ error: 'nothing_to_claim' }, 422);
      }
      return c.json({
        net,
        sym,
        mint: row.mint,
        ...fees,
        to: fees.locker,
        data: encodeClaimPoolFeesCall(row.mint),
        value: '0',
      });
    },
  );

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
    const supply = token && token.supply > 0 ? token.supply : SUPPLY;
    const bucketMs = TF_MS[tf] as number;
    // The USD axis is the base series × the live base price; the native axis
    // is the base series itself. A token that never had a base price
    // (fixture) has USD-only history: `baseUsd` is 1 and both axes carry the
    // same numbers.
    const snapshotUsd = token ? snapshotBaseUsd(token as TokenRow) : 0;
    const priced = snapshotUsd > 0;
    const liveUsd = priced ? await new LiveBaseUsd(deps).forRow(token as TokenRow) : 0;
    const baseUsd = priced ? (liveUsd > 0 ? liveUsd : snapshotUsd) : 1;
    const baseUnit = token?.baseSymbol ?? nativeUnit(net);
    const meta = { net, sym, tf, bucketMs, supply, baseUnit, baseUsd, baseUsdLive: liveUsd > 0 };

    // Candles are built from the fills themselves, priced at the curve's spot
    // after each fill (`trades.mc_base / supply`): the same number the header,
    // the board card and a live `fill` frame show. The indexer's `candles`
    // rows carry the *average execution* price (paid ÷ tokens, fee included),
    // which sits ~fee% above spot and made every REST candle disagree with
    // the live point that followed it. Open is the previous bucket's close so
    // the candle body shows the move, not a dot. A fill from before 0027 has
    // no `mc_base`; its snapshot-USD `mc` converts back exactly.
    const bucket = sql<number>`(floor(extract(epoch from ${trades.blockTime}) * 1000 / ${sql.raw(String(bucketMs))}) * ${sql.raw(String(bucketMs))})`;
    const capBase = priced
      ? sql<number>`coalesce(${trades.mcBase}, ${trades.mc} / ${snapshotUsd})`
      : sql<number>`${trades.mc}`;
    const scope = mint
      ? and(eq(trades.net, net), eq(trades.mint, mint))
      : and(eq(trades.net, net), eq(trades.sym, sym));
    const agg = await deps.db
      .select({
        t: bucket,
        o: sql<number>`(array_agg(${capBase} order by ${trades.chainPosition} asc, ${trades.logIndex} asc, ${trades.id} asc))[1]`,
        h: sql<number>`max(${capBase})`,
        l: sql<number>`min(${capBase})`,
        c: sql<number>`(array_agg(${capBase} order by ${trades.chainPosition} desc, ${trades.logIndex} desc, ${trades.id} desc))[1]`,
        v: sql<number>`coalesce(sum(${trades.usdValue}), 0)`,
        bv: sql<number>`coalesce(sum(${trades.baseAmount}), 0)`,
        nv: sql<number>`coalesce(sum(${trades.nativeAmount}), 0)`,
        n: sql<number>`count(*)::int`,
      })
      .from(trades)
      .where(scope)
      .groupBy(bucket)
      .orderBy(desc(bucket))
      .limit(max);

    if (agg.length > 0) {
      const out: WireCandle[] = [];
      for (const r of agg.reverse()) {
        const prev = out[out.length - 1];
        const ob = prev ? prev.cb : Number(r.o) / supply;
        const cb = Number(r.c) / supply;
        const hb = Math.max(Number(r.h) / supply, ob, cb);
        const lb = Math.min(Number(r.l) / supply, ob, cb);
        out.push({
          t: Number(r.t),
          o: ob * baseUsd,
          h: hb * baseUsd,
          l: lb * baseUsd,
          c: cb * baseUsd,
          ob,
          hb,
          lb,
          cb,
          v: Number(r.v),
          baseVolume: Number(r.bv),
          nativeVolume: Number(r.nv),
          trades: Number(r.n),
        });
      }
      return c.json({ ...meta, basis: 'spot', candles: out });
    }

    // No fills on record: fall back to whatever the indexer materialised
    // (fixture rows, or a replay that wrote candles before trades).
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

    // Indexed candles hold base OHLC since 0027; older rows convert back from
    // the snapshot USD they were written at.
    const toBase = (usd: number, base: number | null): number =>
      base !== null && base > 0 ? base : priced && snapshotUsd > 0 ? usd / snapshotUsd : usd;
    return c.json({
      ...meta,
      basis: 'indexed',
      // Oldest first: `drawTChart` walks the series left to right.
      candles: rows.reverse().map((r): WireCandle => {
        const ob = toBase(r.o, r.oBase);
        const hb = toBase(r.h, r.hBase);
        const lb = toBase(r.l, r.lBase);
        const cb = toBase(r.c, r.cBase);
        return {
          t: r.bucketStart.getTime(),
          o: ob * baseUsd,
          h: hb * baseUsd,
          l: lb * baseUsd,
          c: cb * baseUsd,
          ob,
          hb,
          lb,
          cb,
          v: r.v,
          baseVolume: 0,
          nativeVolume: r.nativeVolume,
          trades: r.trades,
        };
      }),
    });
  });

  app.get('/tokens/:sym/trades', async (c) => {
    const deps = c.get('deps');
    const sym = c.req.param('sym').toUpperCase();
    const net = parseNet(c.req.query('net')) ?? c.get('user')?.net ?? 'SOL';
    const mintQ = c.req.query('mint')?.trim() || undefined;
    const max = clampLimit(c.req.query('limit'), 50, 200);
    // Cursor for "load older": rows strictly before this trade id (the
    // indexer's insertion order, which is also chain order per token).
    const beforeRaw = Number.parseInt(c.req.query('before') ?? '', 10);
    const before = Number.isFinite(beforeRaw) && beforeRaw > 0 ? beforeRaw : null;

    const token = await resolveTokenRow(deps.db, net, { mint: mintQ, sym });
    const mint = token?.mint;
    const scope = mint
      ? and(eq(trades.net, net), eq(trades.mint, mint))
      : and(eq(trades.net, net), eq(trades.sym, sym));
    const page = await deps.db
      .select()
      .from(trades)
      .where(before === null ? scope : and(scope, lt(trades.id, before)))
      .orderBy(desc(trades.id))
      .limit(max + 1);
    const hasMore = page.length > max;
    const rows = hasMore ? page.slice(0, max) : page;
    const oldest = rows[rows.length - 1];
    const snapshotUsd = token ? snapshotBaseUsd(token as TokenRow) : 0;
    const baseUsd = token ? await new LiveBaseUsd(deps).forRow(token as TokenRow) : 0;
    const baseOf = (mcBase: number | null, mcUsd: number): number | undefined =>
      mcBase !== null && mcBase > 0
        ? mcBase
        : snapshotUsd > 0 && mcUsd > 0
          ? mcUsd / snapshotUsd
          : undefined;

    return c.json({
      net,
      sym,
      ...(mint ? { mint } : {}),
      nativeUnit: nativeUnit(net),
      baseUnit: token?.baseSymbol ?? nativeUnit(net),
      baseUsd,
      hasMore,
      ...(hasMore && oldest ? { nextBefore: oldest.id } : {}),
      // `mc` is the cap after the fill at today's base price (what the chart
      // draws); `mcRecorded` / `v` are the USD figures as the fill recorded them.
      trades: rows.map((r) => {
        const mcBase = baseOf(r.mcBase, r.mc);
        return {
          id: r.id,
          t: r.blockTime.getTime(),
          sym: r.sym,
          mint: r.mint ?? undefined,
          net: r.net,
          buy: r.side === 'buy',
          sol: r.nativeAmount,
          tok: r.tokenAmount,
          base: r.baseAmount,
          mc: usdFromBase(mcBase, baseUsd, r.mc),
          mcRecorded: r.mc,
          ...(mcBase !== undefined
            ? { mcBase, priceBase: r.tokenAmount > 0 ? r.baseAmount / r.tokenAmount : 0 }
            : {}),
          w: r.trader,
          v: r.usdValue,
          cb: r.cashback,
          sig: r.txSig,
        };
      }),
    });
  });

  /**
   * `GET /tokens/:sym/fees?net=` — the lifetime fee ledger behind the Fees tab.
   * Treasury legs come from `treasury_credits` (one row per vault per fill,
   * written by the indexer from `FeeAccrued`); the creator bucket and the
   * staker peel from `creator_vaults`. Native units throughout.
   */
  app.get('/tokens/:sym/fees', optionalAuth(), async (c) => {
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
    const buyback = leg('buyback');
    const rwa = leg('rwa');
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
    const curveParams = await deps.params.get(net);
    // What a fill pays right now: the creator fee plus the decaying cashback
    // premium while that window is open (the same curve the ticket shows).
    const effFeeBps = Math.round(
      effFee(
        { tfee: feeBps / 100, cashback: token.cashback, cbStart: token.cbStartMs ?? undefined },
        deps.now(),
        curveParams,
      ) * 100,
    );
    // The creator's own view reads the program's ledger (that is what the
    // CLAIM button pays); everyone else gets the indexer's row, so a public,
    // polled tab spends no RPC on it.
    const viewer = c.get('user');
    const viewerIsCreator =
      !!viewer && viewer.net === net && sameWallet(net, viewer.wallet, token.creator);
    const [staking, creator] = await Promise.all([
      stakePoolSummary(deps, net, token),
      creatorClaimable(deps, net, token, { chain: viewerIsCreator }),
    ]);
    const body: TokenFees = {
      sym: token.sym,
      net,
      unit: nativeUnit(net),
      feeBps,
      effFeeBps,
      split: feeSplitOf(curveParams),
      totals: {
        // The DB protocol leg is credited net of referral commissions
        // (`ingest.ts` `reconcileFeeAccrued`), so the gross fee taken on
        // chain is the four legs plus what referrers were paid out of it.
        gross: protocol + referrals + buyback + rwa + creatorBucket,
        protocol,
        buyback,
        rwa,
        creatorBucket,
        creator: Math.max(0, creatorBucket - stakers),
        stakers,
        referrals,
        stakersTokens: vault?.stakerPoolTokens ?? 0,
      },
      source: 'chain',
      staking,
      creator,
    };
    return c.json(body);
  });

  /**
   * `GET /tokens/:sym/staking?net=&mint=` — the coin's stake pool on its own:
   * total staked, stakers, the pool's current share of the creator bucket and
   * lifetime staker earnings. Public; cached for `STAKE_POOL_TTL_MS`.
   */
  app.get('/tokens/:sym/staking', async (c) => {
    const deps = c.get('deps');
    const sym = c.req.param('sym').toUpperCase();
    const net = parseNet(c.req.query('net')) ?? c.get('user')?.net ?? 'SOL';
    const mintQ = c.req.query('mint')?.trim() || undefined;
    const token = await resolveTokenRow(deps.db, net, { mint: mintQ, sym });
    if (!token) return c.json({ error: 'not_found' }, 404);
    return c.json({
      sym: token.sym,
      net,
      mint: token.mint,
      ...(await stakePoolSummary(deps, net, token)),
    });
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
    const evm = isEvm(net);
    const launchpad = evm ? evmLaunchpadAddress(deps.env, net as EvmNet) : '';
    const facts = curveFacts(token as TokenRow);
    const solTags =
      net === 'SOL' ? solVaultTags(deps.env.solanaLaunchpadProgramId, mint, token.baseMint) : {};

    // What the indexer knows: cost basis per wallet, everyone who ever
    // traded (the RPC fallback's candidate list) and staked balances.
    const snapshot = mint
      ? await deps.db
          .select()
          .from(holdersSnapshot)
          .where(and(eq(holdersSnapshot.net, net), eq(holdersSnapshot.mint, mint)))
          .orderBy(desc(holdersSnapshot.tokenAmount))
          .limit(Math.max(max, 64))
      : [];
    const cost = new Map<string, number>();
    const canon = new Map<string, string>();
    for (const r of snapshot) {
      cost.set(evm ? r.wallet.toLowerCase() : r.wallet, r.costNative);
      canon.set(r.wallet.toLowerCase(), r.wallet);
    }
    if (token.creator) canon.set(token.creator.toLowerCase(), token.creator);
    const staked = await stakedByWallet(deps, net, mint);
    // Position values on the tab: `amount × priceUsd`, at the live base price.
    const baseUsd = await new LiveBaseUsd(deps).liveForRow(token as TokenRow);
    const view = serialiseToken(
      token as TokenRow,
      deps.now(),
      { baseUsd },
      await deps.params.get(net),
    );

    const respond = (chain: ChainHolder[], source: 'explorer' | 'rpc' | 'db'): Response => {
      const shaped = shapeHolders({ chain, supply, facts, staked, cost, canon, evm, limit: max });
      return c.json({
        net,
        sym,
        ...(mint ? { mint } : {}),
        source,
        baseUnit: token.baseSymbol,
        baseUsd: view.baseUsd,
        mc: view.mc,
        mcBase: view.mcBase,
        priceUsd: view.priceUsd,
        priceBase: view.priceBase,
        ...(evm ? { curveWallet: launchpad } : {}),
        ...(facts
          ? {
              curveTokens: facts.realToken,
              lpReserve: facts.lpReserve,
              circulating: facts.circulating,
            }
          : {}),
        stakedTotal: [...staked.values()].reduce((n, v) => n + v, 0),
        supply,
        holderCount: shaped.holderCount,
        holders: shaped.holders,
      });
    };

    const cacheChainHolders = async (
      chainHolders: ChainHolder[],
      holderCount: number,
    ): Promise<void> => {
      // Best-effort: keep the snapshot warm so an RPC/explorer outage still
      // serves the last known on-chain picture. Program accounts are cached
      // too (the DB fallback re-tags them), stakes are not (they live in
      // `stake_positions`).
      try {
        for (const h of chainHolders) {
          await deps.db
            .insert(holdersSnapshot)
            .values({ net, sym, mint, wallet: h.wallet, tokenAmount: h.amount, costNative: 0 })
            .onConflictDoUpdate({
              target: [holdersSnapshot.net, holdersSnapshot.mint, holdersSnapshot.wallet],
              set: { tokenAmount: h.amount },
            });
        }
        await deps.db
          .update(tokens)
          .set({ holders: holderCount, updatedAt: new Date(deps.now()) })
          .where(and(eq(tokens.net, net), eq(tokens.mint, mint)));
      } catch (err) {
        deps.logger.warn('holders snapshot cache failed', { net, sym, mint, err: String(err) });
      }
    };

    const finishChain = (live: {
      holders: ChainHolder[];
      source: 'explorer' | 'rpc';
    }): Response => {
      const shaped = shapeHolders({
        chain: live.holders,
        supply,
        facts,
        staked,
        cost,
        canon,
        evm,
        limit: max,
      });
      void cacheChainHolders(live.holders, shaped.holderCount);
      return respond(live.holders, live.source);
    };

    const warn = (what: string, err: unknown): void => {
      deps.logger.warn(what, { net, sym, mint, err: String(err) });
    };

    if (mint && evm) {
      try {
        return finishChain(
          await fetchEvmHoldersFromExplorer({
            mint,
            launchpad,
            decimals: token.tokenDecimals || 18,
            limit: max,
            explorerUrl: evmExplorerUrl(deps.env, net as EvmNet),
            chainId: evmChainId(deps.env, net as EvmNet),
          }),
        );
      } catch (err) {
        warn('explorer holders failed; verifying known wallets over rpc', err);
      }
      // The explorer is how holders are *discovered*; without it, verify the
      // wallets the indexer knows (traders, stakers, the creator) by balanceOf.
      const rpc = deps.rpcs[net] as unknown as Partial<EthCaller>;
      if (typeof rpc.ethCall === 'function') {
        try {
          return finishChain(
            await fetchEvmHoldersFromRpc({
              mint,
              launchpad,
              wallets: [token.creator, ...snapshot.map((r) => r.wallet), ...staked.keys()],
              decimals: token.tokenDecimals || 18,
              limit: max,
              rpc: rpc as EthCaller,
            }),
          );
        } catch (err) {
          warn('rpc holders failed; falling back to db', err);
        }
      }
    } else if (mint && net === 'SOL') {
      try {
        return finishChain(
          await fetchSolHoldersFromRpc({
            mint,
            tagged: solTags,
            decimals: token.tokenDecimals || 6,
            limit: Math.min(max, 20),
            rpcUrl: deps.env.solanaRpcUrl,
          }),
        );
      } catch (err) {
        warn('on-chain holders failed; falling back to db', err);
      }
    }

    // The snapshot: the indexer's running balances (buys minus sells), with
    // program accounts re-tagged so they are never counted as holders.
    const fromDb: ChainHolder[] = snapshot
      .filter((r) => r.tokenAmount > 0)
      .map((r) => {
        const kind: HolderKind =
          evm && launchpad && r.wallet.toLowerCase() === launchpad.toLowerCase()
            ? 'curve'
            : (solTags[r.wallet] ?? 'wallet');
        return { wallet: r.wallet, amount: r.tokenAmount, curve: kind === 'curve', kind };
      });
    // The snapshot already folds stakes into the wallet's running total
    // (nothing decrements it on a stake), so do not add them twice.
    staked.clear();
    return respond(fromDb, 'db');
  });

  return app;
}

/** Board lane from market cap, so route code never re-derives the thresholds. */
export function laneFor(mc: number): Lane {
  return laneOf({ mc });
}
