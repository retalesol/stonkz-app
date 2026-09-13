import { hash, rng } from '@stonkz/shared';
import { api } from '../api/index.js';
import { type LiveChatFrame, subscribeChatRoom } from '../api/live.js';
import { SocialApiError, fetchChatHistory, sendChatMessage } from '../api/social.js';
import { ensureSession, hasSession, sessionWallet } from '../app/session.js';
import { toast } from '../fx/toast.js';
import { paintAvatar } from '../lib/avatar.js';
import { $, $$, must } from '../lib/dom.js';
import { ARR, clock } from '../lib/fmt.js';
import { type FocusTrap, trapFocus } from '../lib/focus-trap.js';
import { type Html, attr, html, node, render } from '../lib/html.js';
import { avatarUrlOf, displayName, rememberIdentity } from '../lib/identity.js';
import { reducedMotion } from '../lib/motion.js';
import { CHAT, type ChatMsg, GLINES, HANDLES, TLINES, logFor, randomHandle } from '../state/chat.js';
import type { SimCoin } from '../state/coins.js';
import { WALLET } from '../state/wallet.js';

const API_BASE = import.meta.env['VITE_API_URL'] ?? '';

/**
 * The chat drawer.
 *
 * Live mode uses history + WS frames that carry username / avatarUrl.
 * Own messages always show the set username (or short address) — never "YOU".
 */

let trap: FocusTrap | null = null;
let loop = 0;
let liveUnsub: (() => void) | null = null;
const liveHistoryLoaded = new Set<string>();

export function roomOf(c: { sym: string }): string {
  return '$' + c.sym;
}

/** The server's room key: uppercase, no leading `$`. */
function liveRoomKey(room: string): string {
  return room.replace(/^\$/, '').toUpperCase();
}

function colorFor(wallet: string): string {
  return (HANDLES[hash(wallet) % HANDLES.length] as [string, string])[1];
}

function pushLiveFrame(
  room: string,
  wallet: string,
  text: string,
  createdAtMs: number,
  live: boolean,
  meta?: { username?: string | null; avatarUrl?: string | null },
): void {
  if (meta?.username || meta?.avatarUrl) {
    rememberIdentity(wallet, { username: meta.username ?? null, avatarUrl: meta.avatarUrl ?? null });
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
    live,
  );
}

