import {
  SUPPLY,
  CRATES,
  inCashback,
  liq,
  type AchievementKey,
  type CrateTier,
  type Fill,
  type Lane,
  type Net,
  type Quote,
  type Settings,
  type Wallet,
  crateBy,
  RAR,
  isEvm,
} from '@stonkz/shared';
import {
  authHeader,
  clearSession,
  ensureSession,
  invalidateAccessToken,
  sessionWallet,
} from '../app/session.js';
import { signAndConfirm, signPermit, type SellPermit, type SignPayload } from '../app/signer.js';
import { emit } from '../lib/bus.js';
import { clock, shortAddr } from '../lib/fmt.js';
import { openSteps } from '../modals/steps.js';
import {
  COINS,
  byMint,
  bySym,
  pushTrade,
  toFill as fillFromTrade,
  type Holder,
  type SimCoin,
  type Trade,
  type TradeHop,
} from '../state/coins.js';
import { creditTokens, holdOf, noteTrade, HOLD } from '../state/holdings.js';
import { syncHoldingFromChain } from './live-holding.js';
import { ensureStake, stakeOf } from '../state/stake.js';
import { rememberIdentity } from '../lib/identity.js';
import {
  USER,
  hydrateRewards,
  pushDrop,
  resetLiveRewards,
  saveUser,
  unlock,
} from '../state/user.js';
import { applySettings, saveSettings, settingsPayload } from '../state/settings.js';
import { fillCandleGaps, mergeFillIntoSeries } from '../lib/candles.js';
import { NATIVE_PRICE, WALLET, selectNet } from '../state/wallet.js';
import { activeWallet } from '../wallet/index.js';
import { fetchRewards, openCrateLive, type LiveRewardsSnapshot } from './social.js';
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
 * The live adapter — read path (plan step 62-70) plus write path.
 *
 * `ready()`, `startStream()`/`stopStream()`, `watchToken()`/`unwatchToken()`
 * and `search()` are real: they replace `COINS`/`RAW`, `histOf`/`seedSeries`,
 * `seedTrades`/`holdersOf` and the tape/KOTH random generators with
 * `GET /tokens`, `GET /tokens/:sym/{candles,trades,holders}`, `GET /tape` and
 * the `board`/`tape`/`token:{sym}` WS channels.
 *
 * Writes (`quote`/`trade`/`connect`/`launch`/`claimCreatorFees`/`claimableFees`/
 * `stake`/`unstake`/`claimStake`/`openCrate`) hit the API. Staking prepares
 * real program instructions; settlement still awaits program deploy (§3).
 * Crates and XP hydrate from `GET /rewards` — never from the sim seed.
 *
 * Every write here needs a session (`app/session.ts`'s SIWS/SIWE JWT, signed
 * by the connected wallet as of Phase B) and a real signature and broadcast
 * (`app/signer.ts`, or `modals/steps.ts` when a plan is more than one step).
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
  image?: string;
  mint?: string;
  tradeable?: boolean;
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
  sig?: string;
  /** Base-asset amount when known (curve hop size). */
  base?: number;
}

interface ApiTradesResponse {
  trades: ApiTradeRow[];
}

interface ApiHolderRow {
  wallet: string;
  amount: number;
  pct: number;
  costNative?: number;
  curve?: boolean;
}

interface ApiHoldersResponse {
  holders: ApiHolderRow[];
  holderCount?: number;
  source?: 'explorer' | 'rpc' | 'db';
  /** Launchpad / curve vault address when known (RH). */
  curveWallet?: string;
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
  if (!res.ok) {
    const { code, detail } = await readErrorBody(res);
    throw new LiveApiError(code, detail || `GET ${path} -> ${res.status}`, res.status);
  }
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
    readonly retryAfterMs?: number,
  ) {
    super(detail);
    this.name = 'LiveApiError';
  }
}

async function readErrorBody(
  res: Response,
): Promise<{ code: string; detail: string; retryAfterMs?: number }> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: unknown;
    detail?: unknown;
    retryAfterMs?: unknown;
  };
  return {
    code: typeof body.error === 'string' ? body.error : 'request_failed',
    detail: typeof body.detail === 'string' ? body.detail : `HTTP ${res.status}`,
    ...(typeof body.retryAfterMs === 'number' && Number.isFinite(body.retryAfterMs)
      ? { retryAfterMs: body.retryAfterMs }
      : {}),
  };
}

/** An authenticated `GET` — `/me`, `/fees` — behind the SIWS/SIWE session. */
async function getJsonAuthed<T>(path: string, net: Net): Promise<T> {
  await ensureSession(BASE, net);
  let res = await fetch(BASE + path, { headers: authHeader(net) });
  if (res.status === 401) {
    invalidateAccessToken();
    await ensureSession(BASE, net);
    res = await fetch(BASE + path, { headers: authHeader(net) });
  }
  if (!res.ok) {
    const { code, detail } = await readErrorBody(res);
    throw new LiveApiError(code, detail, res.status);
  }
  return (await res.json()) as T;
}

