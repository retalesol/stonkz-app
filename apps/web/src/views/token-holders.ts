import { num, usd } from '@stonkz/shared';
import type { Holder } from '../state/coins.js';
import { DOT, MID } from '../lib/fmt.js';
import { type Html, attr, html } from '../lib/html.js';

/**
 * The HOLDERS tab as a pure function (`token-holders.test.ts`). Program
 * accounts (curve vault, LP reserve, stake escrow, creator bucket) are
 * labelled and never counted; a wallet's staked share shows under its
 * balance so staking does not make it vanish.
 */

export interface HoldersTableInput {
  /** Largest first, as the API ranks them. */
  rows: readonly Holder[];
  mc: number;
  supply: number;
  /** Rows to show before SHOW ALL. */
  shown: number;
  live: boolean;
  /** Wallet holders on chain (the header's HOLDERS), when the API reported it. */
  holderCount: number | null;
  source: 'explorer' | 'rpc' | 'db' | null;
  nameOf: (wallet: string) => string;
  loading: boolean;
  refreshing: boolean;
}

const SOURCE_LABEL: Record<NonNullable<HoldersTableInput['source']>, string> = {
  explorer: 'CHAIN VIA EXPLORER',
  rpc: 'CHAIN VIA RPC',
  db: 'INDEXER SNAPSHOT',
};

function amountOf(h: Holder, i: HoldersTableInput): number {
  return h.amt !== undefined ? h.amt : (i.supply * h.p) / 100;
}

export function holdersTableHTML(i: HoldersTableInput): Html {
  if (i.loading && i.rows.length === 0) {
    return html`<div class="pnl-bd"><p class="hint">LOADING HOLDERS…</p></div>`;
  }
  if (!i.rows.length) {
    return html`<div class="pnl-bd"><p class="hint">NO HOLDERS ON RECORD YET.</p></div>`;
  }
  const price = i.supply > 0 ? i.mc / i.supply : 0;
  const visible = i.rows.slice(0, Math.max(1, i.shown));
  const hidden = i.rows.length - visible.length;
  const wallets = i.rows.filter((h) => !h.kind || h.kind === 'wallet').length;
  return html`<div class="scrolly">
      <table class="tbl tbl-holders">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">WALLET</th>
            <th scope="col" class="r">HOLDING</th>
            <th scope="col" class="r">SUPPLY</th>
            <th scope="col" class="r">VALUE</th>
            <th scope="col">TAG</th>
          </tr>
        </thead>
        <tbody>
          ${visible.map((h, idx) => {
            const link = h.addr || h.w;
            const program = !!h.kind && h.kind !== 'wallet';
            const amt = amountOf(h, i);
            return html`<tr class="${program ? 'hold-program' : ''}">
              <td class="dm">${idx + 1}</td>
              <td class="${program ? 'am' : 'bl'}">
                ${
                  program
                    ? h.w
                    : html`<span class="addrlink" data-addr="${attr(link)}"
                        >${i.nameOf(link)}</span
                      >`
                }
              </td>
              <td class="r">
                ${num(amt)}${
                  h.staked !== undefined && h.staked > 0
                    ? html`<br /><i class="dm">${num(h.staked)} STAKED</i>`
                    : ''
                }
              </td>
              <td class="r">${h.p < 0.01 && h.p > 0 ? '<0.01' : h.p.toFixed(2)}%</td>
              <td class="r">${usd(amt * price)}</td>
              <td>
                ${h.tag ? html`<span class="tag ${h.tag[1]}">${h.tag[0]}</span>` : html`<span class="dm">${MID}</span>`}
              </td>
            </tr>`;
          })}
        </tbody>
      </table>
    </div>
    <div class="tbl-foot">
      <span class="hint"
        >${i.holderCount !== null ? num(i.holderCount) : num(wallets)}
        HOLDER${(i.holderCount ?? wallets) === 1 ? '' : 'S'}
        ${i.source ? html`${DOT} ${SOURCE_LABEL[i.source]}` : ''}</span
      >
      ${hidden > 0 ? html`<button type="button" class="tab" id="hold-more">SHOW ALL (${i.rows.length})</button>` : ''}
      ${
        i.live
          ? html`<button
              type="button"
              class="tab"
              id="hold-refresh"
              ${i.refreshing ? 'disabled' : ''}
            >
              ${i.refreshing ? 'REFRESHING…' : 'REFRESH'}
            </button>`
          : ''
      }
    </div>`;
}
