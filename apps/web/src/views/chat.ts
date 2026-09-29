import { hash, rng } from '@stonkz/shared';
import { api } from '../api/index.js';
import {
  type LiveChatFrame,
  type LiveChatStatus,
  onChatRoomStatus,
  subscribeChatRoom,
  wsAuthenticate,
} from '../api/live.js';
import {
  SocialApiError,
  fetchChatAccess,
  fetchChatHistory,
  sendChatMessage,
} from '../api/social.js';
import { ensureSession, hasSession, sessionWallet } from '../app/session.js';
import { toast } from '../fx/toast.js';
import { paintAvatar } from '../lib/avatar.js';
import { on } from '../lib/bus.js';
import { $, $$, must } from '../lib/dom.js';
import { ARR, clock, shortAddr } from '../lib/fmt.js';
import { type FocusTrap, trapFocus } from '../lib/focus-trap.js';
import { type Html, attr, html, node, render } from '../lib/html.js';
import { avatarUrlOf, displayName, rememberIdentity } from '../lib/identity.js';
import { reducedMotion } from '../lib/motion.js';
import {
  CHAT,
  type ChatMsg,
  GLINES,
  HANDLES,
  TLINES,
  bumpUnread,
  clearUnread,
  logFor,
  randomHandle,
  unreadIn,
} from '../state/chat.js';
import type { SimCoin } from '../state/coins.js';
import { WALLET } from '../state/wallet.js';
import {
  type ChatAccess,
  composerState,
  holderNotice,
  isPrivateRoom,
  liveRoomKey,
  privateRoomOf,
  roomLabel,
  roomSym,
  roomTitle,
} from './chat-access.js';

const API_BASE = import.meta.env['VITE_API_URL'] ?? '';
/** How often an open drawer re-asks the gate, so "$X SO FAR" keeps moving. */
const ACCESS_POLL_MS = 30_000;

/**
 * The chat drawer.
 *
 * Three rooms when a token page is open: GLOBAL, the public `$SYM` room and
 * the holders-only `$SYM (PRIVATE)` room. Live mode uses history + WS frames
 * that carry username / avatarUrl; own messages always show the set username
 * (or short address) — never "YOU".
 *
 * Access is server-decided (`GET /chat/:net/:room/access`, refused posts and
 * WS control frames); this file only renders the verdict: the composer's
 * "TRADE $100 TO UNLOCK CHAT · $X SO FAR" progress and the private room's
 * "HOLD $5 OF $SYM TO ENTER" lock.
 */

let trap: FocusTrap | null = null;
let loop = 0;
let liveUnsub: (() => void) | null = null;
let statusUnsub: (() => void) | null = null;
let accessTimer = 0;
/** Which room's join is the current one; a slow async join for an old room must not attach. */
let joinSeq = 0;
const liveHistoryLoaded = new Set<string>();

export function roomOf(c: { sym: string }): string {
  return '$' + c.sym;
}

function colorFor(wallet: string): string {
  return (HANDLES[hash(wallet) % HANDLES.length] as [string, string])[1];
}

function live(): boolean {
  return api.mode === 'live';
}

function currentAccess(room = CHAT.room): ChatAccess | null {
  return CHAT.access[room] ?? null;
}

function pushLiveFrame(
  room: string,
  wallet: string,
  text: string,
  createdAtMs: number,
  isLive: boolean,
  meta?: { username?: string | null; avatarUrl?: string | null },
): void {
  if (meta?.username || meta?.avatarUrl) {
    rememberIdentity(wallet, {
      username: meta.username ?? null,
      avatarUrl: meta.avatarUrl ?? null,
    });
  }
  const mine = wallet === sessionWallet(WALLET.net) || wallet === WALLET.full;
  addChat(
    room,
    {
      who: displayName(wallet),
      col: mine ? '#ffa22b' : colorFor(wallet),
      text,
      mine,
      t: clock(new Date(createdAtMs)),
      wallet,
      avatarUrl: meta?.avatarUrl ?? avatarUrlOf(wallet),
    },
    isLive,
  );
}

/* ------------------------------------------------------------------ access */

function setAccess(room: string, access: ChatAccess | null): void {
  CHAT.access[room] = access;
  if (room === CHAT.room) {
    renderComposer();
    chatChips();
  }
}

