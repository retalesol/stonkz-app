import { type Coin, type Fill, price, rng, vol24 } from '@stonkz/shared';
import { fakeAddr } from '../lib/fmt.js';
import { NATIVE_PRICE } from './wallet.js';

/**
 * The board's coin set.
 *
 * `SimCoin` is the wire `Coin` plus the things only the browser needs: the
 * cached card element, the lazily seeded series, and the per-coin tables. Phase
 * 1.D replaces the seeds with `GET /tokens`, candles and trades while keeping
 * `el` and `paint(c)` exactly as they are. `index.html:1104`
 */

export interface Comment {
  who: string;
  t: string;
  text: string;
  mine: boolean;
}

export interface Holder {
  /** Display label (short addr, or "BONDING CURVE"). */
  w: string;
  /** Full wallet for profile links; absent for curve row. */
  addr?: string;
  /** Percent of supply. */
  p: number;
  tag: readonly [label: string, cls: string] | null;
  curve?: boolean;
}

/** One leg of a multi-hop fill shown under an expanded trade row. */
export interface TradeHop {
  venue: string;
  inSymbol: string;
  outSymbol: string;
  inAmount: number;
  outAmount: number;
}

/** A row on the trades tab. `mine` is a render hint, not a claim of ownership. */
export interface Trade {
  t: Date;
  buy: boolean;
  sol: number;
  tok: number;
  mc: number;
  /** Display label (short addr or CASHBACK). */
  w: string;
  /** Full wallet for profile links when known. */
  addr?: string;
  /** Venue / route label: `CURVE`, `UNISWAP → CURVE`, etc. */
  v: string;
  /** Ordered hops when the route is multi-leg (native → base → token). */
  hops?: TradeHop[];
  /** Chain tx signature / hash when known — used to dedupe optimistic + WS. */
  sig?: string;
  /** UI: expanded hop detail. */
  open?: boolean;
  cb?: boolean;
  fresh?: boolean;
}

export interface SimCoin extends Coin {
  /** Cached card. Created once by `card(c)`, patched in place by `paint(c)`. */
  el: HTMLElement | null;
  /** Market-cap series. */
  h: number[] | null;
  /** Volume series, index-aligned with `h`. */
  hv: number[] | null;
  trades: Trade[] | null;
  comments: Comment[] | null;
  /** Simulated third-party stake, memoised. Phase 4 reads it from chain. */
  _oth?: number;
  /**
   * Live holders, fetched by `api.watchToken()`. `null` means "not fetched
   * yet (or sim)"; `holdersHTML()` falls back to the synthetic `holdersOf()`
   * table until this lands. `plan step 62`
   */
  liveHolders?: Holder[] | null;
}

/** Seed rows: sym, name, desc, mcap, 24h %, replies, holders, age in minutes. */
const RAW: Array<[string, string, string, number, number, number, number, number]> = [
  ['GIGA', 'Gigachad Labs', 'jawline forged in a squat rack. the only coin with a chin.', 3020000, 18.7, 4102, 19204, 1440],
  ['TRENCH', 'Trenchcoat Capital', 'three interns in a long coat pretending to be a hedge fund.', 1240000, 64.9, 2870, 8140, 212],
  ['WOJAK', 'Wojak Finance', 'he bought the top again. this time it is your top too.', 482000, 142.4, 1204, 3412, 41],
  ['CULT', 'Cult Capital', 'we do not have a roadmap, we have scripture.', 214000, 55.1, 3110, 9740, 760],
  ['MOONR', 'Moonrunner', 'strapped a chart to a rocket and forgot the parachute.', 128000, 29.8, 1640, 5122, 340],
  ['PEPE2', 'Pepe Two Point Oh', 'the sequel nobody asked for and everybody bought.', 96400, 11.9, 1420, 6210, 980],
  ['HOPIUM', 'Hopium Industries', 'industrial grade cope, refined onchain, sold by the barrel.', 67900, 87.3, 910, 2604, 88],
  ['BONKD', 'Bonked Ventures', 'got bonked, stayed bonked, now runs a venture fund.', 64100, 204.7, 508, 1602, 22],
  ['SER', 'Ser Please Ser', 'ser. ser. the chart ser. please ser look at it ser.', 58800, 7.2, 322, 1902, 120],
  ['BAGZ', 'Heavy Bagz', 'holding since the first candle and it shows in the posture.', 52300, -11.4, 412, 1440, 64],
  ['DELUSN', 'Delusional Capital', 'our thesis is vibes and our vibes are immaculate.', 47900, 33.4, 286, 1188, 52],
  ['FLOOR', 'Floor Seeker', 'every floor is a ceiling if you are patient enough.', 41200, 19.6, 244, 988, 36],
  ['JEETZ', 'Jeetz Protocol', 'sells the news, the rumor, and sometimes his own coin.', 31400, -68.8, 198, 780, 18],
  ['NGMI', 'NGMI Holdings', 'a diversified portfolio of bad decisions.', 22100, -42.1, 164, 702, 14],
  ['FUMBL', 'Fumbled Bag', 'had a hundred x in hand. had.', 17600, -23.6, 132, 544, 11],
  ['TENDIE', 'Tendie Town', 'fried, golden, and dangerously overbought.', 12400, 88.2, 96, 388, 7],
  ['LARP', 'Larp Industries', 'claims to be a whale. is four minnows in a trench coat.', 9800, 312.6, 74, 244, 4],
  ['RUGZ', 'Rugz Asset Mgmt', 'fully transparent about being exactly what it says.', 4200, -14.2, 38, 122, 2],
];

