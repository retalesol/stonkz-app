import { inCashback, num, usd, vol24 } from '@stonkz/shared';
import { api } from '../api/index.js';
import { pix } from '../canvas/pix.js';
import { toast } from '../fx/toast.js';
import { $, $$, must } from '../lib/dom.js';
import { DOT } from '../lib/fmt.js';
import { type Html, attr, html, render } from '../lib/html.js';
import { myCoins } from '../state/coins.js';
import { USER } from '../state/user.js';
import { NATIVE_PRICE, WALLET, nativeUnit } from '../state/wallet.js';
import { addChat } from '../views/chat.js';
import { closeScrim, isOpen, openScrim, wireBackdrop } from './scrim.js';

/**
 * Creator fee claim.
 *
 * The window's subtitle is the honest one now — a creator's share of curve fees
 * on coins they launched, not "all fees". Protocol 20% and `$STONKZ` ops 10%
 * are never claimable here, and the creator's own 70% bucket is shared with
 * that coin's stakers. `index.html:2996`
 */

function feeTotal(): number {
  return myCoins().reduce((t, c) => t + (c.fee ?? 0), 0);
}

function feeTokensTotal(): number {
  return myCoins().reduce((t, c) => t + (c.feeTokens ?? 0), 0);
}

function claimHTML(): Html {
  const mine = myCoins().filter((c) => (c.fee ?? 0) > 0 || (c.feeTokens ?? 0) > 0);
  const tot = feeTotal();
  const unit = nativeUnit();
  if (!mine.length) {
    return html`<p class="empty">NO FEES TO CLAIM YET ${DOT} FEES ACCRUE ON EVERY TRADE OF A COIN YOU LAUNCHED.</p
      ><button class="big" id="claim-go" disabled style="opacity:.5">NOTHING TO CLAIM</button>`;
  }
  return html`<div>${mine.map((c) => {
      const cb = inCashback(c);
      return html`<div class="claim-row"><canvas width="64" height="64" data-seed="${attr(c.seed)}" aria-hidden="true"></canvas
        ><div><div class="sy">${c.sym}</div><div class="mt">${c.name} ${DOT} VOL 24H ${usd(vol24(c))}${
          cb ? html` ${DOT} <span class="tag cb">CASHBACK</span>` : ''
        }</div></div
        ><div class="amt"><b>${(c.fee ?? 0).toFixed(3)} ${unit}</b><span>${
          (c.feeTokens ?? 0) > 0 ? num(c.feeTokens as number) + ' ' + c.sym : usd((c.fee ?? 0) * NATIVE_PRICE.usd)
        }</span></div></div>`;
    })}</div
    ><div class="claim-tot"><span class="lbl">TOTAL CLAIMABLE</span><b>${tot.toFixed(3)} ${unit}</b></div
    ><p class="hint">FEES SETTLE TO ${WALLET.addr} ${DOT} CLAIMED LIFETIME ${(USER.feesClaimed ?? 0).toFixed(3)} ${unit} ${DOT}
      TOKEN ALLOCATION FROM CASHBACK LANDS IN YOUR PORTFOLIO ${DOT} SIMULATED &#8212; NOTHING IS SIGNED.</p
    ><button class="big" id="claim-go">CONFIRM CLAIM ${DOT} ${tot.toFixed(3)} ${unit}</button>`;
}

export function openClaim(opener?: Element | null): void {
  render(must('#claimBody'), claimHTML());
  for (const cv of $$<HTMLCanvasElement>('#claimBody canvas')) pix(cv, Number(cv.dataset['seed']));
  openScrim('#claimScrim', opener);
  const go = $('#claim-go') as HTMLButtonElement | null;
  if (go && !go.disabled) go.addEventListener('click', () => void doClaim());
}

export function closeClaim(): void {
  closeScrim('#claimScrim');
}

export function isClaimOpen(): boolean {
  return isOpen('#claimScrim');
}

let afterClaim: () => void = () => undefined;

async function doClaim(): Promise<void> {
  const tot = feeTotal();
  if (tot <= 0 && feeTokensTotal() <= 0) return;
  const unit = nativeUnit();
  const res = await api.claimCreatorFees();
  const toks = Object.keys(res.tokens).map((sym) => num(res.tokens[sym] as number) + ' ' + sym);
  closeClaim();
  toast('CLAIMED ' + res.native.toFixed(3) + ' ' + unit + (toks.length ? ' + ' + toks.join(' + ') : '') + ' ' + DOT + ' SIMULATED');
  addChat('GLOBAL', { sys: true, who: '', text: 'CREATOR FEES CLAIMED ' + DOT + ' ' + res.native.toFixed(3) + ' ' + unit }, true);
  afterClaim();
}

export function initClaim(onClaimed: () => void): void {
  afterClaim = onClaimed;
  wireBackdrop('#claimScrim', closeClaim);
}
