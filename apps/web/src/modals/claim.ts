import { hash, inCashback, num, usd, vol24 } from '@stonkz/shared';
import { api } from '../api/index.js';
import { SignerCancelledError } from '../app/signer.js';
import { describeWalletError, isRejection } from '../wallet/index.js';
import { pix } from '../canvas/pix.js';
import { toast } from '../fx/toast.js';
import { $, $$, must } from '../lib/dom.js';
import { DOT } from '../lib/fmt.js';
import { type Html, attr, html, render } from '../lib/html.js';
import { bySym, myCoins } from '../state/coins.js';
import { USER } from '../state/user.js';
import { NATIVE_PRICE, WALLET, nativeUnit } from '../state/wallet.js';
import { addChat } from '../views/chat.js';
import { closeScrim, isOpen, openScrim, wireBackdrop } from './scrim.js';

/**
 * Creator fee claim.
 *
 * The window's subtitle is the honest one now — a creator's share of curve fees
 * on coins they launched, not "all fees". Platform 15%, `$STONKZ` buyback 10%
 * and the RWA crate fund 6% are never claimable here, and the creator's own
 * 69% bucket is shared with that coin's stakers. `index.html:2996`
 *
 * Live mode reads `GET /fees` (`api.claimableFees()`) instead of `SimCoin.fee`/
 * `feeTokens` — the server's `creator_vaults` ledger, not a client-side
 * accrual loop — so this modal has to fetch before it can render anything,
 * unlike the sim path, which already has the numbers in memory. `plan step 98`
 */

/** What both adapters' fee data gets reshaped into before it renders. */
interface ClaimRow {
  sym: string;
  name: string;
  seed: number;
  native: number;
  tokens: number;
  cashback: boolean;
  /** 24h volume, USD; `null` when live mode has no detail figure for the coin yet. */
  vol: number | null;
}

function simRows(): ClaimRow[] {
  return myCoins()
    .filter((c) => (c.fee ?? 0) > 0 || (c.feeTokens ?? 0) > 0)
    .map((c) => ({
      sym: c.sym,
      name: c.name,
      seed: c.seed,
      native: c.fee ?? 0,
      tokens: c.feeTokens ?? 0,
      cashback: inCashback(c),
      vol: vol24(c),
    }));
}

/** `FeeVault`'s sym/native/tokens filled out with whatever the board already knows about that coin. */
function liveRows(vaults: Awaited<ReturnType<typeof api.claimableFees>>): ClaimRow[] {
  return vaults.map((v) => {
    const c = bySym(v.sym);
    return {
      sym: v.sym,
      name: c?.name ?? v.sym,
      seed: c?.seed ?? hash(v.sym),
      native: v.native,
      tokens: v.tokens,
      cashback: c ? inCashback(c) : false,
      // The detail read's real 24h volume when the board has it; never the
      // seed-derived sim figure on a live coin.
      vol: c?.vol24Usd ?? null,
    };
  });
}

