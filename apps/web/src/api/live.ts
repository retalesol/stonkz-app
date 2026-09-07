import {
  SUPPLY,
  type CrateTier,
  type Fill,
  type Lane,
  type Net,
  type Quote,
  type Wallet,
} from '@stonkz/shared';
import { emit } from '../lib/bus.js';
import { shortAddr } from '../lib/fmt.js';
import { COINS, bySym, pushTrade, type Holder, type SimCoin, type Trade } from '../state/coins.js';
import { WALLET } from '../state/wallet.js';
import { simApi } from './sim.js';
import type {
  ClaimResult,
  CrateResult,
  LaunchDraft,
  QuoteInput,
  StakeClaim,
  StakeInput,
  StonkzApi,
} from './types.js';

/**
 * The live adapter — read path (plan step 62-70).
 *
 * `ready()`, `startStream()`/`stopStream()`, `watchToken()`/`unwatchToken()`
 * and `search()` are real: they replace `COINS`/`RAW`, `histOf`/`seedSeries`,
 * `seedTrades`/`holdersOf` and the tape/KOTH random generators with
 * `GET /tokens`, `GET /tokens/:sym/{candles,trades,holders}`, `GET /tape` and
 * the `board`/`tape`/`token:{sym}` WS channels.
 *
 * `quote`/`trade`/`connect`/`disconnect`/`launch`/`claimCreatorFees`/`stake`/
 * `unstake`/`claimStake`/`openCrate` are **not** wired here — the trade box,
 * launch stepper, staking and crates stay on `simApi`'s implementations,
 * operating on the now-live `COINS`, until the sibling round that lands
 * `/quote`, `/trade/*` and `/launch/*` wires them (Phase 2.C). That is why the
 * "SIMULATED" disclosure chip stays lit regardless of `VITE_API_MODE`.
 *
 * @see plan step 30, plan step 62-70
 */

const BASE = import.meta.env['VITE_API_URL'] ?? '';
const WS_URL = (import.meta.env['VITE_WS_URL'] ?? '').replace(/\/+$/, '') + '/ws';

/* -------------------------------------------------------------------------- */
/* Wire shapes — `apps/api/src/routes/{tokens,market}.ts`                     */
/* -------------------------------------------------------------------------- */

/** `serialiseToken()` in `apps/api/src/routes/serialise.ts`. */
interface ApiToken {
  id: number;
  sym: string;
  name: string;
  desc: string;
  mc: number;
  chg: number;
  reps: number;
  hold: number;
  age: number;
  seed: number;
  dev: string;
  lane: Lane;
  lastMc: number;
  supply?: number;
  base?: string;
  tfee?: number;
  net: Net;
  cashback?: boolean;
  cbStart?: number;
  x?: string;
  web?: string;
  tg?: string;
}

interface ApiTokensResponse {
  net: string;
  tokens: ApiToken[];
}

interface ApiCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  nativeVolume: number;
}

interface ApiCandlesResponse {
  candles: ApiCandle[];
}

interface ApiTradeRow {
  t: number;
  buy: boolean;
  sol: number;
  tok: number;
  mc: number;
  w: string;
  v: number;
  cb: boolean;
}

interface ApiTradesResponse {
  trades: ApiTradeRow[];
}

interface ApiHolderRow {
  wallet: string;
  amount: number;
  pct: number;
}

interface ApiHoldersResponse {
  holders: ApiHolderRow[];
}

interface ApiFillPayload {
  t: number;
  sym: string;
  net: Net;
  buy: boolean;
  sol: number;
  tok: number;
  mc: number;
  w: string;
  v: number;
  cb?: boolean;
  sig?: string;
}

interface ApiTapeResponse {
  fills: ApiFillPayload[];
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`live api: GET ${path} -> ${res.status}`);
  return (await res.json()) as T;
}

/* -------------------------------------------------------------------------- */
/* Mapping — API wire shapes -> the same `SimCoin`/`Trade`/`Holder` the        */
/* renderer already patches. The wire format mirrors `Coin` on purpose        */
/* (`apps/api/src/routes/serialise.ts`), so this is a reshape, not a guess.    */
/* -------------------------------------------------------------------------- */

