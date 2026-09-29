import { NET_INFO, num, px, usd, type Net } from '@stonkz/shared';
import type { Trade } from '../state/coins.js';
import { type Html, attr, html } from '../lib/html.js';

/**
 * The RECENT TRADES tab, as a pure function of its rows so the table renders
 * the same in tests as on the page (`token-trades.test.ts`). `token.ts` owns
 * the DOM: it passes the link builders in and wires the row handlers after
 * the write.
 */

export interface TradesTableInput {
  /** Newest first, as `pushTrade` keeps them. */
  trades: readonly Trade[];
  net: Net;
  /** Fixed supply, for the per-fill spot price. */
  supply: number;
  /** Live mode links each row to its transaction. */
  live: boolean;
  now: number;
  txUrl: (sig: string) => string;
  /** Display name for a full wallet (username when known, else short address). */
  nameOf: (wallet: string) => string;
  /** The API has older rows beyond what is loaded. */
  hasMore: boolean;
  loading: boolean;
}

/** Enough decimals for sub-0.01 ETH fills without lying as `0.00`; whole units keep four. */
export function fmtNativeAmt(v: number): string {
  if (!Number.isFinite(v) || v === 0) return '0';
  const a = Math.abs(v);
  const s = a >= 0.01 ? v.toFixed(4) : a >= 0.0001 ? v.toFixed(6) : v.toFixed(8);
  return s.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `HH:MM:SS` today, `MM-DD HH:MM` before that — a two-day-old fill must not read as "this morning". */
export function fmtTradeTime(t: Date, now: number): string {
  const d = new Date(now);
  const sameDay =
    t.getFullYear() === d.getFullYear() &&
    t.getMonth() === d.getMonth() &&
    t.getDate() === d.getDate();
  if (sameDay) return pad2(t.getHours()) + ':' + pad2(t.getMinutes()) + ':' + pad2(t.getSeconds());
  return (
    pad2(t.getMonth() + 1) +
    '-' +
    pad2(t.getDate()) +
    ' ' +
    pad2(t.getHours()) +
    ':' +
    pad2(t.getMinutes())
  );
}

function fmtHopAmt(v: number): string {
  return v < 0.001 ? v.toPrecision(3) : num(v);
}

export function tradesTableHTML(i: TradesTableInput): Html {
  const unit = NET_INFO[i.net]?.unit ?? 'SOL';
  if (i.loading && i.trades.length === 0) {
    return html`<div class="pnl-bd"><p class="hint">LOADING TRADES…</p></div>`;
  }
  if (!i.trades.length) {
    return html`<div class="pnl-bd"><p class="hint">NO RECENT TRADES YET.</p></div>`;
  }
  const rows = i.trades.map((t, idx) => {
    const link = t.addr || t.w;
    const multi = !!(t.hops && t.hops.length > 1);
    const open = !!t.open && multi;
    const rowClass = [
      'tr-row',
      t.fresh && idx === 0 ? 'newrow' : '',
      multi ? 'tr-hop' : '',
      open ? 'open' : '',
      t.pending ? 'pend' : '',
    ]
      .filter(Boolean)
      .join(' ');
    const hopAttrs = multi
      ? html` data-tr="${idx}" tabindex="0" role="button" aria-expanded="${open ? 'true' : 'false'}"`
      : '';
    const time = fmtTradeTime(t.t, i.now);
    const title = t.pending
      ? 'Confirmed on chain, awaiting indexer finality'
      : t.t.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    const usdCell = t.usd !== undefined && t.usd > 0 ? html` <i class="dm">${usd(t.usd)}</i>` : '';
    return html`<tr class="${attr(rowClass)}" ${hopAttrs}>
        <td class="dm">
          ${
            t.sig && i.live
              ? html`<a
                  class="txlink"
                  href="${attr(i.txUrl(t.sig))}"
                  target="_blank"
                  rel="noopener"
                  title="${attr(title)}"
                  >${time}</a
                >`
              : html`<span title="${attr(title)}">${time}</span>`
          }${t.pending ? html` <span class="tag pend-tag" title="Awaiting indexer">⏳</span>` : ''}
        </td>
        <td class="${t.buy ? 'up' : 'dn'}">${t.buy ? 'BUY' : 'SELL'}</td>
        <td class="r">${fmtNativeAmt(t.sol)}${usdCell}</td>
        <td class="r">${num(t.tok)}</td>
        <td class="r">${px(t.mc / (i.supply || 1))}</td>
        <td class="r">${usd(t.mc)}</td>
        <td class="${t.cb ? '' : 'bl'}">
          ${
            t.cb
              ? html`<span class="tag cb">CASHBACK</span>`
              : html`<span class="addrlink" data-addr="${attr(link)}">${i.nameOf(link)}</span>`
          }
        </td>
        <td class="dm ven-cell">
          ${t.v}${multi ? html`<span class="ven-chev" aria-hidden="true">${open ? '▾' : '▸'}</span>` : ''}
        </td>
      </tr>
      ${
        open && t.hops
          ? html`<tr class="tr-hops">
              <td colspan="8">
                <div class="hop-detail">
                  ${t.hops.map(
                    (h, hi) =>
                      html`<div class="hop-leg">
                        <span class="hop-n">HOP ${hi + 1}</span><span class="hop-v">${h.venue}</span
                        ><span class="hop-path"
                          >${fmtHopAmt(h.inAmount)} ${h.inSymbol} → ${fmtHopAmt(h.outAmount)}
                          ${h.outSymbol}</span
                        >
                      </div>`,
                  )}
                </div>
              </td>
            </tr>`
          : ''
      }`;
  });
  return html`<div class="scrolly">
      <table class="tbl tbl-trades">
        <thead>
          <tr>
            <th scope="col">TIME</th>
            <th scope="col">TYPE</th>
            <th scope="col" class="r">${unit}</th>
            <th scope="col" class="r">TOKENS</th>
            <th scope="col" class="r">PRICE</th>
            <th scope="col" class="r">MCAP</th>
            <th scope="col">TRADER</th>
            <th scope="col">VEN</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
    ${
      i.hasMore || i.loading
        ? html`<div class="tbl-foot">
            <button type="button" class="tab" id="tr-more" ${i.loading ? 'disabled' : ''}>
              ${i.loading ? 'LOADING…' : 'LOAD OLDER'}
            </button>
          </div>`
        : ''
    }`;
}