/** Coins the sim wallet launched, with unclaimed creator fees in the native unit. */
const MINE: Record<string, number> = { TENDIE: 1.84, LARP: 0.42 };

export const COINS: SimCoin[] = RAW.map((a, i) => {
  const mine = MINE[a[0]] !== undefined;
  return {
    id: i,
    sym: a[0],
    name: a[1],
    desc: a[2],
    mc: a[3],
    chg: a[4],
    reps: a[5],
    hold: a[6],
    age: a[7],
    seed: 1009 + i * 577,
    dev: mine ? 'YOU..7xKQ' : fakeAddr(3001 + i * 131),
    lane: null,
    el: null,
    lastMc: a[3],
    x: '@' + a[0].toLowerCase() + (i % 3 === 0 ? 'coin' : i % 3 === 1 ? 'onsol' : 'hq'),
    h: null,
    hv: null,
    trades: null,
    comments: null,
    mine,
    fee: mine ? (MINE[a[0]] as number) : 0,
  } satisfies SimCoin;
});

export function bySym(s: string): SimCoin | null {
  for (const c of COINS) if (c.sym === s) return c;
  return null;
}

/** All tickers currently taken, for the launch stepper's collision check. */
export function tickers(): string[] {
  return COINS.map((c) => c.sym);
}

export function myCoins(): SimCoin[] {
  return COINS.filter((c) => c.mine);
}

export function coinsBy(addr: string): SimCoin[] {
  return COINS.filter((c) => c.dev === addr);
}

/* -------------------------------------------------------------------------- */
/* Seeded series and tables — all replaced by REST in Phase 1.D                 */
/* -------------------------------------------------------------------------- */

/** Deterministic market-cap history ending at the current cap. `index.html:1137` */
export function histOf(c: SimCoin, n: number): number[] {
  const r = rng(c.seed);
  const out: number[] = [];
  let p = c.mc / (1 + c.chg / 100);
  const d = Math.pow(1 + Math.max(-0.9, c.chg / 100), 1 / n) - 1;
  for (let i = 0; i < n; i++) {
    p *= 1 + d + (r() - 0.5) * 0.09;
    out.push(Math.max(1, p));
  }
  out[n - 1] = c.mc;
  return out;
}

/** TODO(Phase 1.D): `GET /tokens/:sym/candles`. `index.html:1631` */
export function seedSeries(c: SimCoin): void {
  if (c.h) return;
  c.h = histOf(c, 200);
  const r = rng(c.seed + 7);
  c.hv = c.h.map(() => (vol24(c) / 200) * (0.35 + r() * 1.7));
}

const VENUE = ['PUMP', 'RAY', 'JUP', 'ORCA', 'METE'];

export function randomVenue(): string {
  return VENUE[(Math.random() * VENUE.length) | 0] as string;
}

/** TODO(Phase 1.D): `GET /tokens/:sym/trades`. `index.html:1637` */
export function seedTrades(c: SimCoin): void {
  if (c.trades) return;
  const r = rng(c.seed + 31);
  const now = Date.now();
  c.trades = [];
  for (let i = 0; i < 18; i++) {
    const buy = r() > 0.42;
    const sol = 0.05 + r() * 7;
    c.trades.push({
      t: new Date(now - (i * 47 + 9) * 1000),
      buy,
      sol,
      tok: (sol * NATIVE_PRICE.usd) / price(c),
      mc: c.mc * (0.94 + r() * 0.12),
      w: fakeAddr((r() * 1e6) | 0),
      v: VENUE[(r() * VENUE.length) | 0] as string,
    });
  }
}

const HOLDER_TAGS: Array<readonly [string, string]> = [
  ['DEV', 'dev'],
  ['SNIPER', 'snp'],
  ['WHALE', 'whl'],
];

/** TODO(Phase 1.D): `GET /tokens/:sym/holders`. `index.html:1664` */
export function holdersOf(c: SimCoin): Holder[] {
  const r = rng(c.seed + 91);
  const out: Holder[] = [];
  let left = 100;
  for (let i = 0; i < 11; i++) {
    const p =
      i === 0
        ? Math.min(left, c.mc > 69000 ? 1.4 + r() * 2 : 2.2 + r() * 6)
        : Math.min(left, (1.2 + r() * 4) / (1 + i * 0.16));
    left -= p;
    out.push({
      w: i === 0 ? c.dev : fakeAddr(c.seed + i * 137),
      p,
      tag: i === 0 ? (HOLDER_TAGS[0] as readonly [string, string]) : i < 3 && r() > 0.5 ? (HOLDER_TAGS[1] as readonly [string, string]) : p > 3 ? (HOLDER_TAGS[2] as readonly [string, string]) : null,
    });
  }
  out.push({ w: 'BONDING CURVE', p: Math.max(0.5, left), tag: ['CURVE', 'bc'], curve: true });
  return out;
}

