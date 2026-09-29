import { RANKS, num, pct, usd, type Net } from '@stonkz/shared';
import type { LiveActivity, LiveFollowEntry, LiveHolding, LiveStaked } from '../api/social.js';
import { DOT, shortAddr, ud } from '../lib/fmt.js';
import { type Html, attr, html } from '../lib/html.js';

/**
 * The profile page's pure blocks: everything here is `(data) -> Html`, with
 * no DOM, no `WALLET`, no fetch — so the public / private / owner renderings
 * can be asserted in a node test (`profile-render.test.ts`) exactly as the
 * browser paints them. `views/profile.ts` owns state, fetching and events.
 */

/**
 * `usd()` rounds to whole dollars below $1K — right for market caps, too
 * coarse for a $1.50 fill or a $2.40 loss. Two decimals under $1K here.
 */
export function usd2(v: number): string {
  const a = Math.abs(v);
  if (a < 1000) return (v < 0 ? '-' : '') + '$' + a.toFixed(2);
  return (v < 0 ? '-' : '') + usd(a);
}

/* ------------------------------- identity --------------------------------- */

export interface ProfileLinks {
  website: string | null | undefined;
  xHandle: string | null | undefined;
  telegram: string | null | undefined;
}

/** Only ever link to http(s) — the API enforces it too, but a stale cache should not. */
function safeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return /^https?:\/\/[^\s]+$/i.test(raw) ? raw : null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Website / X / Telegram chips under the bio. Empty `Html` when there are none. */
export function linksHTML(links: ProfileLinks): Html {
  const out: Html[] = [];
  const web = safeHttpUrl(links.website);
  if (web)
    out.push(
      html`<a class="pf-link" href="${attr(web)}" target="_blank" rel="noopener noreferrer nofollow"
        >${hostOf(web)}</a
      >`,
    );
  const x = (links.xHandle ?? '').replace(/^@/, '');
  if (x && /^[A-Za-z0-9_]{1,15}$/.test(x))
    out.push(
      html`<a
        class="pf-link"
        href="https://x.com/${attr(x)}"
        target="_blank"
        rel="noopener noreferrer nofollow"
        >@${x}</a
      >`,
    );
  const tg = safeHttpUrl(links.telegram);
  if (tg && /^https:\/\/t\.me\//i.test(tg))
    out.push(
      html`<a class="pf-link" href="${attr(tg)}" target="_blank" rel="noopener noreferrer nofollow"
        >${tg.replace(/^https:\/\/t\.me\//i, 't.me/')}</a
      >`,
    );
  if (!out.length) return html``;
  return html`<div class="pf-links">${out}</div>`;
}

export function privateBadgeHTML(): Html {
  return html`<span
    class="pf-private"
    title="Portfolio, PnL, activity, wall and friends are visible to the owner only"
    >PRIVATE</span
  >`;
}

/** The empty-state a visitor sees in place of a private section. */
export function privateNoticeHTML(what: string): Html {
  return html`<div class="pf-notice">
    THIS PROFILE IS PRIVATE ${DOT} ${what.toUpperCase()} ONLY VISIBLE TO THE OWNER
  </div>`;
}

/* ------------------------------- portfolio -------------------------------- */

function basisFlag(h: LiveHolding): Html {
  if (h.basis === 'partial')
    return html`<span
      class="basis-flag"
      title="Some of these tokens arrived by transfer or allocation — PnL covers the bought part only"
      >~</span
    >`;
  if (h.basis === 'unknown')
    return html`<span
      class="basis-flag"
      title="No buys on record for this wallet — cost basis unknown"
      >?</span
    >`;
  return html``;
}

/**
 * Holdings table with average-cost PnL. `cost`/`pnl` read `—` when the
 * basis is unknown (transfers, creator allocations) rather than a fake 0%.
 */
export function holdingsTableHTML(list: LiveHolding[]): Html {
  if (!list.length) return html`<div class="empty">NO POSITIONS</div>`;
  return html`<table class="tbl pf-hold">
    <thead>
      <tr>
        <th scope="col">TOKEN</th>
        <th scope="col" class="r">AMOUNT</th>
        <th scope="col" class="r">VALUE</th>
        <th scope="col" class="r">COST</th>
        <th scope="col" class="r">PNL</th>
      </tr>
    </thead>
    <tbody>
      ${list.map((h) => {
        const known = h.basis !== 'unknown' && h.cost > 0;
        const pnlUsd = h.pnlUsd ?? (known ? h.value - h.cost : null);
        const pnlPct = h.pnlPct ?? (known ? (h.value / h.cost - 1) * 100 : null);
        return html`<tr
          data-sym="${attr(h.sym)}"
          ${h.mint ? html` data-mint="${attr(h.mint)}"` : ''}
        >
          <td class="gd">${h.sym}${basisFlag(h)}</td>
          <td class="r">${num(h.tok)}</td>
          <td class="r">${usd2(h.value)}</td>
          <td class="r dm">${known ? usd2(h.cost) : '—'}</td>
          <td class="r ${pnlUsd === null ? 'dm' : ud(pnlUsd)}">
            ${
              pnlUsd === null
                ? '—'
                : html`${pnlUsd >= 0 ? '+' : '-'}${usd2(Math.abs(pnlUsd))}${
                    pnlPct === null ? '' : html`<span class="pf-sub"> ${pct(pnlPct)}</span>`
                  }`
            }
          </td>
        </tr>`;
      })}
    </tbody>
  </table>`;
}

/** One line under the holdings: unrealised + realised PnL. */
export function pnlSummaryHTML(
  pnl: { unrealisedUsd: number; realisedUsd: number } | undefined,
): Html {
  if (!pnl) return html``;
  const cell = (label: string, v: number) =>
    html`<span
      ><span class="lbl">${label}</span>
      <b class="${ud(v)}">${v >= 0 ? '+' : '-'}${usd2(Math.abs(v))}</b></span
    >`;
  return html`<div class="pf-pnl">
    ${cell('UNREALISED', pnl.unrealisedUsd)}${cell('REALISED', pnl.realisedUsd)}
  </div>`;
}

/** Read-only staked positions (indexer view) for a public profile. */
export function stakedRowsHTML(list: LiveStaked[], unit: string, nowMs: number): Html {
  if (!list.length) return html`<div class="empty">NO STAKED POSITIONS</div>`;
  return html`${list.map((s) => {
    const locked = s.untilMs > nowMs;
    return html`<div class="stk-row" data-stk="${attr(s.sym)}" data-mint="${attr(s.mint)}">
      <div>
        <div class="sy">
          ${s.sym}${locked ? html`<span class="lockbadge">${s.mult}x ${s.lockDays}D</span>` : ''}
        </div>
        <div class="mt">${num(s.amt)} STAKED ${DOT} ${usd(s.valueUsd)}</div>
      </div>
      <div class="earn">
        <b
          >${s.rewardNative > 0 ? s.rewardNative.toFixed(4) + ' ' + unit : num(s.rewardTokens) + ' ' + s.sym}</b
        ><span>ACCRUED</span>
      </div>
    </div>`;
  })}`;
}

/* -------------------------------- activity -------------------------------- */

export interface ActivityRenderOptions {
  /** Gas unit label for a net (`SOL`, `ETH`, `USDC`). */
  unitOf: (net: Net) => string;
  /** Explorer link for a signature on a net. */
  txUrl: (net: Net, sig: string) => string;
  /** Display name for a wallet (follow targets). */
  nameOf: (wallet: string) => string;
  /** Show the net chip on every row (a wallet's profile can span EVM nets). */
  showNet?: boolean;
}

const KIND_LABEL: Record<LiveActivity['kind'], [label: string, cls: string]> = {
  buy: ['BUY', 'up'],
  sell: ['SELL', 'dn'],
  launch: ['LAUNCH', 'gd'],
  stake: ['STAKE', 'am'],
  unstake: ['UNSTAKE', 'am'],
  stake_claim: ['CLAIM', 'up'],
  crate: ['CRATE', 'gd'],
  level_up: ['LEVEL UP', 'gd'],
  follow: ['FOLLOW', 'dm'],
};

function when(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function detailOf(a: LiveActivity, o: ActivityRenderOptions): Html {
  const unit = o.unitOf(a.net);
  switch (a.kind) {
    case 'buy':
    case 'sell':
      return html`<span class="gd">${a.sym ?? ''}</span>
        ${a.native != null ? a.native.toFixed(4) + ' ' + unit : ''}${
          a.usd != null ? html`<span class="pf-sub"> ${DOT} ${usd2(a.usd)}</span>` : ''
        }`;
    case 'launch':
      return html`<span class="gd">${a.sym ?? ''}</span> deployed`;
    case 'stake':
    case 'unstake':
      return html`${a.tokens != null ? num(a.tokens) + ' ' : ''}<span class="gd"
          >${a.sym ?? ''}</span
        >`;
    case 'stake_claim':
      return html`<span class="gd">${a.sym ?? ''}</span> ${
          a.native
            ? a.native.toFixed(4) + ' ' + unit
            : a.tokens
              ? num(a.tokens) + ' ' + (a.sym ?? '')
              : ''
        }`;
    case 'crate':
      return html`${a.tier ?? ''}${a.label ? html` <span class="pf-sub">${DOT} ${a.label}</span>` : ''}`;
    case 'level_up':
      return html`LV ${a.level ?? ''}
        <span class="gd">${a.label ?? RANKS[(a.level ?? 1) - 1]?.[0] ?? ''}</span>`;
    case 'follow':
      return html`followed
        <span class="addrlink" data-addr="${attr(a.target ?? '')}"
          >${a.target ? o.nameOf(a.target) : ''}</span
        >`;
    default:
      return html``;
  }
}

/**
 * The RECENT ACTIVITY table. `nextBefore` set renders a LOAD MORE button
 * (`#pfActMore`, `data-before`) the view wires to the next page.
 */
export function activityTableHTML(
  items: LiveActivity[],
  nextBefore: number | null,
  o: ActivityRenderOptions,
): Html {
  if (!items.length) return html`<div class="empty">NO ACTIVITY YET</div>`;
  return html`<div class="scrolly">
      <table class="tbl pf-act">
        <thead>
          <tr>
            <th scope="col">TIME</th>
            <th scope="col">ACTION</th>
            <th scope="col">DETAIL</th>
            <th scope="col" class="r">TX</th>
          </tr>
        </thead>
        <tbody>
          ${items.map((a) => {
            const [label, cls] = KIND_LABEL[a.kind] ?? ['?', 'dm'];
            return html`<tr data-act="${attr(a.id)}">
              <td class="dm" title="${attr(new Date(a.t).toISOString())}">${when(a.t)}</td>
              <td class="${cls}">
                ${label}${o.showNet ? html` <span class="pf-net">${a.net}</span>` : ''}
              </td>
              <td>${detailOf(a, o)}</td>
              <td class="r">
                ${
                  a.sig
                    ? html`<a
                        class="pf-tx"
                        href="${attr(o.txUrl(a.net, a.sig))}"
                        target="_blank"
                        rel="noopener noreferrer"
                        title="${attr(a.sig)}"
                        >${shortAddr(a.sig)}</a
                      >`
                    : html`<span class="dm">—</span>`
                }
              </td>
            </tr>`;
          })}
        </tbody>
      </table>
    </div>
    ${
      nextBefore
        ? html`<button
            type="button"
            class="pf-more"
            id="pfActMore"
            data-before="${attr(nextBefore)}"
          >
            LOAD MORE
          </button>`
        : ''
    }`;
}

/* --------------------------------- friends -------------------------------- */

function seedOf(addr: string): number {
  let h = 0;
  for (let i = 0; i < addr.length; i++) h = (h * 31 + addr.charCodeAt(i)) | 0;
  return Math.abs(h) % 1_000_000;
}

/** Friends / followers / following rows. `.friend[data-addr]` is the click target. */
export function followRowsHTML(
  entries: LiveFollowEntry[],
  opts: { empty: string; tag?: string; nextBefore?: number | null },
): Html {
  if (!entries.length) return html`<div class="empty">${opts.empty}</div>`;
  return html`${entries.map(
    (e) =>
      html`<div class="friend" data-addr="${attr(e.wallet)}">
        <canvas
          width="60"
          height="60"
          data-seed="${attr(seedOf(e.wallet))}"
          data-avatar="${attr(e.avatarUrl ?? '')}"
          aria-hidden="true"
        ></canvas>
        <div>
          <div class="fn">${e.username || shortAddr(e.wallet)}</div>
          <div class="fa">${shortAddr(e.wallet)}</div>
        </div>
        <div class="fp dm">${opts.tag ?? ''}</div>
      </div>`,
  )}${
    opts.nextBefore
      ? html`<button
          type="button"
          class="pf-more"
          id="pfFriendsMore"
          data-before="${attr(opts.nextBefore)}"
        >
          LOAD MORE
        </button>`
      : ''
  }`;
}
