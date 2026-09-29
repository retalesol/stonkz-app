import { num } from '@stonkz/shared';
import type {
  LiveReferralClaimAsset,
  LiveReferralPayout,
  LiveReferralSnapshot,
} from '../api/social.js';
import { DOT } from '../lib/fmt.js';
import { type Html, attr, html } from '../lib/html.js';

/**
 * The Rewards page's referral panel, as a pure renderer over an explicit
 * {@link ReferralModel} (the `rewards-view.ts` pattern), so every state —
 * sim mode, guest, loading, request-only net, on-chain claim available /
 * empty / in flight, history rows — renders and is asserted without a DOM.
 * `rewards.ts` builds the model and wires the buttons.
 */

export type ReferralBusy = 'preparing' | 'signing' | 'confirming' | null;

export interface ReferralModel {
  /** `api.mode === 'live'`. */
  live: boolean;
  connected: boolean;
  /** `GET /referrals` not back yet. */
  loading: boolean;
  snapshot: LiveReferralSnapshot | null;
  /** `SOL`, `ETH`, `USDC`. */
  unit: string;
  /**
   * `GET /referrals/claimable`. `null` until asked; `configured: false` means
   * this net has no referral vault and keeps the operator-batch request flow.
   */
  claimable: { configured: boolean; assets: LiveReferralClaimAsset[] } | null;
  /** A self-serve claim in flight (disables the buttons, changes the label). */
  busy: ReferralBusy;
}

const RATES_LINE = '15% / 10% / 5% FEE SHARE';

/** True when the panel should show CLAIM ON CHAIN instead of REQUEST PAYOUT. */
export function onchainEnabled(m: ReferralModel): boolean {
  return m.claimable?.configured === true || m.snapshot?.onchainClaims === true;
}

/** Label of the on-chain button for one asset, in the panel's terminal voice. */
export function claimButtonLabel(
  a: LiveReferralClaimAsset,
  unit: string,
  busy: ReferralBusy,
): string {
  if (busy === 'preparing') return 'PREPARING…';
  if (busy === 'signing') return 'SIGN IN WALLET…';
  if (busy === 'confirming') return 'CONFIRMING…';
  const sym = a.symbol === 'WETH' ? unit : a.symbol;
  return 'CLAIM ON CHAIN ' + DOT + ' ' + a.claimableNative.toFixed(4) + ' ' + sym;
}

/** One history line. */
export function payoutRowText(p: LiveReferralPayout, unit: string): string {
  const day = new Date(p.requestedAt).toISOString().slice(0, 10);
  if (p.mode === 'stonkz') {
    return (
      day +
      ' ' +
      DOT +
      ' ' +
      num(p.stonkz ?? 0) +
      ' $STONKZ FOR ' +
      p.amountNative.toFixed(6) +
      ' ' +
      unit
    );
  }
  const how = p.method === 'onchain' ? 'ON CHAIN' : 'BATCH';
  const status =
    p.status === 'requested'
      ? p.method === 'onchain'
        ? 'AWAITING YOUR CLAIM'
        : 'REQUESTED'
      : p.status.toUpperCase();
  return (
    day +
    ' ' +
    DOT +
    ' ' +
    p.amountNative.toFixed(6) +
    ' ' +
    unit +
    ' ' +
    DOT +
    ' ' +
    how +
    ' ' +
    DOT +
    ' ' +
    status +
    (p.txSig ? ' ' + DOT + ' ' + p.txSig.slice(0, 10) + '…' : '')
  );
}

/** The claim buttons: `$STONKZ` always; then either CLAIM ON CHAIN per asset or REQUEST PAYOUT. */
export function claimControlsHTML(m: ReferralModel): Html {
  const r = m.snapshot;
  const pending = r?.pendingNative ?? 0;
  const stonkz = html`<button
    type="button"
    class="openbtn"
    id="refClaim"
    ${pending > 0 && !m.busy ? '' : ' disabled'}
  >
    CLAIM AS $STONKZ
  </button>`;
  if (!onchainEnabled(m)) {
    return html`${stonkz}
      <button
        type="button"
        class="wiz-btn"
        id="refPayout"
        ${pending > 0 && !m.busy ? '' : ' disabled'}
      >
        REQUEST ${m.unit} PAYOUT
      </button>`;
  }
  const assets = m.claimable?.assets ?? [];
  if (assets.length === 0) {
    return html`${stonkz}
      <button type="button" class="wiz-btn" id="refClaimChain" disabled>
        ${m.busy ? 'PREPARING…' : 'CLAIM ON CHAIN ' + DOT + ' 0.0000 ' + m.unit}
      </button>`;
  }
  return html`${stonkz}
  ${assets.map(
      (a) =>
        html`<button
          type="button"
          class="wiz-btn"
          id="refClaimChain"
          data-asset="${attr(a.asset)}"
          ${a.claimableNative > 0 && !m.busy ? '' : ' disabled'}
        >
          ${claimButtonLabel(a, m.unit, m.busy)}
        </button>`,
    )}`;
}