function toSimCoin(t: ApiToken): SimCoin {
  return {
    id: t.id,
    sym: t.sym,
    name: t.name,
    desc: t.desc,
    mc: t.mc,
    chg: t.chg,
    reps: t.reps,
    hold: t.hold,
    age: t.age,
    seed: t.seed,
    dev: t.dev,
    lane: t.lane,
    lastMc: t.lastMc,
    net: t.net,
    cashback: !!t.cashback,
    ...(t.supply !== undefined ? { supply: t.supply } : {}),
    ...(t.base !== undefined ? { base: t.base } : {}),
    ...(t.tfee !== undefined ? { tfee: t.tfee } : {}),
    ...(t.cbStart !== undefined ? { cbStart: t.cbStart } : {}),
    ...(t.x !== undefined ? { x: t.x } : {}),
    ...(t.web !== undefined ? { web: t.web } : {}),
    ...(t.tg !== undefined ? { tg: t.tg } : {}),
    el: null,
    h: null,
    hv: null,
    trades: null,
    comments: null,
    liveHolders: null,
  };
}

/** Patch an already-rendered coin in place, so `c.el` and open charts survive. */
function patchCoin(c: SimCoin, t: ApiToken): void {
  c.lastMc = c.mc;
  c.mc = t.mc;
  c.chg = t.chg;
  c.reps = t.reps;
  c.hold = t.hold;
  c.age = t.age;
  c.cashback = !!t.cashback;
  if (t.cbStart !== undefined) c.cbStart = t.cbStart;
  if (t.tfee !== undefined) c.tfee = t.tfee;
  const prevLane = c.lane;
  c.lane = t.lane;
  if (prevLane !== t.lane) emit('lane', { sym: c.sym, lane: t.lane });
}

/** Candle closes -> the market-cap series `drawTokenChart` already draws. */
function applyCandles(c: SimCoin, candles: ApiCandle[]): void {
  const supply = c.supply || SUPPLY;
  c.h = candles.map((k) => k.c * supply);
  // `v` is USD notional per bucket — the same scale the sim's synthetic
  // volume bars approximated, now the real thing. `plan step 63`
  c.hv = candles.map((k) => k.v);
}

function venueFor(c: SimCoin): string {
  return c.lane === 'grad' ? 'DEX' : 'CURVE';
}

function mapTradeRow(c: SimCoin, r: ApiTradeRow): Trade {
  return {
    t: new Date(r.t),
    buy: r.buy,
    sol: r.sol,
    tok: r.tok,
    mc: r.mc,
    cb: !!r.cb,
    w: r.cb ? 'CASHBACK' : shortAddr(r.w),
    v: venueFor(c),
  };
}

function mapHolders(c: SimCoin, rows: ApiHolderRow[]): Holder[] {
  let left = 100;
  const out: Holder[] = rows.map((r) => {
    left -= r.pct;
    const isDev = r.wallet === c.dev;
    return {
      w: shortAddr(r.wallet),
      p: r.pct,
      tag: isDev ? (['DEV', 'dev'] as const) : r.pct > 3 ? (['WHALE', 'whl'] as const) : null,
    };
  });
  out.push({ w: 'BONDING CURVE', p: Math.max(0, left), tag: ['CURVE', 'bc'], curve: true });
  return out;
}

