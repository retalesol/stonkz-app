import {
  SUPPLY,
  inCashback,
  liq,
  xpForFeeClaim,
  xpForTrade,
  type CrateTier,
  type Fill,
  type Lane,
  type Net,
  type Quote,
  type QuoteHop,
  type Wallet,
} from '@stonkz/shared';
import { authHeader, ensureSession, sessionWallet } from '../app/session.js';
import { signAndConfirm, signPermit, type SellPermit, type SignPayload, type UiStep } from '../app/signer.js';
import { emit } from '../lib/bus.js';
import { shortAddr } from '../lib/fmt.js';
import { openSteps } from '../modals/steps.js';
import { COINS, bySym, pushTrade, toFill as fillFromTrade, type Holder, type SimCoin, type Trade } from '../state/coins.js';
import { creditTokens, noteTrade } from '../state/holdings.js';
import { addXP, saveUser, unlock, USER } from '../state/user.js';
import { NATIVE_PRICE, WALLET, selectNet } from '../state/wallet.js';
import { activeWallet } from '../wallet/index.js';
import { simApi } from './sim.js';
import type {
  ClaimResult,
  CrateResult,
  FeeVault,
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
 * `quote`/`trade`/`connect`/`launch`/`claimCreatorFees`/`claimableFees` are
 * real as of Phase 2.C: `GET /tokens/:sym/quote`, `POST /trade/prepare`,
 * `POST /launch/{prepare,confirm}` and `GET /fees` + `POST
 * /fees/claim/prepare`. `disconnect`/`stake`/`unstake`/`claimStake`/
 * `openCrate` stay on `simApi` — staking, crates and XP ceremonies have no
 * live endpoint yet, which is why `api/index.ts`'s footer disclosure still
 * names them.
 *
 * Every write here needs a session (`app/session.ts`'s SIWS/SIWE JWT, signed
 * by the connected wallet as of Phase B) and a real signature and broadcast
 * (`app/signer.ts`, or `modals/steps.ts` when a plan is more than one step).
 * The prepared transaction that leaves this module is the one the wallet
 * signs, byte for byte — nothing here re-composes a payload.
 *
 * One thing is still local: the post-fill *state patch*. `applyConfirmedTrade`
 * moves the coin's market cap from the numbers `/trade/prepare` composed
 * rather than re-reading the curve off chain, because §2 of
 * `docs/real-vs-simulated.md` is still open — the board's numbers come from
 * the indexer, and the indexer still reads fixtures. The transaction is real;
 * the number that appears a moment later is the API's own arithmetic, and it
 * gets overwritten by the next `refreshBoard()` poll either way.
 *
 * @see plan step 30, plan step 62-70, plan step 95-99
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

/**
 * A structured API failure — `{error, detail}`, `router/errors.ts`'s own
 * wire shape on the server side — surfaced with the same `code` a UI can
 * switch on and a `message` that is already the human `detail`, so a bare
 * `toast(String(err))` reads correctly without the caller special-casing it.
 */
export class LiveApiError extends Error {
  constructor(
    readonly code: string,
    detail: string,
    readonly status: number,
  ) {
    super(detail);
    this.name = 'LiveApiError';
  }
}

async function readErrorBody(res: Response): Promise<{ code: string; detail: string }> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown; detail?: unknown };
  return {
    code: typeof body.error === 'string' ? body.error : 'request_failed',
    detail: typeof body.detail === 'string' ? body.detail : `HTTP ${res.status}`,
  };
}

/** An authenticated `GET` — `/me`, `/fees` — behind the SIWS/SIWE session. */
async function getJsonAuthed<T>(path: string, net: Net): Promise<T> {
  await ensureSession(BASE, net);
  const res = await fetch(BASE + path, { headers: authHeader(net) });
  if (!res.ok) {
    const { code, detail } = await readErrorBody(res);
    throw new LiveApiError(code, detail, res.status);
  }
  return (await res.json()) as T;
}

/** An authenticated `POST` with a JSON body — every write in this module. */
async function postJson<T>(path: string, body: unknown, net: Net): Promise<T> {
  await ensureSession(BASE, net);
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader(net) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const { code, detail } = await readErrorBody(res);
    throw new LiveApiError(code, detail, res.status);
  }
  return (await res.json()) as T;
}