/** A lock the socket reported before any HTTP access call came back. */
function lockedAccess(room: string, partial?: Record<string, unknown>): ChatAccess {
  const sym = roomSym(room);
  const p = partial ?? {};
  return {
    room: liveRoomKey(room),
    kind: isPrivateRoom(room) ? 'private' : sym ? 'token' : 'global',
    sym,
    signedIn: true,
    canRead: !isPrivateRoom(room),
    canPost: false,
    reason: isPrivateRoom(room) ? 'holder_required' : 'volume_required',
    volumeUsd: typeof p['volumeUsd'] === 'number' ? p['volumeUsd'] : null,
    volumeRequiredUsd: typeof p['volumeRequiredUsd'] === 'number' ? p['volumeRequiredUsd'] : 100,
    holdingUsd: typeof p['holdingUsd'] === 'number' ? p['holdingUsd'] : null,
    holdingRequiredUsd: typeof p['holdingRequiredUsd'] === 'number' ? p['holdingRequiredUsd'] : 5,
  };
}

/** Re-asks the server for `room`'s gate; a private room that just unlocked is joined. */
async function refreshAccess(room = CHAT.room): Promise<void> {
  if (!live() || !WALLET.on) return;
  const net = WALLET.net;
  const wasReadable = currentAccess(room)?.canRead ?? !isPrivateRoom(room);
  try {
    if (!hasSession(net) && isPrivateRoom(room)) await ensureSession(API_BASE, net);
    const access = await fetchChatAccess(net, liveRoomKey(room));
    setAccess(room, access);
    if (isPrivateRoom(room) && access.canRead && !wasReadable && room === CHAT.room) {
      joinLiveRoom(room);
    }
  } catch {
    // Leave whatever we had; the composer stays in its last state.
  }
}

function startAccessPolling(): void {
  stopAccessPolling();
  if (!live()) return;
  accessTimer = window.setInterval(() => {
    if (CHAT.open) void refreshAccess();
  }, ACCESS_POLL_MS);
}

function stopAccessPolling(): void {
  if (accessTimer) clearInterval(accessTimer);
  accessTimer = 0;
}

/* -------------------------------------------------------------- live rooms */

function onRoomStatus(room: string, status: LiveChatStatus): void {
  if (status.type === 'subscribed') return;
  const code = status.error ?? status.reason ?? '';
  if (code !== 'holder_required' && code !== 'unauthorized' && code !== 'unknown_token') return;
  const access = status.access
    ? (status.access as unknown as ChatAccess)
    : lockedAccess(room, status.access);
  if (code === 'unknown_token') access.reason = 'unknown_token';
  // Evicted or refused: nothing in this room may stay on screen.
  CHAT.logs[room] = [];
  liveHistoryLoaded.delete(room);
  setAccess(room, access);
  if (status.type === 'unsubscribed') {
    toast(status.message ?? holderNotice(roomSym(room) ?? ''), 'red');
    if (room === CHAT.room) chatRender();
  }
}

function loadHistory(room: string, seq: number): void {
  if (liveHistoryLoaded.has(room)) return;
  liveHistoryLoaded.add(room);
  fetchChatHistory(WALLET.net, liveRoomKey(room))
    .then((res) => {
      if (seq !== joinSeq && room !== CHAT.room) return;
      if (!logFor(room).length) {
        for (const m of res.messages) {
          pushLiveFrame(room, m.wallet, m.text, m.createdAtMs, false, {
            username: m.username ?? null,
            avatarUrl: m.avatarUrl ?? null,
          });
        }
        if (CHAT.room === room) chatRender();
      }
    })
    .catch((err: unknown) => {
      liveHistoryLoaded.delete(room);
      const code = err instanceof SocialApiError ? err.code : '';
      if (code === 'holder_required' || code === 'unauthorized' || code === 'unknown_token') {
        const a = lockedAccess(room);
        if (code === 'unknown_token') a.reason = 'unknown_token';
        setAccess(room, a);
      }
      /* otherwise: empty room until live frames arrive */
    });
}

