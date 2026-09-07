import type { Net } from '@stonkz/shared';
import { SignerCancelledError, signAndConfirmStep, type UiStep } from '../app/signer.js';
import { toast } from '../fx/toast.js';
import { must } from '../lib/dom.js';
import { html, render } from '../lib/html.js';
import { closeScrim, isOpen, openScrim, refreshScrim, wireBackdrop } from './scrim.js';

/**
 * The non-atomic transaction walker.
 *
 * `POST /trade/prepare` on Robinhood Chain (still, as of this phase —
 * `docs/rh-trade-atomicity-gap.md` §"Status: closed on the contract side,
 * open on the API side") returns an ordered `EvmStep[]` with `atomic: false`
 * and a `warning` explaining that stopping partway leaves the trader holding
 * an intermediate asset, not their original ETH. This modal is the one place
 * that plan requirement lives: every step is its own explicit click — never
 * an automatic loop — the warning stays pinned and visible for the whole
 * walk, and the header always says "STEP X OF N", never "confirm" as if it
 * were one action. `doLaunch`'s Robinhood dev-buy follow-up call and a
 * multi-symbol fee claim reuse it too — anything this app ever asks for more
 * than one signature in a row goes through here, atomic Solana single-step
 * flows never do.
 */

interface StepsState {
  net: Net;
  title: string;
  steps: UiStep[];
  warning: string | undefined;
  index: number;
  signing: boolean;
  resolve: (v: { signature: string }) => void;
  reject: (err: unknown) => void;
}

let st: StepsState | null = null;

function stepRow(s: UiStep, i: number, index: number): ReturnType<typeof html> {
  const mark = i < index ? '\u2713' : String(i + 1);
  return html`<li style="display:flex;gap:10px;align-items:center;padding:5px 0;opacity:${i > index ? '.55' : '1'}"
    ><b style="width:20px;text-align:center;flex:none">${mark}</b><span>${s.description}</span></li>`;
}

function renderSteps(): void {
  if (!st) return;
  const { steps, index, warning, title, signing } = st;
  const cur = steps[index] as UiStep;
  render(
    must('#txBody'),
    html`${warning
        ? html`<p class="hint" style="border:1px solid #ffa22b;border-radius:8px;padding:9px 10px;color:#ffa22b;margin-bottom:12px">${warning}</p>`
        : ''}<p class="hint" style="margin-bottom:8px">${title}</p>
      <ol style="list-style:none;margin:0 0 14px;padding:0">${steps.map((s, i) => stepRow(s, i, index))}</ol>
      <p class="hint" style="margin-bottom:10px">STEP ${index + 1} OF ${steps.length} &#183; ${cur.description}</p>
      <button type="button" class="big" id="steps-go"${signing ? ' disabled' : ''}>${
        signing ? 'CONFIRMING\u2026' : 'SIGN STEP ' + (index + 1) + ' OF ' + steps.length
      }</button>
      <button type="button" class="back" id="steps-cancel" style="width:100%;margin-top:8px">CANCEL</button>`,
  );
  refreshScrim('#txScrim');
  must('#steps-go').addEventListener('click', () => void advance());
  must('#steps-cancel').addEventListener('click', () => closeSteps());
}

async function advance(): Promise<void> {
  if (!st || st.signing) return;
  st.signing = true;
  renderSteps();
  try {
    await st.steps[st.index]?.run?.();
    if (!st) return; // `run()` cancelled the walk from under us
    const result = await signAndConfirmStep(st.net);
    if (!st) return; // cancelled mid-sign
    if (st.index >= st.steps.length - 1) {
      const resolve = st.resolve;
      settle();
      resolve(result);
      return;
    }
    st.index++;
    st.signing = false;
    renderSteps();
  } catch {
    if (!st) return;
    st.signing = false;
    renderSteps();
    toast('SIGNING FAILED \u00B7 TRY AGAIN', 'red');
  }
}

function settle(): void {
  closeScrim('#txScrim');
  st = null;
}

/** Backs out of an in-flight walk (Escape, the backdrop, or the header X). */
export function closeSteps(): void {
  if (!st) return;
  const reject = st.reject;
  settle();
  reject(new SignerCancelledError());
}

export function isStepsOpen(): boolean {
  return isOpen('#txScrim');
}

/**
 * Opens the walker and resolves once every step has been signed and
 * "confirmed", or rejects with `SignerCancelledError` if the trader backs
 * out. `title` is the one-line summary above the step list (e.g. `BUY DOGE
 * \u00B7 ROBINHOOD CHAIN`); `warning` is `plan.warning` from `/trade/prepare`,
 * shown verbatim when the caller has one.
 */
export function openSteps(
  net: Net,
  title: string,
  steps: UiStep[],
  warning: string | undefined,
  opener?: Element | null,
): Promise<{ signature: string }> {
  return new Promise((resolve, reject) => {
    st = { net, title, steps, warning, index: 0, signing: false, resolve, reject };
    openScrim('#txScrim', opener);
    renderSteps();
  });
}

export function initSteps(): void {
  wireBackdrop('#txScrim', () => closeSteps());
}