/* -------------------------------------------------------------------------- */
/* Write wire shapes — `apps/api/src/routes/{quote,trade,launch,fees}.ts`      */
/* -------------------------------------------------------------------------- */

/** `EvmStep` in `apps/api/src/router/evm-tx.ts`. Only `description` renders; `to`/`data`/`value` are what a real signer would need. */
interface ApiEvmStep {
  to: string;
  data: string;
  value: string;
  description: string;
}

interface ApiTradePrepareSolAtomic {
  net: 'SOL';
  atomic: true;
  transaction: string;
  lastValidBlockHeight: number;
  quote: Quote;
  expiresAt: number;
}

/**
 * Robinhood's atomic path, once a `StonkzRouter` is configured
 * (`router/evm-router.ts`) — one call, `to`/`data`/`value` like a launch or
 * claim payload, not `transaction` like Solana's signed message. A sell
 * with no `permit` in the request comes back with `permitTypedData` set:
 * the router needs its own approval and this endpoint has no on-chain
 * nonce to sign one against ahead of time (that field's own doc comment in
 * `router/evm-router.ts` explains why), so the caller must sign that
 * EIP-712 permit, resend with `body.permit`, and get a *second* response
 * back with `permitTypedData` absent — still one on-chain transaction
 * either way, just two off-chain signatures for a first-time sell.
 */
interface ApiTradePrepareRhAtomic {
  net: 'RH';
  atomic: true;
  to: string;
  data: string;
  value: string;
  quote: Quote;
  expiresAt: number;
  permitTypedData?: unknown;
  note?: string;
}

/** The still-live fallback for whatever `stonkzRouterDecision` has no route for — `docs/rh-trade-atomicity-gap.md`. */
interface ApiTradePrepareSteps {
  net: Net;
  atomic: false;
  steps: ApiEvmStep[];
  warning: string;
  quote: Quote;
  expiresAt: number;
}

type ApiTradePrepare = ApiTradePrepareSolAtomic | ApiTradePrepareRhAtomic | ApiTradePrepareSteps;

interface ApiLaunchPrepareSol {
  net: 'SOL';
  intentId: string;
  ticker: string;
  predictedMint: string;
  transaction: string;
  lastValidBlockHeight: number;
  devBuy: { native: number; atomic: true } | null;
  expiresAt: number;
}

interface ApiLaunchPrepareRh {
  net: 'RH';
  intentId: string;
  ticker: string;
  predictedMint: null;
  to: string;
  data: string;
  value: string;
  devBuy: { native: number; atomic: false; note: string } | null;
  expiresAt: number;
}

type ApiLaunchPrepare = ApiLaunchPrepareSol | ApiLaunchPrepareRh;

interface ApiLaunchConfirm {
  net: Net;
  sym: string;
  mint: string;
  mc: number;
}

interface ApiFeeVaultRow {
  sym: string;
  unclaimedNative: number;
  unclaimedTokens: number;
  stakerPoolNative: number;
  lifetimeNative: number;
  claimedNative: number;
}

interface ApiFeesResponse {
  net: Net;
  nativeUnit: string;
  vaults: ApiFeeVaultRow[];
}

/** Both chains' `/fees/claim/prepare` are a single signable payload — no `EvmStep[]` here, unlike a trade. */
interface ApiClaimPrepareSol {
  net: 'SOL';
  sym: string;
  transaction: string;
  lastValidBlockHeight: number;
}

interface ApiClaimPrepareRh {
  net: 'RH';
  sym: string;
  to: string;
  data: string;
  value: string;
}

type ApiClaimPrepare = ApiClaimPrepareSol | ApiClaimPrepareRh;

interface ApiMeResponse {
  native: { unit: string; balance: number | null; usdPrice: number | null; usdValue: number | null };
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
  if (channel.startsWith('chat:')) return onChatFrame(channel, data);
}

/* -------------------------------------------------------------------------- */
/* chat (Phase 5.B): views/chat.ts subscribes directly, gated on              */
/* `api.mode === 'live'`, the same seam api/social.ts uses for profiles/wall. */
/* -------------------------------------------------------------------------- */

export interface LiveChatFrame {
  id: number;
  wallet: string;
  text: string;
  createdAtMs: number;
}

const chatHandlers = new Map<string, Set<(msg: LiveChatFrame) => void>>();