function claimHTML(rows: ClaimRow[]): Html {
  const tot = rows.reduce((t, r) => t + r.native, 0);
  const unit = nativeUnit();
  if (!rows.length) {
    return html`<p class="empty">
        NO FEES TO CLAIM YET ${DOT} FEES ACCRUE ON EVERY TRADE OF A COIN YOU LAUNCHED.
      </p>
      <button class="big" id="claim-go" disabled style="opacity:.5">NOTHING TO CLAIM</button>`;
  }
  const signingNote =
    api.mode === 'live'
      ? 'SIGNING USES A LOCAL PRACTICE KEY, NOT A BROADCAST TO A LIVE CHAIN.'
      : 'SIMULATED \u2014 NOTHING IS SIGNED.';
  return html`<div>
      ${rows.map((r) => {
        return html`<div class="claim-row">
          <canvas width="64" height="64" data-seed="${attr(r.seed)}" aria-hidden="true"></canvas>
          <div>
            <div class="sy">${r.sym}</div>
            <div class="mt">
              ${r.name} ${DOT} VOL 24H
              ${r.vol === null ? '\u2014' : usd(r.vol)}${r.cashback ? html` ${DOT} <span class="tag cb">CASHBACK</span>` : ''}
            </div>
          </div>
          <div class="amt">
            <b>${r.native.toFixed(3)} ${unit}</b
            ><span
              >${
                r.tokens > 0 ? num(r.tokens) + ' ' + r.sym : usd(r.native * NATIVE_PRICE.usd)
              }</span
            >
          </div>
        </div>`;
      })}
    </div>
    <div class="claim-tot">
      <span class="lbl">TOTAL CLAIMABLE</span><b>${tot.toFixed(3)} ${unit}</b>
    </div>
    <p class="hint">
      FEES SETTLE TO ${WALLET.addr} ${DOT} CLAIMED LIFETIME ${(USER.feesClaimed ?? 0).toFixed(3)}
      ${unit} ${DOT} TOKEN ALLOCATION FROM CASHBACK LANDS IN YOUR PORTFOLIO ${DOT} ${signingNote}
    </p>
    <button class="big" id="claim-go">CONFIRM CLAIM ${DOT} ${tot.toFixed(3)} ${unit}</button>`;
}

function paintClaimBody(rows: ClaimRow[]): void {
  render(must('#claimBody'), claimHTML(rows));
  for (const cv of $$<HTMLCanvasElement>('#claimBody canvas')) pix(cv, Number(cv.dataset['seed']));
  const go = $('#claim-go') as HTMLButtonElement | null;
  if (go && !go.disabled) go.addEventListener('click', () => void doClaim());
}

async function refreshClaimBody(): Promise<void> {
  if (api.mode === 'sim') {
    paintClaimBody(simRows());
    return;
  }
  try {
    paintClaimBody(liveRows(await api.claimableFees()));
  } catch (err) {
    render(
      must('#claimBody'),
      html`<p class="empty">
        COULD NOT LOAD YOUR FEES ${DOT}
        ${String(err instanceof Error ? err.message : err).toUpperCase()}
      </p>`,
    );
  }
}

export function openClaim(opener?: Element | null): void {
  render(must('#claimBody'), html`<p class="empty">LOADING…</p>`);
  openScrim('#claimScrim', opener);
  void refreshClaimBody();
}

export function closeClaim(): void {
  closeScrim('#claimScrim');
}

export function isClaimOpen(): boolean {
  return isOpen('#claimScrim');
}

let afterClaim: () => void = () => undefined;

async function doClaim(): Promise<void> {
  const go = $<HTMLButtonElement>('#claim-go');
  const restoreLabel = go?.textContent ?? '';
  if (go) {
    go.disabled = true;
    go.textContent = 'CONFIRMING\u2026';
  }

  const unit = nativeUnit();
  let res;
  try {
    res = await api.claimCreatorFees();
  } catch (err) {
    if (go) {
      go.disabled = false;
      go.textContent = restoreLabel;
    }
    if (err instanceof SignerCancelledError) toast('CLAIM CANCELLED');
    else if (isRejection(err)) toast('CLAIM REJECTED IN WALLET');
    else toast(describeWalletError(err), 'red');
    return;
  }

  if (res.native <= 0 && Object.keys(res.tokens).length === 0) {
    closeClaim();
    return;
  }
  const toks = Object.keys(res.tokens).map((sym) => num(res.tokens[sym] as number) + ' ' + sym);
  closeClaim();
  toast(
    'CLAIMED ' +
      res.native.toFixed(3) +
      ' ' +
      unit +
      (toks.length ? ' + ' + toks.join(' + ') : '') +
      (api.mode === 'live' ? '' : ' ' + DOT + ' SIMULATED'),
  );
  addChat(
    'GLOBAL',
    {
      sys: true,
      who: '',
      text: 'CREATOR FEES CLAIMED ' + DOT + ' ' + res.native.toFixed(3) + ' ' + unit,
    },
    true,
  );
  afterClaim();
}

export function initClaim(onClaimed: () => void): void {
  afterClaim = onClaimed;
  wireBackdrop('#claimScrim', closeClaim);
}