export function referralHTML(m: ReferralModel): Html {
  if (!m.live) {
    return html`<section class="pnl" style="grid-column:1/-1">
      <div class="pnl-hd">
        <h2>Referrals</h2>
        <span class="sub">LIVE MODE ONLY</span>
      </div>
      <div class="pnl-bd">
        <p class="hint">
          CONNECT IN LIVE TO SHARE A CODE ${DOT} EARN 15/10/5% OF REFERRAL FEES + 5% OF THEIR SP.
        </p>
      </div>
    </section>`;
  }
  const r = m.snapshot;
  if (!r) {
    return html`<section class="pnl" style="grid-column:1/-1">
      <div class="pnl-hd">
        <h2>Referrals</h2>
        <span class="sub">${m.connected ? 'LOADING…' : 'CONNECT A WALLET'}</span>
      </div>
      <div class="pnl-bd">
        <p class="hint">
          ${m.connected ? 'LOADING YOUR CODE…' : `CONNECT TO GET A CODE ${DOT} EARN 15/10/5% OF REFERRAL FEES + 5% OF THEIR SP.`}
        </p>
      </div>
    </section>`;
  }
  const unit = m.unit;
  const pending = r.pendingNative;
  const tiers = r.tiers ?? [];
  const requested = r.requestedNative ?? 0;
  const paid = r.paidNative ?? 0;
  const payouts = (r.payouts ?? []).slice(0, 5);
  const onchain = onchainEnabled(m);
  return html`<section class="pnl" style="grid-column:1/-1">
    <div class="pnl-hd">
      <h2>Referrals</h2>
      <span class="sub"
        >${r.directReferrals} DIRECT ${DOT} ${RATES_LINE} ${DOT} 5% SP KICKBACK</span
      >
    </div>
    <div class="pnl-bd" style="display:flex;flex-direction:column;gap:10px">
      <div>
        <span class="lbl">YOUR CODE</span>
        <div style="display:flex;gap:8px;align-items:center;margin-top:4px">
          <code id="refCode" style="font-size:18px;letter-spacing:.12em;font-weight:700"
            >${r.code}</code
          ><button type="button" class="send" id="refCopy">COPY</button>
        </div>
        <p class="hint">FRIENDS PASTE THIS ON FIRST JOIN ${DOT} YOU EARN WHEN THEY TRADE.</p>
      </div>
      <div style="display:flex;gap:16px;flex-wrap:wrap">
        <div>
          <span class="lbl">PENDING FEES</span>
          <div class="v" id="refPending">${pending.toFixed(4)} ${unit}</div>
        </div>
        <div>
          <span class="lbl">LIFETIME</span>
          <div class="v">${r.lifetimeNative.toFixed(4)} ${unit}</div>
        </div>
        <div>
          <span class="lbl">${onchain ? 'AWAITING YOUR CLAIM' : 'AWAITING PAYOUT'}</span>
          <div class="v${requested > 0 ? ' am' : ''}" id="refRequested">
            ${requested.toFixed(4)} ${unit}
          </div>
        </div>
        <div>
          <span class="lbl">PAID OUT</span>
          <div class="v" id="refPaid">${paid.toFixed(4)} ${unit}</div>
        </div>
        <div>
          <span class="lbl">REFERRED BY</span>
          <div class="v">${r.referredBy ? r.referredBy.slice(0, 8) + '…' : '—'}</div>
        </div>
      </div>
      ${
        tiers.length
          ? html`<div class="scrolly">
              <table class="tbl" id="refTiers">
                <thead>
                  <tr>
                    <th>TIER</th>
                    <th class="r">RATE</th>
                    <th class="r">FILLS</th>
                    <th class="r">PENDING ${unit}</th>
                    <th class="r">LIFETIME ${unit}</th>
                  </tr>
                </thead>
                <tbody>
                  ${tiers.map(
                    (t) =>
                      html`<tr>
                        <td>
                          T${t.tier} ${DOT}
                          ${t.tier === 1 ? 'DIRECT' : t.tier === 2 ? 'THEIR REFERRALS' : 'THIRD DEGREE'}
                        </td>
                        <td class="r">${(t.rate * 100).toFixed(0)}%</td>
                        <td class="r">${num(t.fills)}</td>
                        <td class="r${t.pendingNative > 0 ? ' up' : ' dm'}">
                          ${t.pendingNative.toFixed(6)}
                        </td>
                        <td class="r dm">${t.lifetimeNative.toFixed(6)}</td>
                      </tr>`,
                  )}
                </tbody>
              </table>
            </div>`
          : ''
      }
      <div id="refControls" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        ${claimControlsHTML(m)}
        <form id="refAttach" style="display:flex;gap:6px;align-items:center">
          <input
            class="fld"
            id="refAttachCode"
            maxlength="12"
            placeholder="ENTER A CODE"
            style="width:120px"
          /><button class="send" type="submit">APPLY</button>
        </form>
      </div>
      ${
        payouts.length
          ? html`<div class="hint" id="refPayouts">
              ${payouts.map((p) => html`<div>${payoutRowText(p, unit)}</div>`)}
            </div>`
          : ''
      }
      <p class="hint">
        15/10/5% OF REFERRED TRADERS&#8217; CURVE FEES, PAID OUT OF THE PLATFORM&#8217;S 15% LEG
        ${DOT} CLAIM AS $STONKZ REWARD CREDITS AT ONCE, OR
        ${
          onchain
            ? html`CLAIM THE ${unit} ITSELF ON CHAIN: THE API SIGNS A VOUCHER FOR YOUR LIFETIME
              TOTAL, YOUR WALLET REDEEMS IT AGAINST THE REFERRAL VAULT AND THE ${unit} LANDS IN YOUR
              WALLET IN THE SAME TRANSACTION.`
            : html`REQUEST THE ${unit} ITSELF: THE COMMISSION SITS IN THE ON-CHAIN PROTOCOL VAULT
              AND IS SENT TO YOUR WALLET BY THE TREASURY SIGNER IN A BATCH, THEN SHOWS AS PAID OUT
              HERE.`
        }
      </p>
    </div>
  </section>`;
}