/** Joins `room`'s live channel and, the first time, backfills its history. */
function joinLiveRoom(room: string): void {
  leaveLiveRoom();
  const seq = ++joinSeq;
  const net = WALLET.net;
  const key = liveRoomKey(room);
  statusUnsub = onChatRoomStatus(net, key, (status) => onRoomStatus(room, status));

  const frameHandler = (msg: LiveChatFrame): void =>
    pushLiveFrame(room, msg.wallet, msg.text, msg.createdAtMs, true, {
      username: msg.username ?? null,
      avatarUrl: msg.avatarUrl ?? null,
    });

  if (!isPrivateRoom(room)) {
    liveUnsub = subscribeChatRoom(net, key, frameHandler);
    loadHistory(room, seq);
    return;
  }

  // The holders' room needs the wallet on the socket before the subscribe.
  if (!WALLET.on) return;
  void (async () => {
    try {
      if (!hasSession(net)) await ensureSession(API_BASE, net);
    } catch {
      return;
    }
    if (seq !== joinSeq) return;
    wsAuthenticate(net);
    liveUnsub = subscribeChatRoom(net, key, frameHandler);
    loadHistory(room, seq);
  })();
}

function leaveLiveRoom(): void {
  liveUnsub?.();
  liveUnsub = null;
  statusUnsub?.();
  statusUnsub = null;
}

/* ---------------------------------------------------------------- render */

function chatTitle(): void {
  must('#chatTitle').textContent = roomTitle(CHAT.room);
  must('#chatOnline').textContent = live()
    ? 'LIVE'
    : (CHAT.room === 'GLOBAL' ? 41 : 8 + (hash(CHAT.room) % 60)) + ' ONLINE';
}

function chipHTML(room: string, opts: { back?: boolean; locked?: boolean } = {}): Html {
  const n = CHAT.room === room ? 0 : unreadIn(CHAT, room);
  const cls =
    'room' + (CHAT.room === room ? ' on' : '') + (opts.locked ? ' locked' : '') + (n ? ' has' : '');
  return html`<button
    class="${cls}"
    data-room="${attr(room)}"
    aria-pressed="${CHAT.room === room ? 'true' : 'false'}"
    title="${attr(opts.locked ? holderNotice(roomSym(room) ?? '') : roomLabel(room))}"
  >
    ${opts.back ? ARR + ' ' : ''}${opts.locked ? html`<i class="lk" aria-hidden="true"></i>` : ''}${roomLabel(
      room,
    )}${n ? html`<b class="rb">${n > 99 ? '99+' : n}</b>` : ''}
  </button>`;
}

function chatChips(): void {
  const back = !!CHAT.token && CHAT.room !== 'GLOBAL';
  const chips: Html[] = [chipHTML('GLOBAL', { back })];
  if (CHAT.token) {
    const pub = '$' + CHAT.token.sym;
    const priv = privateRoomOf(CHAT.token.sym);
    const a = currentAccess(priv);
    const locked = live() && (!WALLET.on || !a || !a.canRead);
    chips.push(chipHTML(pub), chipHTML(priv, { locked }));
  }
  render(must('#rooms'), html`${chips}`);
}

function msgHTML(m: ChatMsg): Html {
  const seed = m.wallet || m.who;
  return html`<div class="cm${m.mine ? ' mine' : ''}${m.sys ? ' sys' : ''}">
    ${
      m.sys
        ? ''
        : html`<canvas
              class="av"
              width="28"
              height="28"
              data-seed="${attr(String(seed))}"
              data-av="${attr(m.avatarUrl || '')}"
              aria-hidden="true"
            ></canvas>
            <div class="who" style="color:${attr(m.col || '#4d9bff')}">
              ${m.who}<span>${m.t || clock()}</span>
            </div>`
    }
    <p>${m.text}</p>
  </div>`;
}

function paintChatAvatars(root: ParentNode = must('#chatLog')): void {
  for (const cv of $$<HTMLCanvasElement>('canvas.av', root as ParentNode)) {
    paintAvatar(cv, {
      seed: cv.dataset['seed'] || '0',
      avatarUrl: cv.dataset['av'] || null,
      size: 28,
    });
  }
}

function lockHTML(notice: string, sub: string): Html {
  return html`<div class="chat-lock" role="status">
    <div class="chat-lock-ico" aria-hidden="true"></div>
    <b>${notice}</b>
    <span>${sub}</span>
  </div>`;
}