function onChatFrame(channel: string, data: Record<string, unknown>): void {
  if (data['type'] !== 'message') return;
  const handlers = chatHandlers.get(channel);
  if (!handlers?.size) return;
  const msg: LiveChatFrame = {
    id: Number(data['id']),
    wallet: String(data['wallet']),
    text: String(data['text']),
    createdAtMs: Number(data['createdAtMs']),
  };
  for (const h of handlers) h(msg);
}

/** Subscribes to a chat room's live messages over the shared WS. Returns an unsubscribe. */
export function subscribeChatRoom(net: Net, room: string, onMessage: (msg: LiveChatFrame) => void): () => void {
  const channel = `chat:${net}:${room}`;
  let set = chatHandlers.get(channel);
  if (!set) {
    set = new Set();
    chatHandlers.set(channel, set);
  }
  set.add(onMessage);
  subscribeChannel(channel);
  return () => {
    set?.delete(onMessage);
    if (set && set.size === 0) {
      chatHandlers.delete(channel);
      unsubscribeChannel(channel);
    }
  };
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
/* Trade — `GET /tokens/:sym/quote`, `POST /trade/prepare`. Plan step 95-96.   */
/* -------------------------------------------------------------------------- */

async function fetchQuote(net: Net, sym: string, side: 'buy' | 'sell', amount: number): Promise<Quote> {
  const qs = `?net=${net}&side=${side}&amount=${amount}`;
  return getJson<Quote>(`/tokens/${encodeURIComponent(sym)}/quote${qs}`);
}

/** An `EvmStep`, a `StonkzRouter` call and an RH launch/claim payload are all the same three fields. */
function evmPayload(call: { to: string; data: string; value: string }): SignPayload {
  return { net: 'RH', to: call.to, data: call.data, value: call.value };
}

function solPayload(prep: { transaction: string; lastValidBlockHeight: number }): SignPayload {
  return { net: 'SOL', transaction: prep.transaction, lastValidBlockHeight: prep.lastValidBlockHeight };
}

/**
 * Walks a `/trade/prepare` response to a real, confirmed transaction.
 *
 * Both chains' single-call atomic paths — Solana's `transaction`, Robinhood
 * `StonkzRouter`'s `to`/`data`/`value` — are one signature, inline, no
 * modal, the same shape as any other wallet prompt. Robinhood's
 * `atomic: false` `EvmStep[]` fallback is never collapsed into that:
 * `modals/steps.ts` opens, shows `plan.warning` verbatim, and makes the
 * trader click through every step in order, each one now genuinely
 * broadcast and confirmed before the next unlocks.
 *
 * A first-time Robinhood *sell* is the one case with more than one signature
 * and still `atomic: true` — the on-chain swap is genuinely one transaction,
 * only the EIP-2612 permit ahead of it is a separate off-chain signature.
 * That permit is real as of Phase B: `wallet/permit.ts` reads
 * `nonces(owner)` off the token contract (the API returns `nonce: null` on
 * purpose — `docs/rh-trade-atomicity-gap.md` §5), gets the wallet to sign the
 * typed data, and the split `{v,r,s}` goes back to `/trade/prepare` as
 * `body.permit`.
 *
 * A rejection propagates to the caller unchanged so a backed-out trade never
 * applies a fill.
 */
async function signTradePlan(
  net: Net,
  prep: ApiTradePrepare,
  title: string,
  sym: string,
  body: Record<string, unknown>,
): Promise<Quote> {
  if (!prep.atomic) {
    const steps: UiStep[] = prep.steps.map((s) => ({
      description: s.description,
      payload: () => evmPayload(s),
    }));
    await openSteps(net, title, steps, prep.warning);
    return prep.quote;
  }
  if (prep.net === 'RH' && prep.permitTypedData) {
    const permitTypedData = prep.permitTypedData;
    // The atomic call is only known after the permit has been signed and the
    // prepare call resent, so step 2 carries both the resend and the payload
    // that resend returns.
    const confirmed: { quote: Quote; call: SignPayload | null; permit: SellPermit | null } = {
      quote: prep.quote,
      call: null,
      permit: null,
    };
    await openSteps(
      net,
      title,
      [
        {
          description: 'Approve StonkzRouter to move ' + sym + ' (EIP-712 permit, off-chain)',
          signOffChain: async () => {
            confirmed.permit = await signPermit(net, permitTypedData);
            return 'permit';
          },
        },
        {
          description: 'Sell on Robinhood Chain via StonkzRouter',
          run: async () => {
            const resent = await postJson<ApiTradePrepare>(
              '/trade/prepare',
              { ...body, permit: confirmed.permit },
              net,
            );
            confirmed.quote = resent.quote;
            confirmed.call = resent.atomic && resent.net === 'RH' ? evmPayload(resent) : null;
          },
          payload: () => confirmed.call,
        },
      ],
      'Two signatures, one transaction: the first is an off-chain permit so the router can move your ' +
        'tokens without a separate approval transaction. Only the second one settles on chain.',
    );
    return confirmed.quote;
  }
  await signAndConfirm(net, prep.net === 'SOL' ? solPayload(prep) : evmPayload(prep));
  return prep.quote;
}

/** Apply a confirmed trade to local state from the exact numbers `/trade/prepare` composed. */
function applyConfirmedTrade(c: SimCoin, side: 'buy' | 'sell', amountIn: number, quote: Quote, net: Net): Fill {
  const buy = side === 'buy';
  // No real chain to read the post-trade curve back from (see this module's
  // header comment) — approximate the price move the same way `sim.ts`'s
  // `trade()` always has, except the size of the move is real: `amountIn`
  // and `liq(c)` both come from this fill, not a random walk.
  const push = (amountIn * NATIVE_PRICE.usd) / Math.max(1, liq(c));
  c.lastMc = c.mc;
  c.mc = Math.max(900, c.mc * (1 + (buy ? push : -push) * 0.55));
  const tok = buy ? quote.amountOut : (quote.hops[0] as QuoteHop).inAmount;
  const t = pushTrade(c, {
    buy,
    sol: amountIn,
    tok,
    mc: c.mc,
    w: shortAddr(sessionWallet(net)),
    v: quote.routeLabel,
  });
  noteTrade(c, buy, amountIn);
  addXP(xpForTrade(amountIn), (buy ? 'BUY ' : 'SELL ') + c.sym);
  unlock('first');
  if (amountIn * NATIVE_PRICE.usd >= 1000) unlock('whale');
  if (inCashback(c)) unlock('cashback');
  emit('coins');
  return fillFromTrade(c, t);
}

async function liveTrade(quote: Quote): Promise<Fill> {
  const c = bySym(quote.sym);
  if (!c) throw new Error('unknown ticker ' + quote.sym);
  const net = quote.net;
  const body = { sym: quote.sym, side: quote.side, amount: quote.amountIn };
  const prep = await postJson<ApiTradePrepare>('/trade/prepare', body, net);
  const title = (quote.side === 'buy' ? 'BUY ' : 'SELL ') + c.sym + (net === 'RH' ? ' \u00b7 ROBINHOOD CHAIN' : '');
  const confirmedQuote = await signTradePlan(net, prep, title, c.sym, body);
  return applyConfirmedTrade(c, quote.side, quote.amountIn, confirmedQuote, net);
}

/* -------------------------------------------------------------------------- */
/* Launch — `POST /launch/prepare` + `/launch/confirm`. Plan step 97.         */
/* -------------------------------------------------------------------------- */

async function liveLaunch(draft: LaunchDraft): Promise<SimCoin> {
  const net = WALLET.net;
  const prep = await postJson<ApiLaunchPrepare>(
    '/launch/prepare',
    {
      ticker: draft.sym,
      name: draft.name,
      descr: draft.desc,
      uri: '',
      supply: Number(draft.supply),
      feePct: draft.tfee,
      cashback: draft.cashback,
      baseSymbol: draft.base,
      devBuyNative: net === 'SOL' ? draft.buy : 0,
    },
    net,
  );
  // Solana's create and Robinhood's `createToken` calldata are each a
  // single signable payload — one signature, inline, the same as an atomic
  // trade. Only a Robinhood dev buy (below) is ever a second one.
  //
  // `/launch/confirm` looks this signature up *on chain* to decode the mint
  // out of the creation log, so it is the one endpoint that could never have
  // worked against the old fabricated signature at all.
  const { signature } = await signAndConfirm(
    net,
    prep.net === 'SOL' ? solPayload(prep) : evmPayload(prep),
  );
  const confirmed = await postJson<ApiLaunchConfirm>(
    '/launch/confirm',
    { intentId: prep.intentId, signature },
    net,
  );

  const mc = confirmed.mc;
  const c: SimCoin = {
    id: COINS.length,
    sym: confirmed.sym,
    name: draft.name || confirmed.sym,
    desc: draft.desc,
    mc,
    chg: 0,
    reps: 0,
    hold: 0,
    age: 0,
    seed: (Math.random() * 1e6) | 0,
    dev: shortAddr(sessionWallet(net)),
    lane: 'new',
    lastMc: mc,
    el: null,
    h: null,
    hv: null,
    trades: null,
    comments: null,
    mine: true,
    fee: 0,
    supply: Number(draft.supply),
    base: draft.base,
    tfee: draft.tfee,
    net,
    cashback: draft.cashback,
    ...(draft.cashback ? { cbStart: Date.now() } : {}),
    ...(draft.x ? { x: draft.x } : {}),
    ...(draft.web ? { web: draft.web } : {}),
    ...(draft.tg ? { tg: draft.tg } : {}),
  };
  COINS.unshift(c);

  // Robinhood's mint address is only known after `/launch/confirm` decodes
  // the `TokenCreated` log (plain `CREATE`, not `CREATE2` — `routes/launch.ts`'s
  // header comment), so a dev buy there is necessarily a *second*,
  // independent `/trade/prepare` call, not part of the launch transaction.
  if (net === 'RH' && draft.buy > 0) {
    try {
      const quote = await fetchQuote(net, c.sym, 'buy', draft.buy);
      await liveTrade(quote);
    } catch (err) {
      // The token is live even if the follow-up dev buy failed or was
      // cancelled — surface it as its own toast-worthy failure, not a
      // reason to unwind a launch that already confirmed on-chain.
      c.hold = 0;
      throw new LiveApiError(
        err instanceof LiveApiError ? err.code : 'dev_buy_failed',
        `${c.sym} launched, but the dev buy did not go through: ${err instanceof Error ? err.message : String(err)}`,
        0,
      );
    }
  } else if (draft.buy > 0) {
    // Solana's dev buy is atomic with the create — it already landed by the
    // time `/launch/confirm` returned, so mirror it into the trades tab.
    c.hold = 1;
    pushTrade(c, { buy: true, sol: draft.buy, mine: true });
    noteTrade(c, true, draft.buy);
  }

  addXP(150, 'LAUNCH ' + c.sym);
  if (draft.cashback) addXP(150, 'CASHBACK LAUNCH');
  unlock('deploy');
  emit('coins');
  return c;
}

/* -------------------------------------------------------------------------- */
/* Claim — `GET /fees` + `POST /fees/claim/prepare`. Plan step 98.            */
/* -------------------------------------------------------------------------- */

async function fetchFeeVaults(net: Net): Promise<ApiFeeVaultRow[]> {
  const res = await getJsonAuthed<ApiFeesResponse>('/fees', net);
  return res.vaults;
}

async function liveClaimableFees(): Promise<FeeVault[]> {
  const net = WALLET.net;
  let vaults: ApiFeeVaultRow[];
  try {
    vaults = await fetchFeeVaults(net);
  } catch {
    return [];
  }
  return vaults
    .filter((v) => v.unclaimedNative > 0 || v.unclaimedTokens > 0)
    .map((v) => ({ sym: v.sym, native: v.unclaimedNative, tokens: v.unclaimedTokens }));
}

/**
 * Claims one or every vault with a claimable balance. A single sym is one
 * signature, inline, same as an atomic Solana trade; more than one is a
 * sequence of independent transactions — one claim per coin, each its own
 * signature — so it goes through the same `modals/steps.ts` walker Robinhood
 * trades use, for the same reason: never collapse multiple signatures into
 * something that reads like one.
 */
async function liveClaimCreatorFees(sym?: string): Promise<ClaimResult> {
  const net = WALLET.net;
  const vaults = await fetchFeeVaults(net);
  const targets = (sym ? vaults.filter((v) => v.sym === sym) : vaults).filter(
    (v) => v.unclaimedNative > 0 || v.unclaimedTokens > 0,
  );
  if (targets.length === 0) return { native: 0, tokens: {} };

  const prepareClaim = async (v: ApiFeeVaultRow): Promise<SignPayload> => {
    const prep = await postJson<ApiClaimPrepare>('/fees/claim/prepare', { sym: v.sym }, net);
    return prep.net === 'SOL' ? solPayload(prep) : evmPayload(prep);
  };

  if (targets.length === 1) {
    // One vault, one signature — inline, same as an atomic Solana trade.
    await signAndConfirm(net, await prepareClaim(targets[0] as ApiFeeVaultRow));
  } else {
    // Each vault is its own independent transaction; `run` prepares vault
    // *i*'s payload right before it is signed, not all of them up front —
    // the same ordering a fresh `/trade/prepare` per RH step would need if
    // this endpoint ever grew one.
    const title = 'CLAIM CREATOR FEES \u00b7 ' + targets.length + ' COINS';
    const pending: { payload: SignPayload | null } = { payload: null };
    await openSteps(
      net,
      title,
      targets.map((v) => ({
        description: 'Claim ' + v.sym + ' fees',
        run: async () => {
          pending.payload = await prepareClaim(v);
        },
        payload: () => pending.payload,
      })),
      undefined,
    );
  }

  const res: ClaimResult = { native: 0, tokens: {} };
  for (const v of targets) {
    res.native += v.unclaimedNative;
    if (v.unclaimedTokens > 0) {
      res.tokens[v.sym] = (res.tokens[v.sym] ?? 0) + v.unclaimedTokens;
      creditTokens(v.sym, v.unclaimedTokens);
    }
  }
  if (res.native > 0) {
    WALLET.sol += res.native;
    USER.feesClaimed = (USER.feesClaimed ?? 0) + res.native;
    addXP(xpForFeeClaim(res.native), 'FEE CLAIM');
    saveUser();
    emit('wallet');
  }
  return res;
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

  async quote(input: QuoteInput): Promise<Quote> {
    const net = input.coin.net ?? WALLET.net;
    return fetchQuote(net, input.coin.sym, input.side, input.amountIn);
  },
  async trade(quote: Quote): Promise<Fill> {
    return liveTrade(quote);
  },
  async connect(net: Net): Promise<Wallet> {
    // `app/wallet.ts`'s `connectWallet()` calls `selectNet()` — which writes
    // `WALLET.net` — *before* `api.connect()` runs, so there is no earlier
    // value left to diff against here. Always reload for the net being
    // connected to; it is a no-op REST round trip when it turns out to be
    // the same net the board already has loaded.
    selectNet(net);
    WALLET.on = true;
    const wallet = activeWallet();
    if (wallet?.net === net) {
      // Show the connected wallet's real address immediately, before the
      // sign-in round trip: it is already known and already true.
      WALLET.addr = shortAddr(wallet.address);
      WALLET.full = wallet.address;
      WALLET.provider = wallet.label;
    }
    try {
      const session = await ensureSession(BASE, net);
      WALLET.addr = shortAddr(session.wallet);
      WALLET.full = session.wallet;
      const me = await getJsonAuthed<ApiMeResponse>('/me', net).catch(() => null);
      // Prefer the server's read (it uses the operator's provider endpoint,
      // not the public rate-limited RPC), and fall back to asking the wallet's
      // own chain client directly.
      WALLET.sol = me?.native.balance ?? (await wallet?.nativeBalance().catch(() => null)) ?? 0;
      // The footer's USD figure is the connected chain's own price, not a
      // constant that reads $214.08 next to an ETH balance.
      if (me?.native.usdPrice) NATIVE_PRICE.usd = me.native.usdPrice;
    } catch {
      // No session yet (API unreachable, signature declined) — the board
      // still loads; every authenticated write below fails loudly on its own.
      WALLET.sol = (await wallet?.nativeBalance().catch(() => null)) ?? 0;
    }
    emit('wallet');
    await reloadForNet(net);
    return WALLET;
  },
  disconnect(): void {
    simApi.disconnect();
  },
  async launch(draft: LaunchDraft): Promise<SimCoin> {
    return liveLaunch(draft);
  },
  async claimableFees(): Promise<FeeVault[]> {
    return liveClaimableFees();
  },
  async claimCreatorFees(sym?: string): Promise<ClaimResult> {
    return liveClaimCreatorFees(sym);
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
