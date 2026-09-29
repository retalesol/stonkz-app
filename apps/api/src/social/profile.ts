import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { RANKS, isEvm, type Net } from '@stonkz/shared';
import type { AppDeps, AuthedUser } from '../app/context.js';
import {
  chainEvents,
  crateOpens,
  follows,
  stakePositions,
  tokens,
  trades,
  users,
} from '../db/schema.js';
import { rowsOf } from '../db/rows.js';
import { snapshotBaseUsd } from '../routes/curve-facts.js';
import { LiveBaseUsd } from '../routes/live-base-usd.js';
import {
  checkTelegram,
  checkWebsite,
  checkXHandle,
  sanitizeDescr,
  type Checked,
} from '../routes/launch-validate.js';

/**
 * Profile read model + input hygiene behind `routes/social.ts` and
 * `routes/me.ts`.
 *
 * Everything a *visitor* can see about a wallet is assembled here so the
 * privacy rule lives in one place: {@link canSeePrivate} decides, the route
 * redacts. Nothing in this module trusts a request body — usernames go
 * through {@link checkUsername}, links through `launch-validate.ts`'s
 * checkers, and every number comes from the indexer's tables or the chain.
 */

/* -------------------------------------------------------------------------- */
/* Identity fields                                                            */
/* -------------------------------------------------------------------------- */

export const USERNAME_MAX = 22;
export const BIO_MAX = 160;

/**
 * Names nobody may claim: brand/staff impersonation, route words that would
 * collide with `/u/<name>` or `/me`, and the empty-looking ones. Matched on
 * the lower-cased name, so `Admin`, `ADMIN` and `admin` are all refused.
 */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  'admin',
  'administrator',
  'mod',
  'moderator',
  'moderators',
  'staff',
  'support',
  'help',
  'team',
  'official',
  'system',
  'root',
  'owner',
  'stonkz',
  'stonk',
  'ston_kz',
  'stonkzapp',
  'stonkzteam',
  'stonkz_team',
  'mememan_official',
  'me',
  'u',
  'user',
  'users',
  'profile',
  'wallet',
  'api',
  'null',
  'undefined',
  'anonymous',
  'anon',
  'deleted',
  'unknown',
  'bonding_curve',
  'curve',
  'treasury',
  'dev',
  'creator',
  'bot',
]);

const USERNAME_RE = /^[A-Za-z0-9_]{1,22}$/;

/**
 * Trim, NFKC-fold (so a full-width `Ａ` cannot dodge the charset), then the
 * strict rule: 1-22 ASCII letters, digits or `_`; not all underscores; not a
 * reserved word. `null` means "clear the username".
 */
export function checkUsername(raw: unknown): Checked<string | null> {
  const v = String(raw ?? '')
    .normalize('NFKC')
    .trim();
  if (!v) return { ok: true, value: null };
  if (v.length > USERNAME_MAX || !USERNAME_RE.test(v)) {
    return {
      ok: false,
      detail: `username must be 1-${USERNAME_MAX} letters, numbers or _`,
    };
  }
  if (/^_+$/.test(v)) return { ok: false, detail: 'username needs a letter or a number' };
  if (RESERVED_USERNAMES.has(v.toLowerCase())) {
    return { ok: false, detail: 'that username is reserved' };
  }
  return { ok: true, value: v };
}

/** Bio: control/format characters stripped, whitespace collapsed, ≤ 160. */
export function checkBio(raw: unknown): Checked<string | null> {
  const v = sanitizeDescr(String(raw ?? ''));
  if (!v) return { ok: true, value: null };
  if (v.length > BIO_MAX) return { ok: false, detail: `bio must be at most ${BIO_MAX} chars` };
  return { ok: true, value: v };
}

/** An avatar is an `<img src>` on every page: https only, no credentials. */
export function checkAvatarUrl(raw: unknown): Checked<string | null> {
  const v = String(raw ?? '').trim();
  if (!v) return { ok: true, value: null };
  if (!/^https:\/\//i.test(v)) {
    return { ok: false, detail: 'avatarUrl must be an https:// URL' };
  }
  const checked = checkWebsite(v, 2048);
  if (!checked.ok) return { ok: false, detail: 'avatarUrl must be an https:// URL' };
  return checked;
}