/** The gate bar above the input, the input itself and the send button. */
function renderComposer(): void {
  const form = $('#chatForm');
  if (!form) return;
  const input = must<HTMLInputElement>('#chatInput');
  const send = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  const gate = ensureGateBar(form);
  const state = composerState({
    room: CHAT.room,
    live: live(),
    walletOn: WALLET.on,
    access: currentAccess(),
  });

  input.disabled = state.disabled;
  input.placeholder = state.placeholder;
  if (send) send.disabled = state.disabled;
  form.classList.toggle('gated', state.disabled);
  form.dataset['mode'] = state.mode;

  if (!state.notice) {
    gate.hidden = true;
    render(gate, html``);
    return;
  }
  gate.hidden = false;
  gate.dataset['mode'] = state.mode;
  const pct = state.progress === null ? null : Math.round(state.progress * 100);
  render(
    gate,
    html`<span class="chat-gate-txt">${state.notice}</span>${
        pct === null
          ? ''
          : html`<span
              class="chat-gate-bar"
              role="progressbar"
              aria-valuemin="0"
              aria-valuemax="100"
              aria-valuenow="${pct}"
              ><i style="width:${pct}%"></i
            ></span>`
      }`,
  );
}

function ensureGateBar(form: Element): HTMLElement {
  let gate = $<HTMLElement>('#chatGate');
  if (!gate) {
    gate = document.createElement('div');
    gate.id = 'chatGate';
    gate.className = 'chat-gate';
    gate.hidden = true;
    form.before(gate);
  }
  return gate;
}

export function chatRender(): void {
  chatTitle();
  chatChips();
  const log = must('#chatLog');
  const state = composerState({
    room: CHAT.room,
    live: live(),
    walletOn: WALLET.on,
    access: currentAccess(),
  });
  if (state.hidesLog) {
    const sym = roomSym(CHAT.room) ?? '';
    const sub =
      state.mode === 'connect'
        ? 'CONNECT YOUR WALLET TO PROVE THE POSITION'
        : state.mode === 'loading'
          ? 'CHECKING YOUR POSITION…'
          : state.mode === 'unavailable'
            ? 'THIS TOKEN IS NOT INDEXED YET'
            : `HOLDERS OF $${sym} ONLY. BUY ON THE CURVE AND YOU ARE IN.`;
    render(log, lockHTML(state.notice ?? holderNotice(sym), sub));
  } else {
    render(log, html`${logFor(CHAT.room).map(msgHTML)}`);
    paintChatAvatars(log);
  }
  log.scrollTop = log.scrollHeight;
  renderComposer();
}

/** Append one message. `isLive` marks it as arriving now rather than replayed. */
export function addChat(room: string, m: ChatMsg, isLive = false): void {
  m.t = m.t || clock();
  if (m.mine && !m.who) {
    m.who = displayName(WALLET.full || WALLET.addr);
  }
  if (m.mine && !m.wallet) m.wallet = WALLET.full || WALLET.addr;
  if (m.mine && m.avatarUrl === undefined) m.avatarUrl = avatarUrlOf(m.wallet || WALLET.full);
  const l = logFor(room);
  l.push(m);
  if (l.length > 90) l.shift();
  const visible = room === CHAT.room && CHAT.open;
  if (room === CHAT.room) {
    const state = composerState({
      room,
      live: live(),
      walletOn: WALLET.on,
      access: currentAccess(room),
    });
    if (!state.hidesLog) {
      const log = must('#chatLog');
      const near = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
      const el = node(msgHTML(m));
      if (isLive && !reducedMotion()) el.classList.add('in');
      log.appendChild(el);
      paintChatAvatars(el);
      while (log.children.length > 90) log.removeChild(log.firstChild as ChildNode);
      if (near || m.mine) log.scrollTop = log.scrollHeight;
    }
  }
  if (isLive && !visible && !m.mine) {
    bumpUnread(CHAT, room);
    paintUnread();
    if (room !== CHAT.room) chatChips();
  }
}

function paintUnread(): void {
  const u = must('#unread');
  if (CHAT.unread > 0) {
    u.hidden = false;
    u.textContent = CHAT.unread > 99 ? '99+' : String(CHAT.unread);
  } else {
    u.hidden = true;
  }
}

