import { $, must } from '../lib/dom.js';
import { type Html, html, render } from '../lib/html.js';
import { closeScrim, isOpen, openScrim, wireBackdrop } from './scrim.js';

/**
 * The in-app confirm dialog.
 *
 * The trade ticket used to call `window.confirm`, which renders as the
 * browser's own system dialog — out of theme and, to a wallet user, exactly
 * what a phishing page looks like. This is the same terminal window every
 * other dialog uses: amber header, mono rows, one green/red commit button.
 * The wallet's own prompt still follows; this is the review step before it.
 *
 * Resolves `true` on the commit button and `false` on cancel, the X, the
 * backdrop, Escape (via the shell's `closeAll`) or when another confirm
 * replaces it. Built on first use like `#levelScrim`.
 */
export interface ConfirmSpec {
  title: string;
  sub?: string;
  /** The headline — what is about to happen, in one line. */
  headline: string;
  /** `[label, value]` rows under the headline. */
  rows?: readonly (readonly [string, string])[];
  /** Small print under the rows. */
  note?: string;
  ok?: string;
  cancel?: string;
  /** Colours the commit button. */
  tone?: 'buy' | 'sell' | 'plain';
}

let pending: ((ok: boolean) => void) | null = null;

function settle(ok: boolean): void {
  const p = pending;
  pending = null;
  p?.(ok);
}

function ensureScrim(): HTMLElement {
  const existing = $('#confirmScrim');
  if (existing) return existing;
  const el = document.createElement('div');
  el.className = 'scrim';
  el.id = 'confirmScrim';
  render(
    el,
    html`<div class="win cfm-win" role="dialog" aria-modal="true" aria-labelledby="cfm-title">
      <div class="win-hd">
        <h2 id="cfm-title">Confirm</h2>
        <span class="sub" id="cfm-sub"></span>
        <button class="x" aria-label="Close">&#10005;</button>
      </div>
      <div class="win-bd" id="cfm-bd"></div>
    </div>`,
  );
  document.body.appendChild(el);
  wireBackdrop('#confirmScrim', () => closeConfirm(false));
  // The shell's Escape handler closes dialogs through `closeAll`, which never
  // calls back in here — watch the class so a dismissed dialog still resolves.
  new MutationObserver(() => {
    if (!el.classList.contains('open')) settle(false);
  }).observe(el, { attributes: true, attributeFilter: ['class'] });
  return el;
}

export function confirmHTML(spec: ConfirmSpec): Html {
  const tone = spec.tone ?? 'plain';
  return html`<div class="cfm-head ${tone}">${spec.headline}</div>
    ${
      spec.rows && spec.rows.length
        ? html`<div class="cfm-rows">
            ${spec.rows.map(([k, v]) => html`<div class="row"><span>${k}</span><b>${v}</b></div>`)}
          </div>`
        : ''
    }
    ${spec.note ? html`<p class="hint cfm-note">${spec.note}</p>` : ''}
    <div class="cfm-btns">
      <button type="button" class="pill" id="cfm-cancel">${spec.cancel ?? 'CANCEL'}</button>
      <button type="button" class="cfm-ok ${tone}" id="cfm-ok">${spec.ok ?? 'CONFIRM'}</button>
    </div>`;
}

export function closeConfirm(ok = false): void {
  if (isOpen('#confirmScrim')) closeScrim('#confirmScrim');
  settle(ok);
}

export function confirmDialog(spec: ConfirmSpec, opener?: Element | null): Promise<boolean> {
  // A second ask while one is up cancels the first; there is only one ticket.
  settle(false);
  const el = ensureScrim();
  must('#cfm-title', el).textContent = spec.title;
  must('#cfm-sub', el).textContent = spec.sub ?? '';
  render(must('#cfm-bd', el), confirmHTML(spec));
  $('#cfm-cancel', el)?.addEventListener('click', () => closeConfirm(false));
  $('#cfm-ok', el)?.addEventListener('click', () => closeConfirm(true));
  return new Promise<boolean>((resolve) => {
    pending = resolve;
    openScrim('#confirmScrim', opener);
    $<HTMLButtonElement>('#cfm-ok', el)?.focus();
  });
}