export interface ProfilePatch {
  username?: string | null;
  bio?: string | null;
  avatarUrl?: string | null;
  xHandle?: string | null;
  website?: string | null;
  telegram?: string | null;
  private?: boolean;
}

export type PatchField = keyof ProfilePatch;

/**
 * Validates a `PATCH /me` body field by field. Returns the first problem as
 * `{ field, detail }` so the settings dialog can show it inline next to the
 * offending input rather than as one generic toast.
 */
export function checkProfilePatch(
  body: Record<string, unknown>,
): { ok: true; patch: ProfilePatch } | { ok: false; field: PatchField; detail: string } {
  const patch: ProfilePatch = {};
  const fail = (field: PatchField, detail: string) => ({ ok: false as const, field, detail });

  if ('username' in body) {
    const c = checkUsername(body['username']);
    if (!c.ok) return fail('username', c.detail);
    patch.username = c.value;
  }
  if ('bio' in body) {
    const c = checkBio(body['bio']);
    if (!c.ok) return fail('bio', c.detail);
    patch.bio = c.value;
  }
  if ('avatarUrl' in body) {
    const c = checkAvatarUrl(body['avatarUrl']);
    if (!c.ok) return fail('avatarUrl', c.detail);
    patch.avatarUrl = c.value;
  }
  if ('xHandle' in body) {
    const c = checkXHandle(String(body['xHandle'] ?? ''));
    if (!c.ok) return fail('xHandle', c.detail);
    patch.xHandle = c.value;
  }
  if ('website' in body) {
    const c = checkWebsite(String(body['website'] ?? ''));
    if (!c.ok) return fail('website', c.detail);
    patch.website = c.value;
  }
  if ('telegram' in body) {
    const c = checkTelegram(String(body['telegram'] ?? ''));
    if (!c.ok) return fail('telegram', c.detail);
    patch.telegram = c.value;
  }
  if ('private' in body) {
    const v = body['private'];
    if (typeof v !== 'boolean') return fail('private', 'private must be true or false');
    patch.private = v;
  }
  return { ok: true, patch };
}

export interface PublicProfile {
  username: string | null;
  bio: string | null;
  avatarUrl: string | null;
  xHandle: string | null;
  website: string | null;
  telegram: string | null;
  private: boolean;
  createdAtMs: number;
}

export function serialiseUser(row: typeof users.$inferSelect): PublicProfile {
  return {
    username: row.username,
    bio: row.bio,
    avatarUrl: row.avatarUrl,
    xHandle: row.xHandle,
    website: row.website,
    telegram: row.telegram,
    private: row.private,
    createdAtMs: row.createdAt.getTime(),
  };
}

/* -------------------------------------------------------------------------- */
/* Privacy                                                                    */
/* -------------------------------------------------------------------------- */