function chatSwitch(room: string): void {
  if (room === CHAT.room) return;
  CHAT.room = room;
  if (CHAT.open) {
    clearUnread(CHAT, room);
    paintUnread();
  }
  if (live()) {
    if (isPrivateRoom(room) && !currentAccess(room)?.canRead) {
      // Locked (or unknown): ask the server first; a yes triggers the join.
      leaveLiveRoom();
      void refreshAccess(room);
    } else {
      joinLiveRoom(room);
      void refreshAccess(room);
    }
  }
  chatRender();
}

/** Give the drawer a token's rooms, or take them away when the token page closes. */
export function setChatToken(c: SimCoin | null): void {
  const previous = CHAT.token?.sym ?? null;
  CHAT.token = c ? { sym: c.sym, seed: c.seed } : null;
  if (c) {
    const r = roomOf(c);
    const p = privateRoomOf(c.sym);
    if (!CHAT.logs[p]) CHAT.logs[p] = [];
    if (!CHAT.logs[r]) {
      CHAT.logs[r] = [];
      if (!live()) {
        const rr = rng(c.seed + 17);
        for (let i = 0; i < 3; i++) {
          const h = HANDLES[(rr() * HANDLES.length) | 0] as [string, string];
          logFor(r).push({
            who: h[0],
            col: h[1],
            text: (TLINES[(rr() * TLINES.length) | 0] as string).replace(/\$SYM/g, '$' + c.sym),
            t: String(9 + i) + ':' + String(12 + i * 7).padStart(2, '0'),
          });
        }
      }
    }
    CHAT.room = r;
    if (live() && previous !== c.sym) {
      // The holders' room is gated per token: forget the last token's verdict.
      delete CHAT.access[p];
      void refreshAccess(p);
    }
  } else {
    CHAT.room = 'GLOBAL';
  }
  if (CHAT.open) {
    clearUnread(CHAT, CHAT.room);
    paintUnread();
  }
  if (live()) {
    joinLiveRoom(CHAT.room);
    void refreshAccess(CHAT.room);
  }
  chatRender();
}

export function chatOpen(v: boolean): void {
  CHAT.open = v;
  must('#drawer').classList.toggle('open', v);
  must('#chatScrim').classList.toggle('open', v);
  must('#chatTab').setAttribute('aria-expanded', v ? 'true' : 'false');
  if (v) {
    clearUnread(CHAT, CHAT.room);
    paintUnread();
    chatChips();
    const log = must('#chatLog');
    log.scrollTop = log.scrollHeight;
    trap = trapFocus(must('#drawer'), must('#chatTab'));
    setTimeout(() => $('#chatInput')?.focus(), 220);
    void refreshAccess();
    startAccessPolling();
  } else {
    stopAccessPolling();
    if (trap) {
      trap.release();
      trap = null;
    }
  }
}

export function isChatOpen(): boolean {
  return CHAT.open;
}

async function sendLive(room: string, text: string): Promise<void> {
  if (!WALLET.on) {
    toast('CONNECT A WALLET TO CHAT');
    return;
  }
  const state = composerState({
    room,
    live: true,
    walletOn: true,
    access: currentAccess(room),
  });
  if (state.disabled && state.notice) {
    toast(state.notice);
    return;
  }
  try {
    if (!hasSession(WALLET.net)) await ensureSession(API_BASE, WALLET.net);
    const res = await sendChatMessage(WALLET.net, liveRoomKey(room), text);
    if (res.message?.flagged) toast('MESSAGE FLAGGED BY MODERATION', 'red');
  } catch (err) {
    const raw = err instanceof SocialApiError ? err.message : 'MESSAGE FAILED';
    const code = err instanceof SocialApiError ? err.code : '';
    if (code === 'unauthorized' || /unauthori[sz]ed/i.test(raw)) {
      toast('SIGN IN WITH YOUR WALLET TO CHAT');
    } else if (code === 'volume_required' || code === 'holder_required') {
      // The server said no: pull the fresh numbers and let the composer explain.
      await refreshAccess(room);
      const now = composerState({
        room,
        live: true,
        walletOn: true,
        access: currentAccess(room),
      });
      toast(now.notice ?? raw, 'red');
      if (code === 'holder_required' && room === CHAT.room) chatRender();
    } else if (code === 'rate_limited') {
      toast('SLOW DOWN — TRY AGAIN IN A MOMENT', 'red');
    } else if (code === 'banned') {
      toast('A MODERATOR MUTED THIS WALLET IN CHAT', 'red');
    } else if (code === 'chat_disabled') {
      toast('CHAT IS PAUSED BY THE ADMINS', 'red');
    } else {
      toast(raw, 'red');
    }
  }
}