/** Joins `room`'s live channel and, the first time, backfills its history. */
function joinLiveRoom(room: string): void {
  liveUnsub?.();
  liveUnsub = subscribeChatRoom(WALLET.net, liveRoomKey(room), (msg: LiveChatFrame) =>
    pushLiveFrame(room, msg.wallet, msg.text, msg.createdAtMs, true, {
      username: msg.username ?? null,
      avatarUrl: msg.avatarUrl ?? null,
    }),
  );
  if (liveHistoryLoaded.has(room)) return;
  liveHistoryLoaded.add(room);
  fetchChatHistory(WALLET.net, liveRoomKey(room))
    .then((res) => {
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
    .catch(() => {
      /* empty room until live frames arrive */
    });
}

function leaveLiveRoom(): void {
  liveUnsub?.();
  liveUnsub = null;
}

function chatTitle(): void {
  must('#chatTitle').textContent = CHAT.room === 'GLOBAL' ? 'GLOBAL CHAT' : CHAT.room + ' CHAT';
  must('#chatOnline').textContent =
    api.mode === 'live'
      ? 'LIVE'
      : (CHAT.room === 'GLOBAL' ? 41 : 8 + (hash(CHAT.room) % 60)) + ' ONLINE';
}

function chatChips(): void {
  const back = CHAT.token && CHAT.room !== 'GLOBAL' ? ARR + ' ' : '';
  const room = CHAT.token ? '$' + CHAT.token.sym : '';
  render(
    must('#rooms'),
    html`<button class="room${CHAT.room === 'GLOBAL' ? ' on' : ''}" data-room="GLOBAL">${back}GLOBAL</button
      >${CHAT.token
        ? html`<button class="room${CHAT.room === room ? ' on' : ''}" data-room="${attr(room)}">${room}</button>`
        : ''}`,
  );
}

function msgHTML(m: ChatMsg): Html {
  const seed = m.wallet || m.who;
  return html`<div class="cm${m.mine ? ' mine' : ''}${m.sys ? ' sys' : ''}"
    >${m.sys
      ? ''
      : html`<canvas class="av" width="28" height="28" data-seed="${attr(String(seed))}" data-av="${attr(
          m.avatarUrl || '',
        )}" aria-hidden="true"></canvas
        ><div class="who" style="color:${attr(m.col || '#4d9bff')}">${m.who}<span>${m.t || clock()}</span></div>`}<p
      >${m.text}</p></div>`;
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

export function chatRender(): void {
  chatTitle();
  chatChips();
  const log = must('#chatLog');
  render(log, html`${logFor(CHAT.room).map(msgHTML)}`);
  paintChatAvatars(log);
  log.scrollTop = log.scrollHeight;
}

/** Append one message. `live` marks it as arriving now rather than replayed. */
export function addChat(room: string, m: ChatMsg, live = false): void {
  m.t = m.t || clock();
  if (m.mine && !m.who) {
    m.who = displayName(WALLET.full || WALLET.addr);
  }
  if (m.mine && !m.wallet) m.wallet = WALLET.full || WALLET.addr;
  if (m.mine && m.avatarUrl === undefined) m.avatarUrl = avatarUrlOf(m.wallet || WALLET.full);
  const l = logFor(room);
  l.push(m);
  if (l.length > 90) l.shift();
  if (room === CHAT.room) {
    const log = must('#chatLog');
    const near = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    const el = node(msgHTML(m));
    if (live && !reducedMotion()) el.classList.add('in');
    log.appendChild(el);
    paintChatAvatars(el);
    while (log.children.length > 90) log.removeChild(log.firstChild as ChildNode);
    if (near || m.mine) log.scrollTop = log.scrollHeight;
    if (!CHAT.open && live) bumpUnread();
  } else if (live) {
    bumpUnread();
  }
}

function bumpUnread(): void {
  CHAT.unread++;
  const u = must('#unread');
  u.hidden = false;
  u.textContent = CHAT.unread > 99 ? '99+' : String(CHAT.unread);
}

function chatSwitch(room: string): void {
  CHAT.room = room;
  if (api.mode === 'live') joinLiveRoom(room);
  chatRender();
}

/** Give the drawer a token room, or take it away when the token page closes. */
export function setChatToken(c: SimCoin | null): void {
  CHAT.token = c ? { sym: c.sym, seed: c.seed } : null;
  if (c) {
    const r = roomOf(c);
    if (!CHAT.logs[r]) {
      CHAT.logs[r] = [];
      if (api.mode !== 'live') {
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
  } else {
    CHAT.room = 'GLOBAL';
  }
  if (api.mode === 'live') joinLiveRoom(CHAT.room);
  chatRender();
}

export function chatOpen(v: boolean): void {
  CHAT.open = v;
  must('#drawer').classList.toggle('open', v);
  must('#chatScrim').classList.toggle('open', v);
  must('#chatTab').setAttribute('aria-expanded', v ? 'true' : 'false');
  if (v) {
    CHAT.unread = 0;
    must('#unread').hidden = true;
    const log = must('#chatLog');
    log.scrollTop = log.scrollHeight;
    trap = trapFocus(must('#drawer'), must('#chatTab'));
    setTimeout(() => $('#chatInput')?.focus(), 220);
  } else if (trap) {
    trap.release();
    trap = null;
  }
}

export function isChatOpen(): boolean {
  return CHAT.open;
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
    const v = input.value.trim();
    if (!v) return;
    input.value = '';
    if (api.mode === 'live') {
      const room = CHAT.room;
      void (async () => {
        if (!WALLET.on) {
          toast('CONNECT A WALLET TO CHAT');
          return;
        }
        try {
          if (!hasSession(WALLET.net)) await ensureSession(API_BASE, WALLET.net);
          await sendChatMessage(WALLET.net, liveRoomKey(room), v);
        } catch (err) {
          const raw = err instanceof SocialApiError ? err.message : 'MESSAGE FAILED';
          const code = err instanceof SocialApiError ? err.code : '';
          if (code === 'unauthorized' || /unauthori[sz]ed/i.test(raw)) {
            toast('SIGN IN WITH YOUR WALLET TO CHAT');
          } else {
            toast(raw);
          }
        }
      })();
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
                  : (TLINES[(Math.random() * TLINES.length) | 0] as string).replace(/\$SYM/g, room),
            },
            true,
          ),
        900 + Math.random() * 1800,
      );
    }
  });

  if (api.mode === 'live') {
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
          addChat(r, { who: h[0], col: h[1], text: (TLINES[(Math.random() * TLINES.length) | 0] as string).replace(/\$SYM/g, r) }, true);
        } else {
          addChat('GLOBAL', { who: h[0], col: h[1], text: GLINES[(Math.random() * GLINES.length) | 0] as string }, true);
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
  leaveLiveRoom();
}
