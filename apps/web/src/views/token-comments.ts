import type { Comment } from '../state/coins.js';
import { DOT } from '../lib/fmt.js';
import { type Html, attr, html } from '../lib/html.js';

/**
 * The COMMENTS tab as a pure function (`token-comments.test.ts`). Comments
 * are the coin's chat room (`/chat/:net/:room/history`), so the same gates
 * the drawer enforces apply: a wallet on the coin's chain, and whatever the
 * room's access snapshot says (`gateNote`).
 */

export interface CommentsInput {
  /** Oldest first. `null` while the history is loading. */
  list: readonly Comment[] | null;
  now: number;
  /** Composer enabled. */
  canPost: boolean;
  /** Why the composer is closed (shown in place of it), or null. */
  gateNote: string | null;
  nameOf: (wallet: string) => string;
  /** Wallet the composer is replying to (prefilled `@name`), or null. */
  replyTo: string | null;
  maxLen: number;
}

/** `JUST NOW`, `5M AGO`, `3H AGO`, `2D AGO` — refreshed on the beat. */
export function relTime(atMs: number, now: number): string {
  const s = Math.max(0, Math.round((now - atMs) / 1000));
  if (s < 45) return 'JUST NOW';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'M AGO';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'H AGO';
  const d = Math.round(h / 24);
  if (d < 30) return d + 'D AGO';
  return Math.round(d / 30) + 'MO AGO';
}

function whenOf(m: Comment, now: number): string {
  return m.at !== undefined ? relTime(m.at, now) : m.t;
}

/** The list alone, so a live message can be swapped in without rebuilding the composer. */
export function commentListHTML(
  i: Pick<CommentsInput, 'list' | 'now' | 'canPost' | 'nameOf'>,
): Html {
  const list = i.list ?? [];
  if (!list.length) {
    return html`<p class="hint" style="margin:0">NO COMMENTS YET ${DOT} BE THE FIRST.</p>`;
  }
  return html`${list.map(
    (m) =>
      html`<div
        class="cmt${m.mine ? ' mine' : ''}"
        ${m.id !== undefined ? html`data-id="${m.id}"` : ''}
      >
        <div class="who">
          <span class="addrlink" data-addr="${attr(m.who)}">${i.nameOf(m.who)}</span
          ><span
            ${m.at !== undefined ? html`data-at="${m.at}"` : ''}
            title="${attr(m.at !== undefined ? new Date(m.at).toISOString() : '')}"
            >${whenOf(m, i.now)}</span
          >${
            i.canPost && !m.mine
              ? html`<button type="button" class="cmt-reply" data-reply="${attr(m.who)}">
                  REPLY
                </button>`
              : ''
          }
        </div>
        <p>${m.text}</p>
      </div>`,
  )}`;
}

export function commentsHTML(i: CommentsInput): Html {
  if (i.list === null) {
    return html`<div class="pnl-bd"><p class="hint">LOADING COMMENTS…</p></div>`;
  }
  return html`<div class="pnl-bd">
    <div class="scrolly cmt-scroll" id="cmt-list">${commentListHTML(i)}</div>
    ${
      i.canPost
        ? html`<form class="inline-form" id="cmt-form">
            <input
              class="fld"
              id="cmt-in"
              maxlength="${i.maxLen}"
              placeholder="${attr(i.replyTo ? 'REPLY TO ' + i.nameOf(i.replyTo) : 'POST A COMMENT')}"
              aria-label="Comment"
              value="${attr(i.replyTo ? '@' + i.nameOf(i.replyTo) + ' ' : '')}"
            /><button class="send" type="submit">POST</button>
          </form>`
        : html`<p class="hint" id="cmt-gate">${i.gateNote ?? 'CONNECT A WALLET TO COMMENT.'}</p>`
    }
  </div>`;
}