export function initChat(): void {
  must('#chatTab').addEventListener('click', () => chatOpen(!CHAT.open));
  must('#chatClose').addEventListener('click', () => chatOpen(false));
  must('#chatScrim').addEventListener('click', () => chatOpen(false));
  must('#rooms').addEventListener('click', (e) => {
    const b = (e.target as Element | null)?.closest<HTMLElement>('[data-room]');
    if (b) chatSwitch(b.dataset['room'] as string);
  });
  must('#chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = must<HTMLInputElement>('#chatInput');
    if (input.disabled) return;
    const v = input.value.trim();
    if (!v) return;
    input.value = '';
    if (live()) {
      void sendLive(CHAT.room, v);
      return;
    }
    addChat(CHAT.room, {
      who: displayName(WALLET.full || WALLET.addr),
      col: '#ffa22b',
      text: v,
      mine: true,
      wallet: WALLET.full || WALLET.addr,
      avatarUrl: avatarUrlOf(WALLET.full || WALLET.addr),
    });
    if (Math.random() > 0.45) {
      const h = randomHandle();
      const room = CHAT.room;
      setTimeout(
        () =>
          addChat(
            room,
            {
              who: h[0],
              col: h[1],
              text:
                room === 'GLOBAL'
                  ? (GLINES[(Math.random() * GLINES.length) | 0] as string)
                  : (TLINES[(Math.random() * TLINES.length) | 0] as string).replace(
                      /\$SYM/g,
                      '$' + (roomSym(room) ?? ''),
                    ),
            },
            true,
          ),
        900 + Math.random() * 1800,
      );
    }
  });

  if (live()) {
    // A wallet connect / disconnect / net switch changes every verdict.
    on('wallet', () => {
      CHAT.access = {};
      if (CHAT.open) void refreshAccess();
      if (CHAT.token) void refreshAccess(privateRoomOf(CHAT.token.sym));
      chatRender();
    });
    // The wallet's own fill: the volume progress (and a fresh position) moved.
    on('fill', ({ fill }) => {
      const mine = [WALLET.full, sessionWallet(WALLET.net)].filter(Boolean);
      // `w` is the full address on a live print and a shortened one in the sim.
      if (!fill.w || !mine.some((a) => a === fill.w || shortAddr(a) === fill.w)) return;
      if (CHAT.open) void refreshAccess();
      if (CHAT.token) void refreshAccess(privateRoomOf(CHAT.token.sym));
    });
    joinLiveRoom(CHAT.room);
    chatRender();
    return;
  }

  const r = rng(4242);
  for (let i = 0; i < 7; i++) {
    const h = HANDLES[(r() * HANDLES.length) | 0] as [string, string];
    logFor('GLOBAL').push({
      who: h[0],
      col: h[1],
      text: GLINES[i % GLINES.length] as string,
      t: '09:' + String(31 + i * 3).padStart(2, '0'),
    });
  }
  chatRender();

  const next = (): void => {
    loop = window.setTimeout(
      () => {
        const h = randomHandle();
        if (CHAT.token && Math.random() > 0.45) {
          const r = '$' + CHAT.token.sym;
          addChat(
            r,
            {
              who: h[0],
              col: h[1],
              text: (TLINES[(Math.random() * TLINES.length) | 0] as string).replace(/\$SYM/g, r),
            },
            true,
          );
        } else {
          addChat(
            'GLOBAL',
            { who: h[0], col: h[1], text: GLINES[(Math.random() * GLINES.length) | 0] as string },
            true,
          );
        }
        next();
      },
      3500 + Math.random() * 4200,
    );
  };
  next();
}

export function stopChat(): void {
  if (loop) clearTimeout(loop);
  loop = 0;
  stopAccessPolling();
  leaveLiveRoom();
}