/**
 * Prepend a fill to the trades tab.
 *
 * The renderer both the sim's own trades and the live `token:{sym}` WS fills
 * call (plan step 64): `tok`, `mc`, `w` and `v` are optional because a live
 * fill already knows its real token amount, resulting market cap, trader and
 * venue — only `buy`/`sol`/`cb` need deriving when the sim invents a print.
 * `index.html:2014`
 */
export function pushTrade(
  c: SimCoin,
  o: {
    buy: boolean;
    sol: number;
    cb?: boolean;
    mine?: boolean;
    tok?: number;
    mc?: number;
    w?: string;
    addr?: string;
    v?: string;
    hops?: TradeHop[];
    sig?: string;
  },
): Trade {
  seedTrades(c);
  const trades = c.trades as Trade[];
  const tok = o.tok ?? (o.sol * NATIVE_PRICE.usd) / price(c);
  const sig = o.sig?.toLowerCase();

  // Same on-chain fill often arrives twice: optimistic apply after wallet
  // confirm, then the indexer WS echo. Prefer merging into the existing row
  // so multi-hop routes stay a single expandable entry.
  const existingIdx = trades.findIndex((t) => {
    if (sig && t.sig && t.sig.toLowerCase() === sig) return true;
    if (t.buy !== o.buy) return false;
    const ageMs = Date.now() - t.t.getTime();
    if (ageMs < 0 || ageMs > 45_000) return false;
    const solClose = Math.abs(t.sol - o.sol) / Math.max(o.sol, 1e-12) < 0.02;
    const tokClose = Math.abs(t.tok - tok) / Math.max(tok, 1e-9) < 0.02;
    return solClose && tokClose;
  });
  if (existingIdx >= 0) {
    const prev = trades[existingIdx]!;
    const preferPrevRoute = !!(prev.v.includes('\u2192') && !(o.v && o.v.includes('\u2192')));
    const preferPrevHops = !!(prev.hops && prev.hops.length > 1 && !(o.hops && o.hops.length > 1));
    // Keep the wallet from the optimistic confirm when the WS echo still
    // attributes the fill to the router contract.
    const preferPrevWallet = !!(prev.addr && o.addr && prev.addr.toLowerCase() !== o.addr.toLowerCase() && preferPrevHops);
    const hops = preferPrevHops ? prev.hops : o.hops ?? prev.hops;
    const merged: Trade = {
      ...prev,
      t: prev.t,
      buy: o.buy,
      sol: o.sol || prev.sol,
      tok,
      mc: o.mc ?? prev.mc,
      ...(o.cb !== undefined || prev.cb !== undefined ? { cb: o.cb ?? prev.cb } : {}),
      w: preferPrevWallet ? prev.w : o.cb ? 'CASHBACK' : o.w ?? prev.w,
      ...(preferPrevWallet || o.addr || prev.addr
        ? { addr: preferPrevWallet ? prev.addr : o.addr ?? prev.addr }
        : {}),
      v: preferPrevRoute ? prev.v : o.v ?? prev.v,
      ...(hops ? { hops } : {}),
      ...(sig || prev.sig ? { sig: sig ?? prev.sig } : {}),
      ...(prev.open !== undefined ? { open: prev.open } : {}),
      // Merges are WS echoes of an already-shown fill — do not re-flash.
      fresh: false,
    };
    trades.forEach((t) => (t.fresh = false));
    trades.splice(existingIdx, 1);
    trades.unshift(merged);
    return merged;
  }

  trades.forEach((t) => (t.fresh = false));
  const t: Trade = {
    t: new Date(),
    buy: o.buy,
    sol: o.sol,
    tok,
    mc: o.mc ?? c.mc,
    cb: !!o.cb,
    w: o.cb ? 'CASHBACK' : o.w ?? (o.mine ? 'YOU..7xKQ' : fakeAddr((Math.random() * 1e6) | 0)),
    ...(o.addr ? { addr: o.addr } : {}),
    v: o.v ?? (o.cb ? 'CB' : randomVenue()),
    ...(o.hops && o.hops.length ? { hops: o.hops } : {}),
    ...(sig ? { sig } : {}),
    fresh: true,
  };
  trades.unshift(t);
  if (trades.length > 40) trades.pop();
  return t;
}

/** A confirmed fill in the shape Phase 1's WS will deliver. */
export function toFill(c: SimCoin, t: Trade): Fill {
  return {
    t: t.t.getTime(),
    sym: c.sym,
    net: c.net ?? 'SOL',
    buy: t.buy,
    sol: t.sol,
    tok: t.tok,
    mc: t.mc,
    w: t.w,
    v: t.sol * NATIVE_PRICE.usd,
    ...(t.cb ? { cb: true } : {}),
  };
}