/** Same wallet on the same net; EVM compares case-insensitively. */
export function sameWallet(net: Net, a: string, b: string): boolean {
  return isEvm(net) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * The one privacy decision. A private profile's portfolio, PnL, recent
 * actions, wall and follow lists are visible to the owner only — never to
 * followers, never to admins through these routes.
 */
export function canSeePrivate(
  caller: AuthedUser | undefined,
  memberNet: Net,
  wallet: string,
  profileRow: { private: boolean } | null,
): boolean {
  if (!profileRow?.private) return true;
  if (!caller || caller.net !== memberNet) return false;
  return sameWallet(memberNet, caller.wallet, wallet);
}

/** Both spellings of an EVM wallet, so indexed equality still hits the index. */
export function walletForms(net: Net, wallet: string): string[] {
  if (!isEvm(net)) return [wallet];
  const lower = wallet.toLowerCase();
  return lower === wallet ? [wallet] : [wallet, lower];
}

/* -------------------------------------------------------------------------- */
/* Portfolio: cost basis from the trades table                                */
/* -------------------------------------------------------------------------- */

export interface CostBasis {
  /** Tokens bought, lifetime. */
  boughtTok: number;
  /** USD paid for `boughtTok`. */
  boughtUsd: number;
  soldTok: number;
  soldUsd: number;
  /** `boughtTok - soldTok` — what the trades alone say the wallet still holds. */
  netTok: number;
  /** Average USD cost per token over every buy. */
  avgCost: number;
  /** `soldUsd - soldTok * avgCost`. */
  realisedUsd: number;
}

/**
 * Lifetime buy/sell totals per token for one wallet, keyed by mint (falling
 * back to the ticker for pre-0009 rows). Only the indexer writes `trades`,
 * and only after a confirmed fill, so a provisional `fid` never lands here.
 */
export async function costBasisFor(
  deps: AppDeps,
  net: Net,
  wallet: string,
): Promise<Map<string, CostBasis>> {
  const rows = await deps.db
    .select({
      key: sql<string>`coalesce(${trades.mint}, ${trades.sym})`,
      boughtTok: sql<number>`coalesce(sum(case when ${trades.side} = 'buy' then ${trades.tokenAmount} else 0 end), 0)`,
      boughtUsd: sql<number>`coalesce(sum(case when ${trades.side} = 'buy' then ${trades.usdValue} else 0 end), 0)`,
      soldTok: sql<number>`coalesce(sum(case when ${trades.side} = 'sell' then ${trades.tokenAmount} else 0 end), 0)`,
      soldUsd: sql<number>`coalesce(sum(case when ${trades.side} = 'sell' then ${trades.usdValue} else 0 end), 0)`,
    })
    .from(trades)
    .where(and(eq(trades.net, net), inArray(trades.trader, walletForms(net, wallet))))
    .groupBy(sql`coalesce(${trades.mint}, ${trades.sym})`);

  const out = new Map<string, CostBasis>();
  for (const r of rows) {
    const boughtTok = Number(r.boughtTok);
    const boughtUsd = Number(r.boughtUsd);
    const soldTok = Number(r.soldTok);
    const soldUsd = Number(r.soldUsd);
    const avgCost = boughtTok > 0 ? boughtUsd / boughtTok : 0;
    out.set(r.key, {
      boughtTok,
      boughtUsd,
      soldTok,
      soldUsd,
      netTok: boughtTok - soldTok,
      avgCost,
      realisedUsd: soldUsd - soldTok * avgCost,
    });
  }
  return out;
}

export type BasisKind = 'trades' | 'partial' | 'unknown';

export interface HoldingOut {
  sym: string;
  mint: string | null;
  /** Whole tokens held right now. */
  tok: number;
  /** USD cost of the tokens still held (average-cost method); 0 when unknown. */
  cost: number;
  /** USD value at the current curve price. */
  value: number;
  priceUsd: number;
  /** Unrealised PnL on the held tokens; `null` when the basis is unknown. */
  pnlUsd: number | null;
  pnlPct: number | null;
  /** Realised USD PnL on sells so far, average-cost. */
  realisedUsd: number;
  /**
   * `trades` — every held token was bought here; `partial` — more tokens
   * than the trades explain (transfer in, airdrop, creator allocation), so
   * PnL covers only the bought part; `unknown` — no buys on record.
   */
  basis: BasisKind;
}

export interface RawHolding {
  sym: string;
  mint: string | null;
  tok: number;
  priceUsd: number;
}

/** Below this the position is dust and not worth a row. */
export const DUST_USD = 0.01;

/**
 * Attaches cost basis + PnL to on-chain (or trade-derived) balances, drops
 * dust, and sorts by value. Transfers and creator allocations do not have a
 * basis, so the PnL is computed on the bought part only and flagged.
 */
export function withCostBasis(raw: RawHolding[], basis: Map<string, CostBasis>): HoldingOut[] {
  const out: HoldingOut[] = [];
  for (const h of raw) {
    if (!(h.tok > 0)) continue;
    const value = h.tok * h.priceUsd;
    const b = basis.get(h.mint ?? h.sym) ?? basis.get(h.sym);
    let cost = 0;
    let kind: BasisKind = 'unknown';
    let realisedUsd = 0;
    if (b && b.boughtTok > 0) {
      realisedUsd = b.realisedUsd;
      // Tokens the trades can account for; anything above that came from
      // somewhere the trades table cannot see.
      const explained = Math.min(h.tok, Math.max(0, b.netTok));
      cost = explained * b.avgCost;
      kind = h.tok <= Math.max(0, b.netTok) * 1.0001 + 1e-9 ? 'trades' : 'partial';
    }
    if (value < DUST_USD && cost < DUST_USD) continue;
    const pnlUsd = kind === 'unknown' ? null : value - cost;
    const pnlPct = kind === 'unknown' || cost <= 0 ? null : (value / cost - 1) * 100;
    out.push({
      sym: h.sym,
      mint: h.mint,
      tok: h.tok,
      cost,
      value,
      priceUsd: h.priceUsd,
      pnlUsd,
      pnlPct,
      realisedUsd,
      basis: kind,
    });
  }
  out.sort((a, b) => b.value - a.value || b.tok - a.tok);
  return out;
}

/**
 * Net position per token from the trades table alone — the fallback when
 * the RPC cannot answer, and always the source of the sells that reduce a
 * position. Priced at the latest indexed market cap.
 */
/** The columns {@link tokenPriceUsd} prices a position from. */
export interface PricedTokenCols {
  net: string;
  baseSymbol: string;
  basePriceUsd1e6: string;
  mc: number;
  mcBase: number | null;
  supply: number;
}

export const PRICED_TOKEN_COLS = {
  net: tokens.net,
  baseSymbol: tokens.baseSymbol,
  basePriceUsd1e6: tokens.basePriceUsd1e6,
  mc: tokens.mc,
  mcBase: tokens.mcBase,
  supply: tokens.supply,
} as const;

/**
 * USD per token at the live base price (Pump.fun: a portfolio in ETH-paired
 * coins moves with ETH). Falls back to the snapshot-priced `mc` for a row
 * without a base figure.
 */
export async function tokenPriceUsd(prices: LiveBaseUsd, t: PricedTokenCols): Promise<number> {
  if (!(t.supply > 0)) return 0;
  const snapshot = snapshotBaseUsd(t);
  const mcBase = t.mcBase !== null && t.mcBase > 0 ? t.mcBase : snapshot > 0 ? t.mc / snapshot : 0;
  if (mcBase > 0) {
    const baseUsd = await prices.forRow(t);
    if (baseUsd > 0) return (mcBase * baseUsd) / t.supply;
  }
  return t.mc / t.supply;
}

export async function holdingsFromTrades(
  deps: AppDeps,
  net: Net,
  basis: Map<string, CostBasis>,
): Promise<RawHolding[]> {
  const keys = [...basis.keys()];
  if (!keys.length) return [];
  const known = await deps.db
    .select({ sym: tokens.sym, mint: tokens.mint, ...PRICED_TOKEN_COLS })
    .from(tokens)
    .where(and(eq(tokens.net, net), inArray(tokens.mint, keys)));
  const byMint = new Map(known.map((t) => [t.mint, t]));
  const prices = new LiveBaseUsd(deps);
  const out: RawHolding[] = [];
  for (const [key, b] of basis) {
    if (b.netTok <= 1e-6) continue;
    const t = byMint.get(key);
    const priceUsd = t ? await tokenPriceUsd(prices, t) : 0;
    out.push({ sym: t?.sym ?? key, mint: t?.mint ?? null, tok: b.netTok, priceUsd });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Staked positions (read-only from the indexer's `stake_positions`)          */
/* -------------------------------------------------------------------------- */

export interface StakedOut {
  sym: string;
  mint: string;
  amt: number;
  lockDays: number;
  mult: number;
  untilMs: number;
  rewardNative: number;
  rewardTokens: number;
  valueUsd: number;
}

export async function stakedSummary(deps: AppDeps, net: Net, wallet: string): Promise<StakedOut[]> {
  const rows = await deps.db
    .select({
      sym: stakePositions.sym,
      mint: stakePositions.mint,
      amount: stakePositions.amount,
      lockDays: stakePositions.lockDays,
      mult: stakePositions.mult,
      untilMs: stakePositions.untilMs,
      rewardNative: stakePositions.rewardNative,
      rewardTokens: stakePositions.rewardTokens,
      mc: tokens.mc,
      mcBase: tokens.mcBase,
      supply: tokens.supply,
      tokNet: tokens.net,
      baseSymbol: tokens.baseSymbol,
      basePriceUsd1e6: tokens.basePriceUsd1e6,
      tokSym: tokens.sym,
    })
    .from(stakePositions)
    .leftJoin(tokens, and(eq(tokens.net, stakePositions.net), eq(tokens.mint, stakePositions.mint)))
    .where(
      and(eq(stakePositions.net, net), inArray(stakePositions.wallet, walletForms(net, wallet))),
    );
  const prices = new LiveBaseUsd(deps);
  const out: StakedOut[] = [];
  for (const r of rows) {
    if (r.amount <= 0) continue;
    const priceUsd =
      r.mc != null && r.supply != null && r.tokNet != null
        ? await tokenPriceUsd(prices, {
            net: r.tokNet,
            baseSymbol: r.baseSymbol ?? '',
            basePriceUsd1e6: r.basePriceUsd1e6 ?? '0',
            mc: r.mc,
            mcBase: r.mcBase ?? null,
            supply: r.supply,
          })
        : 0;
    out.push({
      sym: r.tokSym ?? r.sym,
      mint: r.mint,
      amt: r.amount,
      lockDays: r.lockDays,
      mult: r.mult,
      untilMs: r.untilMs,
      rewardNative: r.rewardNative,
      rewardTokens: r.rewardTokens,
      valueUsd: r.amount * priceUsd,
    });
  }
  return out.sort((a, b) => b.valueUsd - a.valueUsd || b.amt - a.amt);
}

/* -------------------------------------------------------------------------- */
/* Recent actions                                                             */
/* -------------------------------------------------------------------------- */

export type ActivityKind =
  'buy' | 'sell' | 'launch' | 'stake' | 'unstake' | 'stake_claim' | 'crate' | 'level_up' | 'follow';

export interface ActivityItem {
  /** Stable per (kind, source row) — the client dedupes on it across pages. */
  id: string;
  kind: ActivityKind;
  net: Net;
  /** Epoch ms. */
  t: number;
  sym?: string;
  mint?: string;
  /** Chain signature / tx hash when the action settled on chain. */
  sig?: string;
  native?: number;
  usd?: number;
  tokens?: number;
  tier?: string;
  label?: string;
  level?: number;
  target?: string;
}

export interface ActivityPage {
  items: ActivityItem[];
  /** Pass back as `?before=` for the next page; `null` when this was the last. */
  nextBefore: number | null;
}

export const ACTIVITY_MAX = 100;

function rankIndex(xp: number): number {
  let i = 0;
  RANKS.forEach((r, k) => {
    if (xp >= r[1]) i = k;
  });
  return i;
}

/**
 * One wallet's recent actions, newest first, merged from the tables that
 * already record them: `trades` (buys/sells — indexer-only, so no
 * provisional duplicates), `tokens` (launches, with the `TokenCreated`
 * signature when indexed), `chain_events` (stake / unstake / claim),
 * `crate_opens`, `xp_events` (level-ups, derived from the running XP total)
 * and `follows`. Every source is cut at `before` and capped at `limit`, so a
 * page is at most `limit` rows per source before the merge.
 */
export async function recentActivity(
  deps: AppDeps,
  net: Net,
  wallet: string,
  opts: { before?: number | null; limit?: number } = {},
): Promise<ActivityPage> {
  const limit = Math.max(1, Math.min(ACTIVITY_MAX, Math.floor(opts.limit ?? 30)));
  const before = opts.before && Number.isFinite(opts.before) ? opts.before : null;
  const cutoff = before ? new Date(before) : null;
  const forms = walletForms(net, wallet);

  const tradeRows = await deps.db
    .select({
      id: trades.id,
      sym: trades.sym,
      mint: trades.mint,
      side: trades.side,
      sig: trades.txSig,
      nativeAmount: trades.nativeAmount,
      tokenAmount: trades.tokenAmount,
      usdValue: trades.usdValue,
      blockTime: trades.blockTime,
    })
    .from(trades)
    .where(
      and(
        eq(trades.net, net),
        inArray(trades.trader, forms),
        ...(cutoff ? [lt(trades.blockTime, cutoff)] : []),
      ),
    )
    .orderBy(desc(trades.blockTime), desc(trades.id))
    .limit(limit);

  const launchRows = await deps.db
    .select({ sym: tokens.sym, mint: tokens.mint, launchedAt: tokens.launchedAt })
    .from(tokens)
    .where(
      and(
        eq(tokens.net, net),
        inArray(tokens.creator, forms),
        ...(cutoff ? [lt(tokens.launchedAt, cutoff)] : []),
      ),
    )
    .orderBy(desc(tokens.launchedAt))
    .limit(limit);

  const stakeRows = await deps.db
    .select({
      id: chainEvents.id,
      kind: chainEvents.kind,
      sym: chainEvents.sym,
      sig: chainEvents.txSig,
      blockTime: chainEvents.blockTime,
      payload: chainEvents.payload,
    })
    .from(chainEvents)
    .where(
      and(
        eq(chainEvents.net, net),
        inArray(chainEvents.wallet, forms),
        inArray(chainEvents.kind, ['Staked', 'Unstaked', 'StakeClaimed']),
        ...(cutoff ? [lt(chainEvents.blockTime, cutoff)] : []),
      ),
    )
    .orderBy(desc(chainEvents.blockTime), desc(chainEvents.id))
    .limit(limit);

  // Launch signatures: the `TokenCreated` event for each mint, when indexed.
  const launchMints = launchRows.map((r) => r.mint).filter((m) => !!m);
  const createdRows = launchMints.length
    ? await deps.db
        .select({ sig: chainEvents.txSig, payload: chainEvents.payload })
        .from(chainEvents)
        .where(
          and(
            eq(chainEvents.net, net),
            eq(chainEvents.kind, 'TokenCreated'),
            inArray(sql`${chainEvents.payload}->>'mint'`, launchMints),
          ),
        )
    : [];
  const sigByMint = new Map<string, string>();
  for (const r of createdRows) {
    const mint = (r.payload as { mint?: string }).mint;
    if (mint) sigByMint.set(mint, r.sig);
  }

  const crateRows = await deps.db
    .select({
      id: crateOpens.id,
      tier: crateOpens.tier,
      payload: crateOpens.payloadJson,
      openedAt: crateOpens.openedAt,
    })
    .from(crateOpens)
    .where(
      and(
        eq(crateOpens.net, net),
        inArray(crateOpens.wallet, forms),
        ...(cutoff ? [lt(crateOpens.openedAt, cutoff)] : []),
      ),
    )
    .orderBy(desc(crateOpens.openedAt), desc(crateOpens.id))
    .limit(limit);

  const followRows = await deps.db
    .select({ followee: follows.followee, createdAt: follows.createdAt })
    .from(follows)
    .where(
      and(
        eq(follows.net, net),
        inArray(follows.follower, forms),
        ...(cutoff ? [lt(follows.createdAt, cutoff)] : []),
      ),
    )
    .orderBy(desc(follows.createdAt))
    .limit(limit);

  // Level-ups: the xp_events whose running total crossed a rank threshold.
  // The thresholds are compile-time constants from `RANKS`, so inlining them
  // as an int[] literal is safe.
  const thresholds = RANKS.slice(1).map((r) => r[1]);
  const walletList = sql.join(
    forms.map((w) => sql`${w}`),
    sql`, `,
  );
  const levelRes = await deps.db.execute(sql`
    with x as (
      select id, amount, created_at,
             sum(amount) over (order by id) as after
      from xp_events
      where net = ${net} and wallet in (${walletList})
    )
    select id, amount, created_at, after
    from x
    where amount > 0
      and (select count(*) from unnest(${sql.raw(`array[${thresholds.join(',')}]::int[]`)}) t where t <= after)
        > (select count(*) from unnest(${sql.raw(`array[${thresholds.join(',')}]::int[]`)}) t where t <= after - amount)
      ${cutoff ? sql`and created_at < ${cutoff}` : sql``}
    order by id desc
    limit ${limit}
  `);
  const levelRows = rowsOf<{
    id: number | string;
    amount: number | string;
    created_at: Date | string;
    after: number | string;
  }>(levelRes);

  const items: ActivityItem[] = [];
  for (const r of tradeRows) {
    items.push({
      id: `trade:${r.id}`,
      kind: r.side === 'buy' ? 'buy' : 'sell',
      net,
      t: r.blockTime.getTime(),
      sym: r.sym,
      ...(r.mint ? { mint: r.mint } : {}),
      sig: r.sig,
      native: r.nativeAmount,
      usd: r.usdValue,
      tokens: r.tokenAmount,
    });
  }
  for (const r of launchRows) {
    const sig = sigByMint.get(r.mint);
    items.push({
      id: `launch:${r.mint}`,
      kind: 'launch',
      net,
      t: r.launchedAt.getTime(),
      sym: r.sym,
      mint: r.mint,
      ...(sig ? { sig } : {}),
    });
  }
  for (const r of stakeRows) {
    const p = r.payload as {
      mint?: string;
      amount?: number;
      rewardNative?: number;
      rewardTokens?: number;
    };
    const kind: ActivityKind =
      r.kind === 'Staked' ? 'stake' : r.kind === 'Unstaked' ? 'unstake' : 'stake_claim';
    items.push({
      id: `${kind}:${r.id}`,
      kind,
      net,
      t: r.blockTime.getTime(),
      ...(r.sym ? { sym: r.sym } : {}),
      ...(p.mint ? { mint: p.mint } : {}),
      sig: r.sig,
      ...(typeof p.amount === 'number' ? { tokens: p.amount } : {}),
      ...(typeof p.rewardNative === 'number' ? { native: p.rewardNative } : {}),
      ...(kind === 'stake_claim' && typeof p.rewardTokens === 'number'
        ? { tokens: p.rewardTokens }
        : {}),
    });
  }
  for (const r of crateRows) {
    const p = r.payload as { label?: string };
    items.push({
      id: `crate:${r.id}`,
      kind: 'crate',
      net,
      t: r.openedAt.getTime(),
      tier: r.tier,
      ...(p.label ? { label: p.label } : {}),
    });
  }
  for (const r of levelRows) {
    const after = Number(r.after);
    const level = rankIndex(after) + 1;
    const at = r.created_at instanceof Date ? r.created_at : new Date(r.created_at);
    items.push({
      id: `level:${r.id}`,
      kind: 'level_up',
      net,
      t: at.getTime(),
      level,
      label: RANKS[level - 1]?.[0] ?? `LV ${level}`,
    });
  }
  for (const r of followRows) {
    items.push({
      id: `follow:${r.followee}:${r.createdAt.getTime()}`,
      kind: 'follow',
      net,
      t: r.createdAt.getTime(),
      target: r.followee,
    });
  }

  const seen = new Set<string>();
  const merged = items
    .filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)))
    .sort((a, b) => b.t - a.t || a.id.localeCompare(b.id));
  const page = merged.slice(0, limit);
  const more = merged.length > limit;
  const last = page[page.length - 1];
  return { items: page, nextBefore: more && last ? last.t : null };
}

/* -------------------------------------------------------------------------- */
/* Follow lists + identities                                                   */
/* -------------------------------------------------------------------------- */

export interface IdentityOut {
  wallet: string;
  username: string | null;
  avatarUrl: string | null;
}

export const IDENTITY_BATCH_MAX = 100;

/** Public identity (username + avatar) for a batch of wallets — never private data. */
export async function identitiesFor(
  deps: AppDeps,
  net: Net,
  wallets: string[],
): Promise<IdentityOut[]> {
  const unique = [...new Set(wallets.filter((w) => !!w))].slice(0, IDENTITY_BATCH_MAX);
  if (!unique.length) return [];
  const forms = isEvm(net) ? [...new Set(unique.flatMap((w) => walletForms(net, w)))] : unique;
  const rows = await deps.db
    .select({ wallet: users.wallet, username: users.username, avatarUrl: users.avatarUrl })
    .from(users)
    .where(and(eq(users.net, net), inArray(users.wallet, forms)));
  const byWallet = new Map(
    rows.map((r) => [isEvm(net) ? r.wallet.toLowerCase() : r.wallet, r] as const),
  );
  return unique.map((w) => {
    const hit = byWallet.get(isEvm(net) ? w.toLowerCase() : w);
    return { wallet: w, username: hit?.username ?? null, avatarUrl: hit?.avatarUrl ?? null };
  });
}

export interface FollowEntry extends IdentityOut {
  createdAtMs: number;
}

export interface FollowPage {
  entries: FollowEntry[];
  nextBefore: number | null;
}

export const FOLLOW_PAGE_MAX = 100;

/** Followers of, or wallets followed by, `wallet` — newest edge first. */
export async function followList(
  deps: AppDeps,
  net: Net,
  wallet: string,
  direction: 'followers' | 'following',
  opts: { before?: number | null; limit?: number } = {},
): Promise<FollowPage> {
  const limit = Math.max(1, Math.min(FOLLOW_PAGE_MAX, Math.floor(opts.limit ?? 30)));
  const cutoff = opts.before && Number.isFinite(opts.before) ? new Date(opts.before) : null;
  const forms = walletForms(net, wallet);
  const rows = await deps.db
    .select({
      other: direction === 'followers' ? follows.follower : follows.followee,
      createdAt: follows.createdAt,
    })
    .from(follows)
    .where(
      and(
        eq(follows.net, net),
        direction === 'followers'
          ? inArray(follows.followee, forms)
          : inArray(follows.follower, forms),
        ...(cutoff ? [lt(follows.createdAt, cutoff)] : []),
      ),
    )
    .orderBy(desc(follows.createdAt))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const ids = await identitiesFor(
    deps,
    net,
    page.map((r) => r.other),
  );
  const idByWallet = new Map(ids.map((i) => [i.wallet, i]));
  const last = page[page.length - 1];
  return {
    entries: page.map((r) => ({
      wallet: r.other,
      username: idByWallet.get(r.other)?.username ?? null,
      avatarUrl: idByWallet.get(r.other)?.avatarUrl ?? null,
      createdAtMs: r.createdAt.getTime(),
    })),
    nextBefore: rows.length > limit && last ? last.createdAt.getTime() : null,
  };
}

/** Mutual follows ("friends"): wallets that follow `wallet` and are followed back. */
export async function friendsOf(
  deps: AppDeps,
  net: Net,
  wallet: string,
  limit = 50,
): Promise<FollowEntry[]> {
  const forms = walletForms(net, wallet);
  const out = await deps.db
    .select({ other: follows.followee, createdAt: follows.createdAt })
    .from(follows)
    .where(
      and(
        eq(follows.net, net),
        inArray(follows.follower, forms),
        sql`exists (select 1 from ${follows} f2 where f2.net = ${follows.net} and f2.follower = ${follows.followee} and f2.followee = ${follows.follower})`,
      ),
    )
    .orderBy(desc(follows.createdAt))
    .limit(Math.max(1, Math.min(FOLLOW_PAGE_MAX, limit)));
  const ids = await identitiesFor(
    deps,
    net,
    out.map((r) => r.other),
  );
  const idByWallet = new Map(ids.map((i) => [i.wallet, i]));
  return out.map((r) => ({
    wallet: r.other,
    username: idByWallet.get(r.other)?.username ?? null,
    avatarUrl: idByWallet.get(r.other)?.avatarUrl ?? null,
    createdAtMs: r.createdAt.getTime(),
  }));
}
