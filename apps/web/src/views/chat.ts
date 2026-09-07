import { hash, rng } from '@stonkz/shared';
import { $, must } from '../lib/dom.js';
import { ARR, clock } from '../lib/fmt.js';
import { type Html, attr, html, node, render } from '../lib/html.js';
import { reducedMotion } from '../lib/motion.js';
import { type FocusTrap, trapFocus } from '../lib/focus-trap.js';
import { CHAT, type ChatMsg, GLINES, HANDLES, TLINES, logFor, randomHandle } from '../state/chat.js';
import type { SimCoin } from '../state/coins.js';

/**
 * The chat drawer. `index.html:3579`
 */

let trap: FocusTrap | null = null;
let loop = 0;

export function roomOf(c: { sym: string }): string {
  return '$' + c.sym;
}

function chatTitle(): void {
  must('#chatTitle').textContent = CHAT.room === 'GLOBAL' ? 'GLOBAL CHAT' : CHAT.room + ' CHAT';
  must('#chatOnline').textContent = (CHAT.room === 'GLOBAL' ? 41 : 8 + (hash(CHAT.room) % 60)) + ' ONLINE';
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
  return html`<div class="cm${m.mine ? ' mine' : ''}${m.sys ? ' sys' : ''}"
    >${m.sys
      ? ''
      : html`<div class="who" style="color:${attr(m.col || '#4d9bff')}">${m.who}<span>${m.t || clock()}</span></div>`}<p
      >${m.text}</p></div>`;
}

export function chatRender(): void {
  chatTitle();
  chatChips();
  const log = must('#chatLog');
  render(log, html`${logFor(CHAT.room).map(msgHTML)}`);
  log.scrollTop = log.scrollHeight;
}

/** Append one message. `live` marks it as arriving now rather than replayed. `index.html:3605` */
export function addChat(room: string, m: ChatMsg, live = false): void {
  m.t = m.t || clock();
  const l = logFor(room);
  l.push(m);
  if (l.length > 90) l.shift();
  if (room === CHAT.room) {
    const log = must('#chatLog');
    const near = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    const el = node(msgHTML(m));
    if (live && !reducedMotion()) el.classList.add('in');
    log.appendChild(el);
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
  chatRender();
}

/** Give the drawer a token room, or take it away when the token page closes. */
export function setChatToken(c: SimCoin | null): void {
  CHAT.token = c ? { sym: c.sym, seed: c.seed } : null;
  if (c) {
    const r = roomOf(c);
    if (!CHAT.logs[r]) {
      CHAT.logs[r] = [];
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
    CHAT.room = r;
  } else {
    CHAT.room = 'GLOBAL';
  }
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
    addChat(CHAT.room, { who: 'YOU', col: '#ffa22b', text: v, mine: true });
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

  // Seven lines of backscroll so the room does not open empty. Seeded, so the
  // same handles say the same things on every load. `index.html:4105`
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
}