function toFill(p: ApiFillPayload): Fill {
  return {
    t: p.t,
    sym: p.sym,
    net: p.net,
    buy: p.buy,
    sol: p.sol,
    tok: p.tok,
    mc: p.mc,
    w: p.cb ? 'CASHBACK' : shortAddr(p.w),
    v: p.v,
    ...(p.cb ? { cb: true } : {}),
    ...(p.sig ? { sig: p.sig } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* REST                                                                        */
/* -------------------------------------------------------------------------- */

async function fetchTokens(net: Net): Promise<ApiToken[]> {
  const res = await getJson<ApiTokensResponse>('/tokens?net=' + net + '&limit=500');
  return res.tokens;
}

async function fetchToken(net: Net, sym: string): Promise<ApiToken | null> {
  try {
    return await getJson<ApiToken>('/tokens/' + encodeURIComponent(sym) + '?net=' + net);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* WS — `board` (public), `tape` (public), `token:{sym}` (public per-symbol).  */
/* No generic per-trade `board` update exists (only `token_created`,          */
/* `lane_move`, `koth`, `graduated` — see plan mismatch in the report), so a   */
/* short poll of `GET /tokens` is the fallback that keeps card numbers on     */
/* coins nobody has opened from going stale between those board events.       */
/* -------------------------------------------------------------------------- */

let socket: WebSocket | null = null;
let reconnectTimer = 0;
let pollTimer = 0;
const subscribed = new Set<string>();
let streaming = false;

function wsSend(msg: object): void {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

function subscribeChannel(channel: string): void {
  subscribed.add(channel);
  wsSend({ type: 'subscribe', channel });
}

function unsubscribeChannel(channel: string): void {
  subscribed.delete(channel);
  wsSend({ type: 'unsubscribe', channel });
}

function connectWs(): void {
  if (!streaming || socket) return;
  socket = new WebSocket(WS_URL);
  socket.addEventListener('open', () => {
    for (const channel of subscribed) wsSend({ type: 'subscribe', channel });
  });
  socket.addEventListener('message', (ev) => {
    try {
      onWsFrame(
        JSON.parse(ev.data as string) as { channel: string; data: Record<string, unknown> },
      );
    } catch {
      // A malformed frame is a server bug, not a reason to drop the socket.
    }
  });
  const drop = (): void => {
    socket = null;
    if (streaming) reconnectTimer = window.setTimeout(connectWs, 1500);
  };
  socket.addEventListener('close', drop);
  socket.addEventListener('error', drop);
}

function disconnectWs(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = 0;
  }
  socket?.close();
  socket = null;
}

function onWsFrame(frame: { channel: string; data: Record<string, unknown> }): void {
  const { channel, data } = frame;
  const net = data['net'] as Net | undefined;
  if (net !== undefined && net !== WALLET.net) return;

  if (channel === 'board') return onBoardEvent(data);
  if (channel === 'tape') return onTapeEvent(data);
  if (channel.startsWith('token:')) return onTokenEvent(channel.slice('token:'.length), data);
}

function onBoardEvent(data: Record<string, unknown>): void {
  const sym = data['sym'] as string | undefined;
  switch (data['type']) {
    case 'token_created':
      if (sym && !bySym(sym)) void handleTokenCreated(sym);
      return;
    case 'lane_move': {
      const c = sym ? bySym(sym) : null;
      const to = data['to'] as Lane | undefined;
      if (c && to && c.lane !== to) {
        c.lane = to;
        emit('lane', { sym: c.sym, lane: to });
      }
      return;
    }
    case 'graduated': {
      const c = sym ? bySym(sym) : null;
      if (c && c.lane !== 'grad') {
        c.lane = 'grad';
        emit('lane', { sym: c.sym, lane: 'grad' });
      }
      return;
    }
    case 'koth': {
      const c = sym ? bySym(sym) : null;
      if (c) {
        c.lastMc = c.mc;
        c.mc = data['mc'] as number;
      }
      emit('tick');
      return;
    }
    default:
      return;
  }
}

async function handleTokenCreated(sym: string): Promise<void> {
  const t = await fetchToken(WALLET.net, sym);
  if (!t || bySym(t.sym)) return;
  const c = toSimCoin(t);
  COINS.push(c);
  emit('mint', { sym: c.sym });
}

function onTapeEvent(data: Record<string, unknown>): void {
  if (data['type'] !== 'fill') return;
  const payload = data['payload'] as ApiFillPayload;
  emit('fill', { fill: toFill(payload), animate: true });
}

function onTokenEvent(sym: string, data: Record<string, unknown>): void {
  const c = bySym(sym);
  if (!c) return;
  switch (data['type']) {
    case 'fill': {
      const f = data['payload'] as ApiFillPayload;
      c.lastMc = c.mc;
      c.mc = f.mc;
      pushTrade(c, {
        buy: f.buy,
        sol: f.sol,
        tok: f.tok,
        mc: f.mc,
        cb: !!f.cb,
        w: f.cb ? 'CASHBACK' : shortAddr(f.w),
        v: venueFor(c),
      });
      emit('tick');
      return;
    }
    case 'curve': {
      c.lastMc = c.mc;
      c.mc = data['mc'] as number;
      const lane = data['lane'] as Lane;
      if (lane && c.lane !== lane) {
        c.lane = lane;
        emit('lane', { sym: c.sym, lane });
      } else {
        emit('tick');
      }
      return;
    }
    case 'cashback': {
      const cbStartMs = data['cbStartMs'] as number | null;
      c.cashback = cbStartMs !== null;
      if (cbStartMs !== null) c.cbStart = cbStartMs;
      else delete c.cbStart;
      emit('tick');
      return;
    }
    case 'graduated': {
      if (c.lane !== 'grad') {
        c.lane = 'grad';
        emit('lane', { sym: c.sym, lane: 'grad' });
      }
      return;
    }
    default:
      return;
  }
}

async function refreshBoard(): Promise<void> {
  const net = WALLET.net;
  let list: ApiToken[];
  try {
    list = await fetchTokens(net);
  } catch {
    return; // A transient poll failure is not worth surfacing mid-session.
  }
  if (net !== WALLET.net) return; // The user switched nets while this was in flight.

  let grew = false;
  for (const t of list) {
    const existing = bySym(t.sym);
    if (existing) {
      patchCoin(existing, t);
    } else {
      COINS.push(toSimCoin(t));
      grew = true;
    }
  }
  if (grew) emit('coins');
  else emit('tick');
}

function startPolling(): void {
  stopPolling();
  pollTimer = window.setInterval(() => void refreshBoard(), 5000);
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = 0;
  }
}

/** Seed the tape with the last real fills before the WS starts pushing more. */
async function seedTape(net: Net): Promise<void> {
  try {
    const res = await getJson<ApiTapeResponse>('/tape?net=' + net + '&limit=16');
    for (const f of [...res.fills].reverse()) emit('fill', { fill: toFill(f), animate: false });
  } catch {
    // No tape yet (or the API is still coming up) — the strip stays empty
    // until the next fill arrives over WS.
  }
}

/** Full reload on a net switch: new board, fresh tape seed, same WS/poll. */
async function reloadForNet(net: Net): Promise<void> {
  let list: ApiToken[];
  try {
    list = await fetchTokens(net);
  } catch {
    list = [];
  }
  if (net !== WALLET.net) return;
  COINS.length = 0;
  for (const t of list) COINS.push(toSimCoin(t));
  emit('coins');
  void seedTape(net);
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                     */
/* -------------------------------------------------------------------------- */

export const liveApi: StonkzApi = {
  mode: 'live',

  async ready(): Promise<void> {
    const list = await fetchTokens(WALLET.net);
    COINS.length = 0;
    for (const t of list) COINS.push(toSimCoin(t));
  },

  startStream(): void {
    if (streaming) return;
    streaming = true;
    subscribed.add('board');
    subscribed.add('tape');
    connectWs();
    startPolling();
    void seedTape(WALLET.net);
  },

  stopStream(): void {
    streaming = false;
    stopPolling();
    disconnectWs();
    subscribed.clear();
  },

  async watchToken(c: SimCoin): Promise<void> {
    const net = WALLET.net;
    const [candlesRes, tradesRes, holdersRes] = await Promise.all([
      getJson<ApiCandlesResponse>(`/tokens/${c.sym}/candles?net=${net}&tf=1m&limit=200`).catch(
        () => ({ candles: [] }),
      ),
      getJson<ApiTradesResponse>(`/tokens/${c.sym}/trades?net=${net}&limit=40`).catch(() => ({
        trades: [],
      })),
      getJson<ApiHoldersResponse>(`/tokens/${c.sym}/holders?net=${net}&limit=50`).catch(() => ({
        holders: [],
      })),
    ]);
    applyCandles(c, candlesRes.candles);
    c.trades = tradesRes.trades.map((r) => mapTradeRow(c, r));
    c.liveHolders = mapHolders(c, holdersRes.holders);
    subscribeChannel('token:' + c.sym);
  },

  unwatchToken(sym: string): void {
    unsubscribeChannel('token:' + sym);
  },

  async search(query: string): Promise<SimCoin[]> {
    const q = query.trim();
    if (!q) return [];
    let list: ApiToken[];
    try {
      const res = await getJson<ApiTokensResponse>(
        '/tokens?net=' + WALLET.net + '&q=' + encodeURIComponent(q),
      );
      list = res.tokens;
    } catch {
      return [];
    }
    return list.map((t) => bySym(t.sym) ?? toSimCoin(t));
  },

  /* Trade/launch/game methods stay on the sim implementation, operating on
   * the now-live `COINS`, until Phase 2.C wires the real endpoints. */
  async quote(input: QuoteInput): Promise<Quote> {
    return simApi.quote(input);
  },
  async trade(quote: Quote): Promise<Fill> {
    return simApi.trade(quote);
  },
  async connect(net: Net): Promise<Wallet> {
    // `app/wallet.ts`'s `connectWallet()` calls `selectNet()` — which writes
    // `WALLET.net` — *before* `api.connect()` runs, so there is no earlier
    // value left to diff against here. Always reload for the net being
    // connected to; it is a no-op REST round trip when it turns out to be
    // the same net the board already has loaded.
    const wallet = await simApi.connect(net);
    await reloadForNet(net);
    return wallet;
  },
  disconnect(): void {
    simApi.disconnect();
  },
  async launch(draft: LaunchDraft): Promise<SimCoin> {
    return simApi.launch(draft);
  },
  async claimCreatorFees(sym?: string): Promise<ClaimResult> {
    return simApi.claimCreatorFees(sym);
  },
  async stake(input: StakeInput): Promise<void> {
    return simApi.stake(input);
  },
  async unstake(sym: string): Promise<number> {
    return simApi.unstake(sym);
  },
  async claimStake(sym: string): Promise<StakeClaim> {
    return simApi.claimStake(sym);
  },
  async openCrate(tier: CrateTier): Promise<CrateResult> {
    return simApi.openCrate(tier);
  },
};

/** Where the live adapter points. */
export const API_BASE = BASE;