/** An authenticated `POST` with a JSON body — every write in this module. */
async function postJson<T>(path: string, body: unknown, net: Net): Promise<T> {
  await ensureSession(BASE, net);
  let res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader(net) },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    invalidateAccessToken();
    await ensureSession(BASE, net);
    res = await fetch(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader(net) },
      body: JSON.stringify(body),
    });
  }
  if (!res.ok) {
    const { code, detail, retryAfterMs } = await readErrorBody(res);
    throw new LiveApiError(code, detail, res.status, retryAfterMs);
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
  net: 'RH' | 'BASE';
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
  mint?: string;
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
  username?: string | null;
  bio?: string | null;
  avatarUrl?: string | null;
  native: {
    unit: string;
    balance: number | null;
    usdPrice: number | null;
    usdValue: number | null;
  };
  settings?: {
    slip: number;
    prio: number;
    mev: string;
    mevTip: number;
    cap: number;
    defBuy: number;
    confirm: boolean;
  } | null;
}

/* -------------------------------------------------------------------------- */
/* Mapping — API wire shapes -> the same `SimCoin`/`Trade`/`Holder` the        */
/* renderer already patches. The wire format mirrors `Coin` on purpose        */
/* (`apps/api/src/routes/serialise.ts`), so this is a reshape, not a guess.    */
/* -------------------------------------------------------------------------- */

function isApiToken(t: unknown): t is ApiToken {
  return !!t && typeof t === 'object' && typeof (t as ApiToken).sym === 'string';
}

function toSimCoin(t: ApiToken): SimCoin {
  return {
    id: t.id ?? t.seed ?? 0,
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
    ...(t.image ? { image: t.image } : {}),
    ...(t.mint ? { mint: t.mint } : {}),
    ...(t.tradeable !== undefined ? { tradeable: t.tradeable } : {}),
    el: null,
    h: null,
    hv: null,
    trades: null,
    comments: null,
    liveHolders: null,
  };
}

/** Match by mint when present so duplicate tickers stay distinct. */
function findCoin(identity: { sym: string; mint?: string | null | undefined }): SimCoin | null {
  if (identity.mint) {
    const hit = byMint(identity.mint);
    if (hit) return hit;
  }
  return bySym(identity.sym);
}

function mergeToken(t: ApiToken): SimCoin {
  const existing = findCoin(t);
  if (existing) {
    patchCoin(existing, t);
    return existing;
  }
  const coin = toSimCoin(t);
  COINS.push(coin);
  return coin;
}

function mintQs(c: { mint?: string }): string {
  return c.mint ? `&mint=${encodeURIComponent(c.mint)}` : '';
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
  if (t.mint) c.mint = t.mint;
  if (t.tradeable !== undefined) c.tradeable = t.tradeable;
  const prevLane = c.lane;
  c.lane = t.lane;
  if (prevLane !== t.lane) emit('lane', { sym: c.sym, lane: t.lane });
}

/** Candle closes -> the market-cap series `drawTokenChart` already draws. */
function applyCandles(c: SimCoin, candles: ApiCandle[]): void {
  const supply = c.supply || SUPPLY;
  const filled = fillCandleGaps(
    candles.map((k) => ({ t: k.t, c: k.c, v: k.v })),
    60_000,
  );
  c.h = filled.map((k) => k.c * supply);
  c.hv = filled.map((k) => k.v);
}

function venueFor(c: SimCoin): string {
  if (c.lane === 'grad') return 'DEX';
  const net = c.net ?? 'SOL';
  const base = (c.base || '').toUpperCase();
  const native = isEvm(net) ? 'ETH' : 'SOL';
  const wrapped = isEvm(net) ? 'WETH' : 'WSOL';
  if (!base || base === native || base === wrapped) return 'CURVE';
  return isEvm(net) ? 'UNISWAP \u2192 CURVE' : 'JUPITER \u2192 CURVE';
}

/** Rebuild hop legs for a fill when the quote is gone but the base is known. */
function hopsForTrade(
  c: SimCoin,
  side: 'buy' | 'sell',
  nativeInOut: number,
  tok: number,
  baseAmt?: number,
): TradeHop[] | undefined {
  const route = venueFor(c);
  if (!route.includes('\u2192')) return undefined;
  const net = c.net ?? 'SOL';
  const native = isEvm(net) ? 'ETH' : 'SOL';
  const base = (c.base || (net === 'RH' ? 'USDG' : net === 'BASE' ? 'USDC' : 'BASE')).toUpperCase();
  const agg = isEvm(net) ? 'UNISWAP' : 'JUPITER';
  const mid = baseAmt && baseAmt > 0 ? baseAmt : nativeInOut;
  if (side === 'buy') {
    return [
      { venue: agg, inSymbol: native, outSymbol: base, inAmount: nativeInOut, outAmount: mid },
      { venue: 'CURVE', inSymbol: base, outSymbol: c.sym, inAmount: mid, outAmount: tok },
    ];
  }
  return [
    { venue: 'CURVE', inSymbol: c.sym, outSymbol: base, inAmount: tok, outAmount: mid },
    { venue: agg, inSymbol: base, outSymbol: native, inAmount: mid, outAmount: nativeInOut },
  ];
}

function hopsFromQuote(quote: Quote): TradeHop[] | undefined {
  if (!quote.hops.length || quote.hops.length < 2) return undefined;
  return quote.hops.map((h) => ({
    venue: h.venue,
    inSymbol: h.inSymbol,
    outSymbol: h.outSymbol,
    inAmount: h.inAmount,
    outAmount: h.outAmount,
  }));
}

function mapTradeRow(c: SimCoin, r: ApiTradeRow): Trade {
  const side = r.buy ? 'buy' : 'sell';
  const hops = hopsForTrade(c, side, r.sol, r.tok, r.base);
  return {
    t: new Date(r.t),
    buy: r.buy,
    sol: r.sol,
    tok: r.tok,
    mc: r.mc,
    cb: !!r.cb,
    w: r.cb ? 'CASHBACK' : shortAddr(r.w),
    ...(r.cb ? {} : { addr: r.w }),
    v: venueFor(c),
    ...(hops ? { hops } : {}),
    ...(r.sig ? { sig: r.sig } : {}),
  };
}

function mapHolders(c: SimCoin, rows: ApiHolderRow[], curveWallet?: string): Holder[] {
  const curveAddr = (
    curveWallet ||
    import.meta.env['VITE_RH_LAUNCHPAD_ADDRESS'] ||
    ''
  ).toLowerCase();
  let covered = 0;
  let sawCurve = false;

  const out: Holder[] = rows.map((r) => {
    covered += r.pct;
    const addr = (r.wallet || '').toLowerCase();
    const isCurve = !!r.curve || (!!curveAddr && addr === curveAddr);
    if (isCurve) sawCurve = true;
    const isDev =
      !isCurve &&
      !!c.dev &&
      (r.wallet === c.dev || (!!c.mint && r.wallet === c.mint) || addr === c.dev.toLowerCase());
    return {
      w: isCurve ? 'BONDING CURVE' : shortAddr(r.wallet),
      ...(isCurve ? {} : { addr: r.wallet }),
      p: r.pct,
      tag: isCurve
        ? (['CURVE', 'bc'] as const)
        : isDev
          ? (['DEV', 'dev'] as const)
          : r.pct > 3
            ? (['WHALE', 'whl'] as const)
            : null,
      ...(isCurve ? { curve: true as const } : {}),
    };
  });

  // Residual only when the API omitted the vault and a meaningful share is
  // unaccounted for — never invent a 0% CURVE row beside a mis-tagged whale.
  const left = 100 - covered;
  if (!sawCurve && left > 0.5) {
    out.push({ w: 'BONDING CURVE', p: left, tag: ['CURVE', 'bc'], curve: true });
  }
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

/** Disconnected guests see both chains; a connected wallet scopes the board. */
type BoardScope = Net | 'ALL';

function boardScope(): BoardScope {
  return WALLET.on ? WALLET.net : 'ALL';
}

async function fetchTokens(net: BoardScope): Promise<ApiToken[]> {
  try {
    const res = await getJson<ApiTokensResponse>('/tokens?net=' + net + '&limit=500');
    return Array.isArray(res.tokens) ? res.tokens.filter(isApiToken) : [];
  } catch {
    return [];
  }
}

/** Footer SOL + ETH marks from `GET /native-price`. */
async function refreshNativePrices(): Promise<void> {
  try {
    const res = await getJson<{ SOL: number | null; ETH: number | null }>('/native-price');
    if (typeof res.SOL === 'number' && res.SOL > 0) NATIVE_PRICE.sol = res.SOL;
    if (typeof res.ETH === 'number' && res.ETH > 0) NATIVE_PRICE.eth = res.ETH;
    NATIVE_PRICE.usd = isEvm(WALLET.net) ? NATIVE_PRICE.eth : NATIVE_PRICE.sol;
    emit('tick');
  } catch {
    // Keep last marks; the footer just stays stale until the next poll.
  }
}

async function fetchToken(net: Net, sym: string, mint?: string): Promise<ApiToken | null> {
  try {
    const qs = mint ? `&mint=${encodeURIComponent(mint)}` : '';
    return await getJson<ApiToken>('/tokens/' + encodeURIComponent(sym) + '?net=' + net + qs);
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
  const scope = boardScope();
  // Guest board is cross-chain; connected board only accepts the wallet's net.
  if (net !== undefined && scope !== 'ALL' && net !== scope) return;

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
  username?: string | null;
  avatarUrl?: string | null;
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
    username: data['username'] != null ? String(data['username']) : null,
    avatarUrl: data['avatarUrl'] != null ? String(data['avatarUrl']) : null,
  };
  for (const h of handlers) h(msg);
}

/** Subscribes to a chat room's live messages over the shared WS. Returns an unsubscribe. */
export function subscribeChatRoom(
  net: Net,
  room: string,
  onMessage: (msg: LiveChatFrame) => void,
): () => void {
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
  const payload = (data['payload'] as Record<string, unknown> | undefined) ?? {};
  const mint =
    (typeof data['mint'] === 'string' ? data['mint'] : undefined) ||
    (typeof payload['mint'] === 'string' ? payload['mint'] : undefined);
  const eventNet = (data['net'] as Net | undefined) ?? WALLET.net;
  switch (data['type']) {
    case 'token_created':
      if (sym && !findCoin({ sym, mint })) void handleTokenCreated(sym, eventNet, mint);
      return;
    case 'lane_move': {
      const c = sym ? findCoin({ sym, mint }) : null;
      const to = data['to'] as Lane | undefined;
      if (c && to && c.lane !== to) {
        c.lane = to;
        emit('lane', { sym: c.sym, lane: to });
      }
      return;
    }
    case 'graduated': {
      const c = sym ? findCoin({ sym, mint }) : null;
      if (c && c.lane !== 'grad') {
        c.lane = 'grad';
        emit('lane', { sym: c.sym, lane: 'grad' });
      }
      return;
    }
    case 'koth': {
      const c = sym ? findCoin({ sym, mint }) : null;
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

async function handleTokenCreated(sym: string, net: Net, mint?: string): Promise<void> {
  const t = await fetchToken(net, sym, mint);
  if (!t || findCoin(t)) return;
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
  const mint = typeof data['mint'] === 'string' ? data['mint'] : undefined;
  const c = findCoin({ sym, mint });
  if (!c) return;
  switch (data['type']) {
    case 'fill': {
      const f = data['payload'] as ApiFillPayload;
      c.lastMc = c.mc;
      c.mc = f.mc;
      const side = f.buy ? 'buy' : 'sell';
      const hops = hopsForTrade(c, side, f.sol, f.tok);
      pushTrade(c, {
        buy: f.buy,
        sol: f.sol,
        tok: f.tok,
        mc: f.mc,
        cb: !!f.cb,
        w: f.cb ? 'CASHBACK' : shortAddr(f.w),
        ...(f.cb ? {} : { addr: f.w }),
        v: venueFor(c),
        ...(hops ? { hops } : {}),
        ...(f.sig ? { sig: f.sig } : {}),
      });
      // Keep the open chart moving with the tape — merge into the last bucket
      // so we do not invent a new "candle" per fill.
      if (c.h && c.hv) {
        mergeFillIntoSeries(c.h, c.hv, f.mc, f.sol * (NATIVE_PRICE.usd || 0));
        if (c.h.length > 240) {
          c.h.shift();
          c.hv.shift();
        }
      }
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
  const scope = boardScope();
  let list: ApiToken[];
  try {
    list = await fetchTokens(scope);
  } catch {
    return; // A transient poll failure is not worth surfacing mid-session.
  }
  if (scope !== boardScope()) return; // Connect/disconnect (or net switch) while in flight.

  let grew = false;
  for (const t of list) {
    const before = COINS.length;
    mergeToken(t);
    if (COINS.length > before) grew = true;
  }
  // Connected scope is a filter — drop coins from the other chain that lingered.
  if (scope !== 'ALL') {
    for (let i = COINS.length - 1; i >= 0; i--) {
      const c = COINS[i]!;
      if (c.net && c.net !== scope) {
        COINS.splice(i, 1);
        grew = true;
      }
    }
  }
  if (grew) emit('coins');
  else emit('tick');
}

function startPolling(): void {
  stopPolling();
  let n = 0;
  pollTimer = window.setInterval(() => {
    void refreshBoard();
    // Native marks change slowly — refresh every ~30s with the board poll.
    if (++n % 6 === 0) void refreshNativePrices();
  }, 5000);
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = 0;
  }
}

/** Seed the tape with the last real fills before the WS starts pushing more. */
async function seedTape(net: BoardScope): Promise<void> {
  emit('tapeClear');
  try {
    const res = await getJson<ApiTapeResponse>('/tape?net=' + net + '&limit=16');
    if (net !== boardScope()) return;
    for (const f of [...res.fills].reverse()) emit('fill', { fill: toFill(f), animate: false });
  } catch {
    // No tape yet (or the API is still coming up) — the strip stays empty
    // until the next fill arrives over WS.
  }
}

/** Full reload for connect / disconnect / net switch: new board + tape seed. */
async function reloadBoard(scope: BoardScope): Promise<void> {
  let list: ApiToken[];
  try {
    list = await fetchTokens(scope);
  } catch {
    list = [];
  }
  if (scope !== boardScope()) return;
  COINS.length = 0;
  for (const t of list) COINS.push(toSimCoin(t));
  emit('coins');
  void seedTape(scope);
}

/* -------------------------------------------------------------------------- */
/* Trade — `GET /tokens/:sym/quote`, `POST /trade/prepare`. Plan step 95-96.   */
/* -------------------------------------------------------------------------- */

async function fetchQuote(
  net: Net,
  sym: string,
  side: 'buy' | 'sell',
  amount: number,
  mint?: string,
): Promise<Quote> {
  const qs = `?net=${net}&side=${side}&amount=${amount}${mint ? `&mint=${encodeURIComponent(mint)}` : ''}`;
  return getJson<Quote>(`/tokens/${encodeURIComponent(sym)}/quote${qs}`);
}

/** An `EvmStep`, a `StonkzRouter` call and an RH/Base launch/claim payload are all the same three fields. */
function evmPayload(
  call: { to: string; data: string; value: string },
  net: 'RH' | 'BASE' = 'RH',
): SignPayload {
  return { net, to: call.to, data: call.data, value: call.value };
}

function solPayload(prep: { transaction: string; lastValidBlockHeight: number }): SignPayload {
  return {
    net: 'SOL',
    transaction: prep.transaction,
    lastValidBlockHeight: prep.lastValidBlockHeight,
  };
}

/**
 * Walks a `/trade/prepare` response to a real, confirmed transaction.
 *
 * Both chains' single-call atomic paths — Solana's `transaction`, Robinhood
 * `StonkzRouter`'s `to`/`data`/`value` — are one signature, inline, no
 * modal. The API refuses non-atomic RH prepares (`rh_router_required`); if a
 * stale client still receives `atomic: false`, fail here instead of walking
 * a multi-signature step plan that can strand intermediate assets.
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
): Promise<{ quote: Quote; signature: string | null }> {
  if (!prep.atomic) {
    throw new LiveApiError(
      'rh_router_required',
      prep.warning ?? 'atomic StonkzRouter required; non-atomic RH trades are disabled',
      422,
    );
  }
  if (isEvm(prep.net) && 'permitTypedData' in prep && prep.permitTypedData) {
    const permitTypedData = prep.permitTypedData;
    // The atomic call is only known after the permit has been signed and the
    // prepare call resent, so step 2 carries both the resend and the payload
    // that resend returns.
    const confirmed: { quote: Quote; call: SignPayload | null; permit: SellPermit | null } = {
      quote: prep.quote,
      call: null,
      permit: null,
    };
    const last = await openSteps(
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
            confirmed.call =
              resent.atomic && isEvm(resent.net) && 'to' in resent
                ? evmPayload(resent, resent.net)
                : null;
          },
          payload: () => confirmed.call,
        },
      ],
      'Two signatures, one transaction: the first is an off-chain permit so the router can move your ' +
        'tokens without a separate approval transaction. Only the second one settles on chain.',
    );
    return { quote: confirmed.quote, signature: last.signature };
  }
  const { signature } = await signAndConfirm(
    net,
    prep.net === 'SOL' ? solPayload(prep) : evmPayload(prep, isEvm(prep.net) ? prep.net : 'RH'),
  );
  return { quote: prep.quote, signature };
}

/** Apply a confirmed trade to local state from the exact numbers `/trade/prepare` composed. */
function applyConfirmedTrade(
  c: SimCoin,
  side: 'buy' | 'sell',
  amountIn: number,
  quote: Quote,
  net: Net,
  signature?: string,
): Fill {
  const buy = side === 'buy';
  // Buy: amountIn is native. Sell: amountIn is tokens; native out is amountOut.
  // Never credit `WALLET.sol` with the token quantity — that is what made RH
  // sells paint "BALANCE 6.7M ETH" after dumping RHLIVE.
  const nativeAmt = buy ? amountIn : quote.amountOut;
  const tokAmt = buy ? quote.amountOut : amountIn;
  // Prefer server `/trade/confirm` + chain sync for the next quote; the local
  // mc nudge is display-only until the board refresh lands.
  const push = (nativeAmt * NATIVE_PRICE.usd) / Math.max(1, liq(c));
  c.lastMc = c.mc;
  c.mc = Math.max(900, c.mc * (1 + (buy ? push : -push) * 0.55));
  const hops = hopsFromQuote(quote) ?? hopsForTrade(c, side, nativeAmt, tokAmt);
  const t = pushTrade(c, {
    buy,
    sol: nativeAmt,
    tok: tokAmt,
    mc: c.mc,
    w: shortAddr(sessionWallet(net)),
    addr: sessionWallet(net),
    v: quote.routeLabel || venueFor(c),
    ...(hops ? { hops } : {}),
    ...(signature ? { sig: signature } : {}),
  });
  noteTrade(c, buy, nativeAmt, tokAmt);
  // XP is server-authoritative in live mode — `addXP` is a no-op, and the
  // ledger credits on the matching chain_events row once the indexer sees it.
  unlock('first');
  if (nativeAmt * NATIVE_PRICE.usd >= 1000) unlock('whale');
  if (inCashback(c)) unlock('cashback');
  emit('coins');
  // Prefer the chain balance over optimistic math — MetaMask is the truth.
  if (isEvm(net) && c.mint) {
    void syncHoldingFromChain(c, sessionWallet(net));
  }
  void refreshNativeBalance(net);
  return fillFromTrade(c, t);
}

/** Re-read gas balance from `/me` or the wallet RPC after a fill. */
async function refreshNativeBalance(net: Net): Promise<void> {
  try {
    const me = await getJsonAuthed<{ native: { balance: number } }>('/me', net).catch(() => null);
    if (me && Number.isFinite(me.native.balance)) {
      WALLET.sol = Math.max(0, me.native.balance);
      emit('wallet');
      return;
    }
  } catch {
    // Fall through to the wallet client.
  }
  try {
    const wallet = activeWallet();
    if (wallet?.net === net) {
      const bal = await wallet.nativeBalance();
      if (bal !== null && Number.isFinite(bal)) {
        WALLET.sol = Math.max(0, bal);
        emit('wallet');
      }
    }
  } catch {
    // Keep the optimistic noteTrade update if both reads fail.
  }
}

async function liveTrade(quote: Quote): Promise<Fill> {
  const c = findCoin({ sym: quote.sym, mint: quote.mint }) || bySym(quote.sym);
  if (!c) throw new Error('unknown ticker ' + quote.sym);
  const net = quote.net;
  const body = {
    sym: quote.sym,
    ...(c.mint ? { mint: c.mint } : {}),
    side: quote.side,
    amount: quote.amountIn,
    ...settingsPayload(),
  };
  const prep = await postJson<ApiTradePrepare>('/trade/prepare', body, net);
  const title =
    (quote.side === 'buy' ? 'BUY ' : 'SELL ') +
    c.sym +
    (net === 'RH' ? ' \u00b7 ROBINHOOD CHAIN' : net === 'BASE' ? ' \u00b7 BASE' : '');
  const { quote: confirmedQuote, signature } = await signTradePlan(net, prep, title, c.sym, body);
  // Re-sync curve reserves from chain so the next sell quote is not stuck on
  // empty DB reserves if the indexer lags.
  if (signature) {
    void postJson(
      '/trade/confirm',
      { sym: c.sym, ...(c.mint ? { mint: c.mint } : {}), signature, txHash: signature },
      net,
    ).catch(() => undefined);
  }
  return applyConfirmedTrade(
    c,
    quote.side,
    quote.amountIn,
    confirmedQuote,
    net,
    signature ?? undefined,
  );
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
      uri: draft.uri?.trim() || '',
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
    prep.net === 'SOL' ? solPayload(prep) : evmPayload(prep, isEvm(prep.net) ? prep.net : 'RH'),
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
    ...(confirmed.mint ? { mint: confirmed.mint, tradeable: true } : {}),
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
    ...(draft.uri ? { image: draft.uri } : {}),
  };
  COINS.unshift(c);

  // Robinhood's mint address is only known after `/launch/confirm` decodes
  // the `TokenCreated` log (plain `CREATE`, not `CREATE2` — `routes/launch.ts`'s
  // header comment), so a dev buy there is necessarily a *second*,
  // independent `/trade/prepare` call, not part of the launch transaction.
  if (isEvm(net) && draft.buy > 0) {
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
    const prep = await postJson<ApiClaimPrepare>(
      '/fees/claim/prepare',
      { sym: v.sym, ...(v.mint ? { mint: v.mint } : {}) },
      net,
    );
    return prep.net === 'SOL'
      ? solPayload(prep)
      : evmPayload(prep, isEvm(prep.net) ? prep.net : 'RH');
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
    saveUser();
    emit('wallet');
  }
  return res;
}

/* -------------------------------------------------------------------------- */
/* Rewards hydrate + crates                                                    */
/* -------------------------------------------------------------------------- */

function applyRewardsSnap(snap: LiveRewardsSnapshot): void {
  hydrateRewards({
    xp: snap.xp,
    sp: snap.sp,
    optionz: snap.optionz,
    streak: snap.streak,
    crates: snap.crates.map((c) => ({
      tier: c.tier as CrateTier,
      readyAt: c.readyAt,
      inventory: c.inventory ?? 0,
    })),
    ...(snap.spLevel
      ? {
          spLevel: {
            level: snap.spLevel.level,
            next: snap.spLevel.next,
            pct: snap.spLevel.pct,
            toNext: snap.spLevel.toNext,
          },
        }
      : {}),
    dropLog: snap.dropLog.map((d) => ({ at: d.at, tier: d.tier, label: d.label })),
    achievements: snap.achievements.map((a) => ({
      key: a.key as AchievementKey,
      unlockedAt: a.unlockedAt,
    })),
  });
}

async function hydrateLiveRewards(net: Net): Promise<void> {
  try {
    const snap = await fetchRewards(net);
    applyRewardsSnap(snap);
  } catch {
    // Guest / declined sign-in — stay at empty guest ledger.
  }
}

async function liveOpenCrate(tier: CrateTier): Promise<CrateResult> {
  const net = WALLET.net;
  const res = await openCrateLive(net, tier);
  const crate = crateBy(tier);
  const dropIndex = Math.max(
    0,
    RAR.findIndex((r) => r[0] === res.rarity),
  );
  const kind: 'S' | 'I' = res.item ? 'I' : 'S';
  const out: CrateResult = {
    tier,
    kind,
    amount: res.optionz,
    item: res.item ?? '',
    label: res.label,
    dropIndex: dropIndex < 0 ? 0 : dropIndex,
    xp: res.xp,
  };
  USER.optionz = res.optionzTotal;
  // Global cooldown — stamp every tier before hydrate in case re-fetch fails.
  if (!USER.crates) USER.crates = {};
  for (const c of CRATES) USER.crates[c.k] = res.readyAt;
  if (!USER.crateInventory) USER.crateInventory = {};
  USER.crateInventory[tier] = res.inventoryLeft;
  if (crate) pushDrop({ t: clock(), k: tier, r: res.label, col: crate.col });
  saveUser();
  // Re-hydrate rank/XP from the server so ceremonies match the ledger.
  await hydrateLiveRewards(net);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Stake — prepare + sign; settlement awaits program deploy                    */
/* -------------------------------------------------------------------------- */

interface ApiStakePrepareSol {
  net: 'SOL';
  sym: string;
  action: string;
  transaction: string;
  lastValidBlockHeight: number;
  amount?: number;
  days?: number;
}

interface ApiStakePrepareEvm {
  net: 'RH' | 'BASE';
  sym: string;
  action: string;
  to: string;
  data: string;
  value: string;
  amount?: number;
  days?: number;
  atomic?: boolean;
  warning?: string;
  steps?: { to: string; data: string; value: string; label?: string }[];
}

type ApiStakePrepare = ApiStakePrepareSol | ApiStakePrepareEvm;

async function liveStake(input: StakeInput): Promise<void> {
  const net = WALLET.net;
  const coin = bySym(input.sym);
  const prep = await postJson<ApiStakePrepare>(
    '/stake/prepare',
    {
      sym: input.sym,
      ...(coin?.mint ? { mint: coin.mint } : {}),
      amount: input.amount,
      days: input.days,
    },
    net,
  );
  if (prep.net === 'SOL') {
    await signAndConfirm(net, solPayload(prep));
  } else if (prep.steps && prep.steps.length > 0) {
    await openSteps(
      net,
      'STAKE ' + input.sym,
      prep.steps.map((s) => ({
        description: s.label || 'Confirm stake step',
        payload: () => evmPayload(s, isEvm(prep.net) ? prep.net : 'RH'),
      })),
      prep.warning,
    );
  } else {
    await signAndConfirm(net, evmPayload(prep, isEvm(prep.net) ? prep.net : 'RH'));
  }
  const c = bySym(input.sym);
  if (!c) return;
  const st = ensureStake(input.sym);
  const h = holdOf(input.sym);
  const amt = Math.min(input.amount, h ? h.tok : 0);
  if (amt <= 0) return;
  st.amt += amt;
  st.days = input.days;
  st.mult = input.mult;
  st.until = input.days ? Date.now() + input.days * 24 * 60 * 60 * 1000 : 0;
  if (h) {
    h.cost *= Math.max(0, 1 - amt / h.tok);
    h.tok -= amt;
    if (h.tok < 1) HOLD.splice(HOLD.indexOf(h), 1);
  }
  saveUser();
  emit('portfolio');
  await hydrateLiveStake(input.sym);
}

async function liveUnstake(sym: string): Promise<number> {
  const st = stakeOf(sym);
  if (!st || st.amt <= 0) return 0;
  if (st.until && Date.now() < st.until) {
    throw new LiveApiError(
      'still_locked',
      'LOCKED UNTIL ' + new Date(st.until).toLocaleDateString(),
      422,
    );
  }
  const amt = st.amt;
  const net = WALLET.net;
  const coin = bySym(sym);
  const prep = await postJson<ApiStakePrepare>(
    '/stake/unstake/prepare',
    { sym, ...(coin?.mint ? { mint: coin.mint } : {}), amount: amt },
    net,
  );
  await signAndConfirm(
    net,
    prep.net === 'SOL' ? solPayload(prep) : evmPayload(prep, isEvm(prep.net) ? prep.net : 'RH'),
  );
  st.amt = 0;
  st.mult = 1;
  st.days = 0;
  st.until = 0;
  creditTokens(sym, amt);
  saveUser();
  await hydrateLiveStake(sym);
  return amt;
}

async function liveClaimStake(sym: string): Promise<StakeClaim> {
  const net = WALLET.net;
  await hydrateLiveStake(sym);
  const st = stakeOf(sym);
  // Always attempt the on-chain claim — pending rewards live on the program,
  // not only in the indexer columns. Local zeros must not block a claim.
  const prep = await postJson<ApiStakePrepare>(
    '/stake/claim/prepare',
    { sym, ...(bySym(sym)?.mint ? { mint: bySym(sym)!.mint } : {}) },
    net,
  );
  await signAndConfirm(
    net,
    prep.net === 'SOL' ? solPayload(prep) : evmPayload(prep, isEvm(prep.net) ? prep.net : 'RH'),
  );
  const out: StakeClaim = { tokens: st?.rewTok ?? 0, native: st?.rewSol ?? 0 };
  if (out.tokens > 0) creditTokens(sym, out.tokens);
  if (out.native > 0) WALLET.sol += out.native;
  if (st) {
    st.rewTok = 0;
    st.rewSol = 0;
  }
  await hydrateLiveStake(sym);
  saveUser();
  emit('wallet');
  return out;
}

interface ApiStakeRow {
  amt: number;
  mult: number;
  days: number;
  until: number;
  rewTok: number;
  rewSol: number;
}

async function hydrateLiveStake(sym: string): Promise<void> {
  const net = WALLET.net;
  try {
    const mint = bySym(sym)?.mint;
    const qs = mint ? `?mint=${encodeURIComponent(mint)}` : '';
    const row = await getJsonAuthed<ApiStakeRow>(`/stake/${encodeURIComponent(sym)}${qs}`, net);
    const st = ensureStake(sym);
    st.amt = row.amt;
    st.mult = row.mult;
    st.days = row.days;
    st.until = row.until;
    st.rewTok = row.rewTok;
    st.rewSol = row.rewSol;
    saveUser();
    emit('portfolio');
  } catch {
    /* leave local stake as-is */
  }
}

async function pushLiveSettings(settings: Settings): Promise<void> {
  applySettings(settings);
  saveSettings();
  await ensureSession(BASE, WALLET.net);
  const res = await fetch(BASE + '/me/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeader(WALLET.net) },
    body: JSON.stringify(settings),
  });
  if (!res.ok) {
    const { code, detail } = await readErrorBody(res);
    throw new LiveApiError(code, detail, res.status);
  }
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                     */
/* -------------------------------------------------------------------------- */

export const liveApi: StonkzApi = {
  mode: 'live',

  async ready(): Promise<void> {
    // Guests land on both chains; connect() narrows to the wallet's net.
    await refreshNativePrices();
    const list = await fetchTokens(boardScope());
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
    void seedTape(boardScope());
    void refreshNativePrices();
  },

  stopStream(): void {
    streaming = false;
    stopPolling();
    disconnectWs();
    subscribed.clear();
  },

  async watchToken(c: SimCoin): Promise<void> {
    const net = c.net ?? WALLET.net;
    const mq = mintQs(c);
    const [candlesRes, tradesRes, holdersRes] = await Promise.all([
      getJson<ApiCandlesResponse>(`/tokens/${c.sym}/candles?net=${net}&tf=1m&limit=200${mq}`).catch(
        () => ({ candles: [] }),
      ),
      getJson<ApiTradesResponse>(`/tokens/${c.sym}/trades?net=${net}&limit=40${mq}`).catch(() => ({
        trades: [],
      })),
      getJson<ApiHoldersResponse>(`/tokens/${c.sym}/holders?net=${net}&limit=50${mq}`).catch(
        (): ApiHoldersResponse => ({ holders: [] }),
      ),
    ]);
    applyCandles(c, candlesRes.candles);
    c.trades = tradesRes.trades.map((r) => mapTradeRow(c, r));
    c.liveHolders = mapHolders(c, holdersRes.holders, holdersRes.curveWallet);
    if (typeof holdersRes.holderCount === 'number') {
      c.hold = holdersRes.holderCount;
    } else {
      c.hold = holdersRes.holders.filter((h) => !h.curve).length;
    }
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
        '/tokens?net=' + boardScope() + '&q=' + encodeURIComponent(q),
      );
      list = Array.isArray(res.tokens) ? res.tokens.filter(isApiToken) : [];
    } catch (err) {
      throw err instanceof Error ? err : new Error('search_failed');
    }
    // Merge into COINS so route apply() / byMint()/bySym() can open tokens that
    // were not on the initial board page.
    return list.map((t) => mergeToken(t));
  },

  async quote(input: QuoteInput): Promise<Quote> {
    const net = input.coin.net ?? WALLET.net;
    return fetchQuote(net, input.coin.sym, input.side, input.amountIn, input.coin.mint);
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
    // Profile is per-wallet. Clear before SIWE so a prior Solana username
    // cannot paint the RH chip while /me is in flight.
    delete USER.name;
    delete USER.bio;
    delete USER.avatarUrl;
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
      if (me?.settings) {
        applySettings({
          ...me.settings,
          mev:
            me.settings.mev === 'OFF' || me.settings.mev === 'RELAY' || me.settings.mev === 'SHIELD'
              ? me.settings.mev
              : 'SHIELD',
        });
        saveSettings();
      } else if (me) {
        // /me succeeded but no settings row yet — seed from this device.
        // Do not push when /me itself failed (me === null); that would
        // clobber a good server row after a transient error.
        void pushLiveSettings(settingsPayload()).catch(() => undefined);
      }
      // Prefer the server's read (it uses the operator's provider endpoint,
      // not the public rate-limited RPC), and fall back to asking the wallet's
      // own chain client directly.
      WALLET.sol = me?.native.balance ?? (await wallet?.nativeBalance().catch(() => null)) ?? 0;
      // Keep both footer marks fresh; `usd` tracks the connected chain.
      await refreshNativePrices();
      if (me?.native.usdPrice) {
        NATIVE_PRICE.usd = me.native.usdPrice;
        if (isEvm(net)) NATIVE_PRICE.eth = me.native.usdPrice;
        else NATIVE_PRICE.sol = me.native.usdPrice;
      }
      if (me) {
        // Always replace profile fields for this wallet — never keep a prior
        // net's username (e.g. Solana "Mememan") after an RH SIWE session.
        if (me.username) USER.name = me.username;
        else delete USER.name;
        if (me.bio) USER.bio = me.bio;
        else delete USER.bio;
        if (me.avatarUrl) USER.avatarUrl = me.avatarUrl;
        else delete USER.avatarUrl;
        rememberIdentity(session.wallet, {
          username: me.username ?? null,
          avatarUrl: me.avatarUrl ?? null,
        });
        saveUser();
      } else {
        delete USER.name;
        delete USER.bio;
        delete USER.avatarUrl;
        saveUser();
      }
      await hydrateLiveRewards(net);
    } catch {
      // No session yet (API unreachable, signature declined) — the board
      // still loads; every authenticated write below fails loudly on its own.
      WALLET.sol = (await wallet?.nativeBalance().catch(() => null)) ?? 0;
    }
    emit('wallet');
    // Narrow the cross-chain guest board to this wallet's network.
    await reloadBoard(net);
    return WALLET;
  },
  disconnect(): void {
    // Tokens are cleared by `logoutSession` / `clearSession` at the call site
    // (explicit disconnect vs wallet revoke). Avoid a second logout race here.
    clearSession();
    resetLiveRewards();
    simApi.disconnect();
    // Back to the guest board: Solana + Robinhood together.
    void reloadBoard('ALL');
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
    return liveStake(input);
  },
  async unstake(sym: string): Promise<number> {
    return liveUnstake(sym);
  },
  async claimStake(sym: string): Promise<StakeClaim> {
    return liveClaimStake(sym);
  },
  async pushSettings(settings): Promise<void> {
    return pushLiveSettings(settings);
  },
  async hydrateStake(sym: string): Promise<void> {
    return hydrateLiveStake(sym);
  },
  async openCrate(tier: CrateTier): Promise<CrateResult> {
    return liveOpenCrate(tier);
  },
};

/** Where the live adapter points. */
export const API_BASE = BASE;
